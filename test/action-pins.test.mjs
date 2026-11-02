import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Class detector for C-02 (a rule applied to some copies only): the actions
 * our workflows run. Every workflow under .github/workflows is read — none is
 * named by hand — and every action in it must be:
 *  1. pinned to a full 40-hex commit SHA with its release tag in a comment
 *     ("owner/repo@<sha> # vX.Y.Z"), so a moved tag cannot change what runs;
 *  2. pinned the same way everywhere — a half-done bump runs two versions;
 *  3. at or above the first major that runs on Node 24, because GitHub's
 *     runners are retiring the Node 20 runtime for JavaScript actions.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.github', 'workflows');

// First major that runs on Node 24, from each action's release notes:
// https://github.com/actions/checkout/releases/tag/v5.0.0
// https://github.com/actions/setup-node/releases/tag/v5.0.0
// github/codeql-action: upload-sarif/action.yml says `using: node24` from v4
// (v3 is node20). ossf/scorecard-action says `using: "docker"` at v2.5.0: no
// Node runtime to retire, so its current major stands.
// A new action must be added here before a workflow may use it.
const NODE24_FROM = {
  'actions/checkout': 5,
  'actions/setup-node': 5,
  'github/codeql-action/upload-sarif': 4,
  'ossf/scorecard-action': 2,
  // v6.0.0 release notes: "Upgrade to node 24"; v7.0.0 action.yml: using: 'node24'
  'actions/setup-python': 6,
  // v7.0.0 release notes: the action runs on node24; v10.2.0 action.yml: using: "node24"
  'astral-sh/setup-uv': 7,
};

const PIN = /^(['"]?)([\w.-]+\/[\w.-]+(?:\/[\w./-]+)?)@([0-9a-f]{40})\1\s+#\s*(v(\d+)\.\d+\.\d+)$/;

/** Every `uses:` value in a workflow text, with file:line. */
function usesIn(text, file) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const m = /^\s*(?:-\s+)?uses:\s*(.*?)\s*$/.exec(line);
    if (m) out.push({ where: `${file}:${i + 1}`, value: m[1] });
  });
  return out;
}

/** Problems with the action pins in [{file, text}]; empty when every rule holds. */
function pinProblems(files) {
  const problems = [];
  const first = new Map();
  let count = 0;
  for (const { file, text } of files)
    for (const u of usesIn(text, file)) {
      count++;
      // a local action lives in this repository and is pinned by the commit itself
      if (u.value.startsWith('./')) continue;
      const m = PIN.exec(u.value);
      if (!m) {
        problems.push(`${u.where}: "${u.value}" is not owner/repo@<40-hex sha> # vX.Y.Z`);
        continue;
      }
      const [, , action, sha, tag, major] = m;
      const pin = `${sha} # ${tag}`;
      const seen = first.get(action);
      if (!seen) first.set(action, { pin, where: u.where });
      else if (seen.pin !== pin)
        problems.push(`${u.where}: ${action} is ${pin}, but ${seen.where} is ${seen.pin}`);
      const from = NODE24_FROM[action];
      if (from === undefined)
        problems.push(
          `${u.where}: ${action} is not in NODE24_FROM — say from which major it runs on Node 24`,
        );
      else if (Number(major) < from)
        problems.push(`${u.where}: ${action} ${tag} runs on Node 20; Node 24 from v${from}`);
    }
  if (count === 0)
    problems.push('no uses: lines found — the reader is broken or the workflows moved');
  return problems;
}

const workflows = readdirSync(DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ file: `.github/workflows/${f}`, text: readFileSync(join(DIR, f), 'utf8') }));

const CHECKOUT_7 = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
const CHECKOUT_4 = 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2';
const SETUP_7 = 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0';
const job = (...uses) =>
  `jobs:\n  a:\n    steps:\n${uses.map((u) => `      - uses: ${u}\n`).join('')}`;
const one = (text) => pinProblems([{ file: 'planted.yml', text }]);

describe('C-02: every action is pinned once, by commit SHA, on a Node 24 major', () => {
  test('every action in .github/workflows is pinned to a full SHA with its tag, one pin per action, at a Node 24 major', () => {
    assert.ok(workflows.length > 0, 'no workflow files read');
    assert.deepEqual(pinProblems(workflows), []);
  });

  test('the reader sees every uses: line in every workflow file (control)', () => {
    for (const { file, text } of workflows) {
      const raw = (text.match(/\buses:/g) ?? []).length;
      assert.equal(usesIn(text, file).length, raw, `${file}: a uses: line was not read`);
    }
    // and it is not vacuous: the real files hold actions to check
    assert.ok(workflows.flatMap((w) => usesIn(w.text, w.file)).length > 0);
  });

  test('a clean planted workflow passes, so the refusals below come from the planted fault (control)', () => {
    assert.deepEqual(one(job(CHECKOUT_7, SETUP_7, './.github/actions/local')), []);
  });

  test('a tag-only pin is refused', () => {
    const p = one(job('actions/checkout@v7'));
    assert.equal(p.length, 1, p.join('\n'));
    assert.match(p[0], /is not owner\/repo@<40-hex sha> # vX\.Y\.Z/);
  });

  test('a SHA without its release tag comment, or a short SHA, is refused', () => {
    assert.match(
      one(job('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'))[0],
      /is not owner/,
    );
    assert.match(one(job('actions/checkout@3d3c42e # v7.0.1'))[0], /is not owner/);
  });

  test('a half-done bump — two pins of one action — is refused', () => {
    const p = pinProblems([
      { file: 'a.yml', text: job(CHECKOUT_7) },
      { file: 'b.yml', text: job(CHECKOUT_4.replace('# v4.2.2', '# v5.0.0')) },
    ]);
    assert.equal(p.length, 1, p.join('\n'));
    assert.match(p[0], /^b\.yml:4: actions\/checkout is .* but a\.yml:4 is /);
  });

  test('an action still on its Node 20 major is refused', () => {
    const p = one(job(CHECKOUT_4));
    assert.equal(p.length, 1, p.join('\n'));
    assert.match(p[0], /actions\/checkout v4\.2\.2 runs on Node 20; Node 24 from v5/);
  });

  test('an action missing from the Node 24 table is refused', () => {
    const p = one(job(`example-org/new-action@${'a'.repeat(40)} # v1.0.0`));
    assert.equal(p.length, 1, p.join('\n'));
    assert.match(p[0], /example-org\/new-action is not in NODE24_FROM/);
  });

  test('a workflow set with no uses: lines refuses instead of passing', () => {
    assert.deepEqual(one('on: push\njobs: {}\n'), [
      'no uses: lines found — the reader is broken or the workflows moved',
    ]);
  });
});
