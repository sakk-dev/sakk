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
  [/^\s*exit 0\b/m, 'a step that exits 0 early reads as passed although its work did not run'],
  [/\|\|\s*(true|:)\s*($|[;)}])/m, '`|| true` turns a failure into success'],
  // `|| { echo …; exit 1; }` reports and still fails: only an echo that ends the failure counts
  [/\|\|\s*\{?\s*echo\b(?![^\n]*exit [1-9])[^\n]*$/m, '`|| echo` turns a failure into success'],
  [/^\s*continue-on-error:\s*true/m, 'continue-on-error turns a failure into success'],
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
    ])
      assert.notDeepEqual(problems(bad), [], bad);
    for (const good of [
      "run: npm test\nif: needs.key.outputs.present == 'yes'",
      'curl https://x > out || { echo "::error::the call failed"; exit 1; }',
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
