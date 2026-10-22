import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Class detector for C-01 in CI (F-142): a check that did not run must not
 * read as passed. A workflow never ends a step with `exit 0` on a path where
 * the work was skipped, never turns a failure into success with `|| true` or
 * `|| echo`, and never marks a step `continue-on-error`. Work that needs a
 * secret is gated at the job, so a missing secret shows as skipped.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.github', 'workflows');

const SHAPES = [
  // exit 0 at a statement start, after a separator, or behind `|| ` — all read as pass
  [
    /(^|\|\||[;&]|\bthen\b|\bdo\b)\s*exit\s+0\b/m,
    'a step that exits 0 reads as passed although its work did not run',
  ],
  [
    /(^|\|\||[;&])\s*exit\s*(#.*)?$/m,
    'a bare exit takes the last status, which may be 0 after an echo',
  ],
  // `|| true` / `:` / an absolute true, and the block forms `|| { true; }` / `|| { : ; }`
  [/\|\|\s*(true|:|\/\w[\w/]*\/true)\b/m, '`|| true` turns a failure into success'],
  [/\|\|\s*\{\s*(true|:)\s*;?\s*\}/m, '`|| { true; }` swallows a failure'],
  // `|| echo`/`printf …`: allowed only when it ENDS the failure (`; exit [1-9]`); a message
  // that merely mentions "exit 1" does not count (the old lookahead was fooled by it)
  [
    /\|\|\s*\{?\s*(echo|printf)\b(?![^\n]*[;&]\s*exit\s+[1-9])[^\n]*$/m,
    '`|| echo` turns a failure into success',
  ],
  [
    /^\s*continue-on-error:\s*(true|'true'|"true"|\$\{\{)/m,
    'continue-on-error turns a failure into success',
  ],
  [/^\s*set\s+\+e\b/m, '`set +e` lets later failures pass unnoticed'],
  [
    /\btrap\b[^\n]*exit\s+0[^\n]*\bEXIT\b|\btrap\b[^\n]*\bEXIT\b[^\n]*exit\s+0/m,
    'a trap exiting 0 on EXIT masks a failure',
  ],
];
const problems = (text) => SHAPES.filter(([re]) => re.test(text)).map(([, why]) => why);

describe('C-01: a CI check that did not run never reads as passed (F-142)', () => {
  test('no workflow turns a skip or a failure into a green check', () => {
    const found = readdirSync(DIR)
      .filter((f) => /\.ya?ml$/.test(f))
      .flatMap((f) => problems(readFileSync(join(DIR, f), 'utf8')).map((why) => `${f}: ${why}`));
    assert.deepEqual(found, []);
  });
  test('control: the shapes that once showed a skipped review as passed are caught', () => {
    for (const bad of [
      'if [ -z "$KEY" ]; then\n  echo "skipped"\n  exit 0\nfi',
      'curl https://x > out || { echo "::warning::call failed"; exit 0; }',
      'gh pr comment 1 --body-file c.md || echo "::warning::could not post"',
      'npm audit || true',
      '    continue-on-error: true',
      // shapes the first detector missed (F-157)
      '[ -n "$KEY" ] || exit 0',
      'then echo skipped; exit 0; fi',
      '          echo done\n          exit',
      'npm audit || true # comment',
      'npm audit || { true; }',
      'npm audit || /bin/true',
      'npm audit || printf "failed\\n"',
      'curl x || echo "this is not an exit 1 case"',
      "    continue-on-error: 'true'",
      '    continue-on-error: ${{ always() }}',
      'set +e',
      'trap "exit 0" EXIT',
    ])
      assert.notDeepEqual(problems(bad), [], bad);
    for (const good of [
      "run: npm test\nif: needs.key.outputs.present == 'yes'",
      'curl https://x > out || { echo "::error::the call failed"; exit 1; }',
      'npm audit || { echo "::error::audit failed"; exit 1; }',
      'echo "max reservable exit 1 is only text"',
    ])
      assert.deepEqual(problems(good), [], good);
  });
  test('the review that needs a key is gated at the job, so a missing key shows as skipped', () => {
    const review = readFileSync(join(DIR, 'pr-review.yml'), 'utf8');
    assert.match(
      review,
      /\n {2}adversarial-review:\n {4}needs: review-key\n {4}if: needs\.review-key\.outputs\.present == 'yes'\n/,
    );
  });
});
