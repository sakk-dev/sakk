import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The self-evolution gates as a user meets them: the checker run as a command,
 * in a throwaway repository, judged only by exit codes and messages. This file
 * imports nothing from the repository, so it loads on the code before any fix
 * and its assertions — not a missing import — decide whether that code had the
 * bug (findings-proof, R7: a guard must fail before its fix and pass after).
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const ANSWER = 'Absent input refuses with a named code and the test deletes it to prove so.';
const NONE = 'none: this throwaway repository has no test suite to point at';
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

function repo({ ledger = LEDGER, classes = CLASSES } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'selfevo-cli-'));
  const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore', env: ENV });
  for (const sub of ['scripts', 'findings', 'src']) mkdirSync(join(d, sub), { recursive: true });
  for (const f of ['findings-check.mjs', 'findings-lib.mjs'])
    copyFileSync(join(REPO, 'scripts', f), join(d, 'scripts', f));
  writeFileSync(join(d, 'findings', 'ledger.json'), JSON.stringify(ledger));
  writeFileSync(join(d, 'findings', 'classes.json'), JSON.stringify(classes));
  writeFileSync(join(d, 'src', 'x.mjs'), 'export const x = 1;\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  git('checkout', '-qb', 'feat/y');
  return { d, git };
}
const commit = (git, msg) =>
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-verify', '-m', msg);
const check = (d, args, input, cwd = d) =>
  spawnSync(process.execPath, [join(d, 'scripts', 'findings-check.mjs'), ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: ENV,
  });
const bash = (d, command, cwd = d) =>
  check(d, ['--edit'], JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }), cwd);
const edit = (d, file = 'src/x.mjs') =>
  check(
    d,
    ['--edit'],
    JSON.stringify({ tool_name: 'Edit', cwd: d, tool_input: { file_path: file } }),
  );
const answers = (extra = {}) => ({
  'C-01.1': { answer: ANSWER, guard: NONE, ...extra },
  'C-02.1': { answer: `${ANSWER} Every field, not one.`, guard: NONE },
});
const ack = (d, a = answers(), name = 'feat-y', branch = 'feat/y') => {
  mkdirSync(join(d, 'findings', 'acks'), { recursive: true });
  writeFileSync(
    join(d, 'findings', 'acks', `${name}.json`),
    JSON.stringify({ version: 2, branch, answers: a }),
  );
};

describe('the gates as a user meets them (findings-proof guards)', () => {
  test('F-120: a shell write to a tracked file is refused until the branch answers', () => {
    const { d } = repo();
    assert.equal(bash(d, 'echo 2 > src/x.mjs').status, 2);
    ack(d);
    assert.equal(bash(d, 'echo 2 > src/x.mjs').status, 0);
  });
  test('F-129: a committed answer cannot be rewritten at commit time', () => {
    const { d, git } = repo();
    ack(d);
    git('add', '-A');
    commit(git, 'docs: answers');
    ack(d, answers({ answer: `${ANSWER} Rewritten after the review to match the fix.` }));
    git('add', '-A');
    const r = check(d, ['--staged']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /rewritten/);
  });
  test('F-130: an answer that names no guard is not an answer', () => {
    const { d } = repo();
    const a = answers();
    delete a['C-01.1'].guard;
    ack(d, a);
    const r = edit(d);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no guard/);
  });
  test('F-131: a class whose last two escapes upgraded nothing stops the change', () => {
    const esc = (id) => ({
      id,
      class: 'C-01',
      areas: ['src/x.mjs'],
      title: id,
      mechanism_gap: 'g',
      mechanism_upgrade: 'none: instance only',
    });
    const { d } = repo({ ledger: { findings: [...LEDGER.findings, esc('F-03'), esc('F-04')] } });
    ack(d);
    const r = edit(d);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /C-01 is stopped/);
  });
  test('F-132: a shell write routed from a parent folder still meets the gate', () => {
    const { d } = repo();
    assert.equal(bash(d, `cd "${d}" && echo 2 > src/x.mjs`, dirname(d)).status, 2);
  });
  test('F-133: git commands that rewrite tracked files are writes', () => {
    const { d } = repo();
    for (const c of [
      'git checkout -- src/x.mjs',
      'git restore src/x.mjs',
      'git stash pop',
      'git reset --hard HEAD',
      'git clean -fdx',
    ])
      assert.equal(bash(d, c).status, 2, c);
    assert.equal(bash(d, 'git status').status, 0);
  });
  test('F-134: renaming the branch does not unfreeze committed answers', () => {
    const { d, git } = repo();
    ack(d);
    writeFileSync(join(d, 'src', 'x.mjs'), 'export const x = 7;\n');
    git('add', '-A');
    commit(git, 'feat: x with answers');
    git('branch', '-m', 'feat/y', 'feat/y2');
    ack(
      d,
      answers({ answer: `${ANSWER} A different promise under the new name.` }),
      'feat-y2',
      'feat/y2',
    );
    git('add', '-A');
    commit(git, 'docs: answers under the new name');
    const r = check(d, ['--range', 'main']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /carry its answers forward/);
  });
  test('F-135: a later escape with a prose upgrade does not release a stopped class', () => {
    const esc = (id, up) => ({
      id,
      class: 'C-01',
      areas: ['src/x.mjs'],
      title: id,
      mechanism_gap: 'g',
      mechanism_upgrade: up,
    });
    const { d } = repo({
      ledger: {
        findings: [
          ...LEDGER.findings,
          esc('F-03', 'none: instance'),
          esc('F-04', 'none: instance'),
          esc('F-05', 'x'),
        ],
      },
    });
    ack(d);
    assert.equal(edit(d).status, 2);
  });
  test('F-136: a guard must be a test, not a document', () => {
    const { d, git } = repo();
    ack(d, answers({ guard: 'docs/notes.md::answer' }));
    writeFileSync(join(d, 'src', 'x.mjs'), 'export const x = 3;\n');
    git('add', '-A');
    const r = check(d, ['--staged']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must point at a test file/);
  });
  test('F-137: a prevention question cannot be loosened in the change it judges', () => {
    const { d, git } = repo();
    ack(d);
    const loosened = JSON.parse(JSON.stringify(CLASSES));
    loosened.classes[0].questions[0].ask = 'Anything absent?';
    writeFileSync(join(d, 'findings', 'classes.json'), JSON.stringify(loosened));
    git('add', '-A');
    const r = check(d, ['--staged']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /reworded/);
  });
  test("F-138: CI runs the base branch's checker over every pull request", () => {
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ci, /git show "origin\/\$base:\$f"/);
    assert.match(ci, /base-checker\/scripts\/findings-check\.mjs" --range "origin\/\$base"/);
  });
  test('control: the throwaway repository is real and the checker in it runs', () => {
    const { d } = repo();
    assert.ok(existsSync(join(d, '.git')));
    assert.equal(edit(d, 'findings/ledger.json').status, 0, 'logging a problem is never blocked');
  });
});

