import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { messageProblem, missingAnswers, required } from '../scripts/findings-lib.mjs';

/**
 * The enforcement points of the self-evolution loop (docs/SELF_EVOLUTION.md):
 * each refuses its violation and lets the compliant case through. Every
 * test runs the real checker in a throwaway repository.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const LEDGER = {
  findings: [
    {
      id: 'F-01',
      class: 'C-01',
      areas: ['src/x.mjs'],
      title: 'a known problem in x',
      status: 'fixed',
    },
    { id: 'F-02', class: 'C-02', areas: ['docs/'], title: 'a known docs problem', status: 'fixed' },
  ],
};
const CLASSES = {
  classes: [
    {
      id: 'C-01',
      questions: [{ id: 'C-01.1', ask: 'What happens when the input is absent here?' }],
    },
    {
      id: 'C-02',
      questions: [{ id: 'C-02.1', ask: 'Does a list stand in for all of them here?' }],
    },
  ],
};
const ANSWER = 'Absent input refuses with a named code and the test deletes it to prove so.';

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'selfevo-'));
  const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  mkdirSync(join(d, 'scripts'), { recursive: true });
  mkdirSync(join(d, 'findings'), { recursive: true });
  mkdirSync(join(d, 'src'), { recursive: true });
  for (const f of ['findings-check.mjs', 'findings-lib.mjs'])
    copyFileSync(join(REPO, 'scripts', f), join(d, 'scripts', f));
  writeFileSync(join(d, 'findings', 'ledger.json'), JSON.stringify(LEDGER));
  writeFileSync(join(d, 'findings', 'classes.json'), JSON.stringify(CLASSES));
  writeFileSync(join(d, 'src', 'x.mjs'), 'export const x = 1;\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  git('checkout', '-qb', 'feat/y');
  return { d, git };
}
const check = (d, args, input) =>
  spawnSync(process.execPath, [join(d, 'scripts', 'findings-check.mjs'), ...args], {
    cwd: d,
    input,
    encoding: 'utf8',
  });
const ack = (d, answers) =>
  writeFileSync(
    join(d, 'findings', 'acks', 'feat-y.json'),
    JSON.stringify({ branch: 'feat/y', answers }),
  );

describe('before an edit: the Claude Code hook', () => {
  const edit = (d, file) =>
    check(d, ['--edit'], JSON.stringify({ cwd: d, tool_input: { file_path: file } }));
  test('an edit of a file the ledger knows is blocked (exit 2) until the branch answers its questions', () => {
    const { d } = repo();
    const r = edit(d, 'src/x.mjs');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /C-01\.1/);
    assert.match(r.stderr, /learned from F-01/);
    mkdirSync(join(d, 'findings', 'acks'), { recursive: true });
    ack(d, {
      'C-01.1': { answer: ANSWER },
      'C-02.1': { answer: `${ANSWER} Every field, not one.` },
    });
    assert.equal(edit(d, 'src/x.mjs').status, 0);
  });
  test('logging a problem is never blocked, and files outside a ledger repository pass', () => {
    const { d } = repo();
    assert.equal(edit(d, 'findings/ledger.json').status, 0);
    assert.equal(edit(d, join(tmpdir(), 'elsewhere.txt')).status, 0);
  });
  test('placeholders, short answers and one sentence copied everywhere do not count', () => {
    const req = required(LEDGER, CLASSES, ['src/x.mjs']);
    const why = (answers) => missingAnswers({ answers }, req).map((m) => m.why);
    assert.deepEqual(why({ 'C-01.1': { answer: 'ok' }, 'C-02.1': { answer: ANSWER } }), [
      'shorter than 40 characters',
    ]);
    assert.match(
      why({ 'C-01.1': { answer: `TODO ${ANSWER}` }, 'C-02.1': { answer: ANSWER + '!' } })[0],
      /placeholder/,
    );
    assert.deepEqual(
      why({ 'C-01.1': { answer: ANSWER }, 'C-02.1': { answer: ANSWER } }).map((w) =>
        w.startsWith('the same text'),
      ),
      [true, true],
    );
  });
});

describe('before a commit: the git hooks', () => {
  test('a staged change is refused until the answers are staged with it', () => {
    const { d, git } = repo();
    writeFileSync(join(d, 'src', 'x.mjs'), 'export const x = 2;\n');
    git('add', 'src/x.mjs');
    assert.equal(check(d, ['--staged']).status, 1, 'no answers staged');
    mkdirSync(join(d, 'findings', 'acks'), { recursive: true });
    ack(d, {
      'C-01.1': { answer: ANSWER },
      'C-02.1': { answer: `${ANSWER} Every field, not one.` },
    });
    assert.equal(check(d, ['--staged']).status, 1, 'answers written but not staged');
    git('add', 'findings/acks/feat-y.json');
    assert.equal(check(d, ['--staged']).status, 0);
  });
  test('an untriaged inbox item refuses the commit', () => {
    const { d, git } = repo();
    mkdirSync(join(d, 'findings', 'inbox'), { recursive: true });
    writeFileSync(join(d, 'findings', 'inbox', 'i1.json'), '{"text":"seen"}');
    git('add', 'findings/ledger.json');
    const r = check(d, ['--staged']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /untriaged/);
  });
  test('a fix commit names its finding, or says why there is none', () => {
    assert.equal(messageProblem('feat: add y', LEDGER), null);
    assert.match(messageProblem('fix: handle y', LEDGER), /must name the finding/);
    assert.match(messageProblem('fix: handle y (F-77)', LEDGER), /not in the ledger: F-77/);
    assert.equal(messageProblem('fix(x): handle y (F-01)', LEDGER), null);
    assert.equal(
      messageProblem('fix: typo\n\nNo-finding: a comment typo, no behaviour changed', LEDGER),
      null,
    );
    assert.match(messageProblem('fix: typo\n\nNo-finding: typo', LEDGER), /must name the finding/);
  });
});

describe('in CI: the whole branch, so --no-verify does not get past', () => {
  test('a fix commit made with --no-verify and without answers fails the range check', () => {
    const { d, git } = repo();
    writeFileSync(join(d, 'src', 'x.mjs'), 'export const x = 3;\n');
    git('add', '-A');
    git(
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--no-verify',
      '-m',
      'fix: quietly',
    );
    const r = check(d, ['--range', 'main']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /C-01\.1/);
    assert.match(r.stderr, /must name the finding/);
    mkdirSync(join(d, 'findings', 'acks'), { recursive: true });
    ack(d, {
      'C-01.1': { answer: ANSWER },
      'C-02.1': { answer: `${ANSWER} Every field, not one.` },
    });
    git('add', '-A');
    git(
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--no-verify',
      '-m',
      'docs: answers',
    );
    // the message rule still holds for the earlier commit: fix it, then it passes
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'reset', '-q', '--soft', 'main');
    git(
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--no-verify',
      '-m',
      'fix: handle x (F-01)',
    );
    assert.equal(check(d, ['--range', 'main']).status, 0);
  });
  test('F-128: the range check runs on pull requests against their own base, with no default', () => {
    // A push has no base_ref. Defaulting to main charged a stacked branch with
    // every file its unmerged parents changed, while its pull request passed.
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    const start = ci.indexOf('\n  self-evolution:\n');
    assert.ok(start > 0, 'self-evolution job not found');
    const job = ci.slice(start + 1).split(/\n {2}[a-z][\w-]*:\n/)[0];
    assert.match(job, /\n {4}if: github\.event_name == 'pull_request'\n/);
    assert.match(job, /BASE_REF: \$\{\{ github\.base_ref \}\}/);
    assert.doesNotMatch(
      job,
      /BASE_REF:-/,
      "a default base charges a branch with its parents' files",
    );
    assert.match(job, /\$\{BASE_REF:\?/, 'an empty base must fail, not fall back');
  });
});