describe('R7: a fix is proven red before and green after', () => {
  /** A repository whose base has a bug, and a branch that fixes it and logs the finding. */
  function fixed({ guardFile, guardBody, introduced = 'unknown' }) {
    const { d, git } = repo();
    copyFileSync(
      join(REPO, 'scripts', 'findings-proof.mjs'),
      join(d, 'scripts', 'findings-proof.mjs'),
    );
    writeFileSync(join(d, 'src', 'add.mjs'), 'export const add = (a, b) => a - b;\n');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'the bug');
    git('branch', '-f', 'base');
    writeFileSync(
      join(d, 'src', 'add.mjs'),
      'export const add = (a, b) => a + b;\nexport const twice = (a) => add(a, a);\n',
    );
    mkdirSync(join(d, 'test'), { recursive: true });
    writeFileSync(join(d, 'test', guardFile), guardBody);
    const ledger = JSON.parse(readFileSync(join(d, 'findings', 'ledger.json'), 'utf8'));
    ledger.findings.push({
      id: 'F-03',
      class: 'C-01',
      areas: ['src/add.mjs'],
      title: 'add subtracts',
      status: 'fixed',
      introduced_in: introduced,
      guard: `test/${guardFile}::adds two numbers`,
    });
    writeFileSync(join(d, 'findings', 'ledger.json'), JSON.stringify(ledger));
    git('add', '-A');
    commit(git, 'fix: add adds (F-03)');
    return spawnSync(
      process.execPath,
      [join(d, 'scripts', 'findings-proof.mjs'), '--range', 'base'],
      { cwd: d, encoding: 'utf8', env: ENV },
    );
  }
  const T = (body) =>
    `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${body}\n`;
  test('F-139: a guard that fails on the old code by its own assertion proves the fix', () => {
    const r = fixed({
      guardFile: 'add.test.mjs',
      guardBody: T(
        "import { add } from '../src/add.mjs';\ntest('adds two numbers', () => assert.equal(add(2, 3), 5));",
      ),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /F-03: the guard runs and fails before the fix/);
  });
  test('F-139: a guard that already passes before the fix is refused', () => {
    const r = fixed({
      guardFile: 'add.test.mjs',
      guardBody: T("test('adds two numbers', () => assert.equal(1 + 1, 2));"),
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already passes on base, before the fix/);
  });
  test('F-139: for an old bug, a guard that cannot load on the old code is refused', () => {
    const r = fixed({
      guardFile: 'add.test.mjs',
      guardBody: T(
        "import { twice } from '../src/add.mjs';\ntest('adds two numbers', () => assert.equal(twice(2), 4));",
      ),
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot even load on base/);
  });
});

describe('skipping the hooks is refused, and disputing the gate is the way out', () => {
  test('F-140: commands that turn the git hooks off are refused even with every answer given', () => {
    const { d } = repo();
    ack(d);
    for (const c of [
      'git commit --no-verify -m x',
      'git commit -nm x',
      'git push --no-verify',
      'git -c core.hooksPath=/dev/null commit -m x',
      'git config core.hooksPath /dev/null',
      'bash -lc "git commit --no-verify -m x"',
      "sh -c 'git commit -n -m x'",
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
      'HUSKY=0 git commit -m x',
      'git merge -n feat',
      'git commit-tree HEAD^{tree} -m x',
      'git update-ref refs/heads/main HEAD',
    ]) {
      const r = bash(d, c);
      assert.equal(r.status, 2, c);
      assert.match(r.stderr, /refused/, c);
    }
    assert.equal(bash(d, 'git commit -m "-n is only text here"').status, 0);
    assert.equal(bash(d, 'git config --get core.hooksPath').status, 0);
    assert.equal(bash(d, 'git push -n origin feat/y').status, 0, 'push -n is a dry run');
  });
  test('F-140: every refusal names the dispute path instead of a way around', () => {
    const { d } = repo();
    const r = edit(d);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--source dispute/);
  });
});
