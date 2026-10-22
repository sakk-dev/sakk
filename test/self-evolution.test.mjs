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
import {
  classifyShell,
  dataRegressions,
  FROZEN,
  messageProblem,
  missingAnswers,
  required,
  stoplineGap,
  stoppedClasses,
} from '../scripts/findings-lib.mjs';

/**
 * The enforcement points of the self-evolution loop (docs/SELF_EVOLUTION.md):
 * each refuses its violation and lets the compliant case through. Every
 * test runs the real checker in a throwaway repository.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
/** The gate's own files, listed once (F-144); the fallback only lets this file load on an older base. */
const MANIFEST = join(REPO, 'scripts', 'gate-files.json');
const GATE_FILES = existsSync(MANIFEST)
  ? JSON.parse(readFileSync(MANIFEST, 'utf8')).files
  : ['scripts/findings-check.mjs', 'scripts/findings-lib.mjs'];

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

// a git hook exports GIT_INDEX_FILE and friends; a child git in a throwaway repo must not see them
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

function repo({ ledger = LEDGER, classes = CLASSES } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'selfevo-'));
  const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore', env: ENV });
  mkdirSync(join(d, 'scripts'), { recursive: true });
  mkdirSync(join(d, 'findings'), { recursive: true });
  mkdirSync(join(d, 'src'), { recursive: true });
  for (const f of GATE_FILES) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    copyFileSync(join(REPO, f), join(d, f));
  }
  writeFileSync(join(d, 'findings', 'ledger.json'), JSON.stringify(ledger));
  writeFileSync(join(d, 'findings', 'classes.json'), JSON.stringify(classes));
  writeFileSync(join(d, 'src', 'x.mjs'), 'export const x = 1;\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  git('checkout', '-qb', 'feat/y');
  return { d, git };
}
const check = (d, args, input, cwd = d) =>
  spawnSync(process.execPath, [join(d, 'scripts', 'findings-check.mjs'), ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: ENV,
    // a hung checker fails the test in a minute instead of the run in twenty (seen on macOS
    // with a 64 KB stdin under a loaded parallel run)
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
const NONE = 'none: this throwaway repository has no test suite to point at';
/** A version-2 answers file: every answer names its guard (R3). */
const ack = (d, answers, extra = {}) => {
  mkdirSync(join(d, 'findings', 'acks'), { recursive: true });
  const v2 = Object.fromEntries(
    Object.entries(answers).map(([q, a]) => [q, { guard: NONE, ...a }]),
  );
  writeFileSync(
    join(d, 'findings', 'acks', 'feat-y.json'),
    JSON.stringify({ version: 2, branch: 'feat/y', answers: v2, ...extra }),
  );
};
const ANSWERS = () => ({
  'C-01.1': { answer: ANSWER },
  'C-02.1': { answer: `${ANSWER} Every field, not one.` },
});
const commit = (git, msg) =>
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-verify', '-m', msg);
const bash = (d, command, cwd = d) =>
  check(d, ['--edit'], JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }), cwd);

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

/*
 * Closing the bypasses (specs/self-evolution/spec.md). Measured on 2026-10-21
 * in a second project running this loop: the edit hook never loaded (sessions
 * started in a parent folder), most writes went through the shell, answers
 * were rewritten after review, and every recurrence fell in a class whose
 * question had been answered.
 */

describe('R1: a shell command that may write meets the same gate', () => {
  test('a shell command that may write is refused until the branch answers for what it changed', () => {
    const { d } = repo();
    // a write that already landed through the shell, unseen by any hook
    writeFileSync(join(d, 'src', 'x.mjs'), 'export const x = 2;\n');
    const r = bash(d, "sed -i '' s/2/3/ src/x.mjs");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /this shell command may write \(sed -i\)/);
    assert.match(r.stderr, /C-01\.1/);
    assert.match(r.stderr, /src\/x\.mjs/);
    // writing to a file nobody changed yet is refused by its own questions
    const { d: d2 } = repo();
    assert.equal(bash(d2, 'cp /dev/null src/x.mjs').status, 2, 'cp onto a tracked file');
    assert.equal(bash(d2, 'echo hi > src/y.txt').status, 2, 'a redirect into the repo');
    assert.equal(bash(d2, 'echo hi > /dev/null').status, 0, 'no write at all');
    assert.equal(bash(d2, 'git status && grep -n x src/x.mjs').status, 0, 'reads pass');
    ack(d, ANSWERS());
    assert.equal(bash(d, "sed -i '' s/2/3/ src/x.mjs").status, 0);
  });
  test('an opaque writer must answer the watch list', () => {
    const { d } = repo();
    for (const c of [
      "node -e \"require('fs').writeFileSync('a', 'b')\"",
      "python3 - <<'EOF'\nopen('src/x.mjs', 'w').write('')\nEOF",
      'echo $(touch src/z.mjs)',
      'find . -name "*.mjs" -exec sed -i "" s/a/b/ {} \\;',
    ]) {
      const r = bash(d, c);
      assert.equal(r.status, 2, c);
      assert.match(r.stderr, /C-01\.1[\s\S]*C-02\.1/, `${c}: the watch list`);
    }
    ack(d, ANSWERS());
    assert.equal(bash(d, 'node -e "1"').status, 0);
  });
  test('the shell classifier: every read-only form passes and every writing form is caught', () => {
    const kind = (c) => classifyShell(c, '/r').kind;
    const read = [
      'git status',
      'git -C sub log --oneline -5',
      'git diff HEAD~1 -- src | head -50',
      'npm test 2>&1 | tail -20',
      'npm run lint',
      'npm run brief -- src/x.mjs',
      'node --test test/a.test.mjs',
      'node scripts/findings-brief.mjs src',
      'grep -rn "a > b" src',
      "sed -n '1,40p' src/x.mjs",
      'find . -name "*.mjs" -newer x',
      'echo done >/dev/null 2>&1',
      'cd src && ls -la && wc -l x.mjs',
      'FOO=1 npm run gate',
      'git checkout -b feat/z',
      'git switch feat/z',
      'git stash list',
      'git reset HEAD~1',
      'git config --get user.name',
      'git pull --rebase',
      'npm ci',
      'gh pr view 15 --json state',
      'cat a | sort | uniq -c # > not a redirect',
      "awk '{print $1}' f",
    ];
    const writes = {
      'echo x > src/a': 'write',
      'echo x >> src/a': 'write',
      'cmd 2>err.log': 'opaque',
      'tee src/a < b': 'write',
      'sed -i.bak s/a/b/ f': 'write',
      'sed --in-place s/a/b/ f': 'write',
      "sed -n 'w out' f": 'opaque',
      'cp a b': 'write',
      'mv a b': 'write',
      'rm -rf build': 'write',
      'mkdir -p d && touch d/f': 'write',
      'git apply p.diff': 'opaque',
      'git rm src/a': 'write',
      'npm install': 'write',
      'git checkout -- src/x.mjs': 'write',
      'git checkout main -- src/x.mjs': 'write',
      'git restore src/x.mjs': 'write',
      'git stash pop': 'opaque',
      'git stash': 'opaque',
      'git reset --hard HEAD~1': 'opaque',
      'git clean -fdx': 'opaque',
      'git cherry-pick abc123': 'opaque',
      'git config core.hooksPath /dev/null': 'opaque',
      'npx prettier --write .': 'opaque',
      'node bin/sakk.mjs ledger init': 'opaque',
      'python3 x.py': 'opaque',
      'uv run python x.py': 'opaque',
      'sh -c "echo a > b"': 'opaque',
      'eval "$X"': 'opaque',
      'cat <<EOF\nhi\nEOF': 'opaque',
      'git status && sed -i s/a/b/ f': 'write',
      'awk \'{print > "o"}\' f': 'opaque',
      'curl -o x https://e.x': 'opaque',
      'xargs rm < list': 'opaque',
      'some-unknown-tool --flag': 'opaque',
      'echo "unterminated': 'opaque',
      // F-157: node --test runs code when it injects a module, so it is not read-only
      'node --test --import \'data:text/javascript,import("fs")\' x': 'opaque',
      'node --test --require ./p.js x': 'opaque',
      'node --test -r ./p.js x': 'opaque',
      'node --test -e "process.exit(0)"': 'opaque',
    };
    for (const c of read) assert.equal(kind(c), 'read', c);
    for (const [c, k] of Object.entries(writes)) assert.equal(kind(c), k, c);
    // targets are resolved against cd and are exact
    assert.deepEqual(classifyShell('cd src && cp a "b c"', '/r').targets, ['/r/src/b c']);
    assert.deepEqual(classifyShell("sed -i '' -e s/a/b/ f g", '/r').targets, ['/r/f', '/r/g']);
    assert.deepEqual(classifyShell('cat > f <<EOF\nx > y\nEOF', '/r').targets, ['/r/f']);
  });
  test('a command longer than the bound is refused as unclassifiable, not parsed', () => {
    const long = `echo ${'a'.repeat(64 * 1024)}`;
    assert.equal(classifyShell(long, '/r').kind, 'unclassifiable');
    const { d } = repo();
    const r = bash(d, long);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot be classified/);
  });
  test('the hook works when the session started in a parent folder', () => {
    const { d } = repo();
    const parent = dirname(d);
    const r = bash(d, `cd "${d}" && echo 2 > src/x.mjs`, parent);
    assert.equal(r.status, 2, 'routed from the parent folder, the repository is still found');
    assert.match(r.stderr, /src\/x\.mjs/);
    const e = check(
      d,
      ['--edit'],
      JSON.stringify({
        tool_name: 'Edit',
        cwd: parent,
        tool_input: { file_path: join(d, 'src', 'x.mjs') },
      }),
      parent,
    );
    assert.equal(e.status, 2);
    ack(d, ANSWERS());
    assert.equal(bash(d, `cd "${d}" && echo 2 > src/x.mjs`, parent).status, 0);
  });
});

describe('R2–R3: answers are frozen once committed, and each names its check', () => {
  test('an answer, once committed, is never rewritten: corrections are revisions naming a finding', () => {
    const { d, git } = repo();
    ack(d, ANSWERS());
    git('add', '-A');
    commit(git, 'docs: answers');
    const rewritten = ANSWERS();
    rewritten['C-01.1'].answer = `${ANSWER} Rewritten after the review to match the fix.`;
    ack(d, rewritten);
    git('add', '-A');
    let r = check(d, ['--staged']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /C-01\.1: a committed answer was rewritten/);
    // the correction goes into revisions, naming a finding
    const revised = ANSWERS();
    revised['C-01.1'].revisions = [
      { finding: 'F-01', answer: `${ANSWER} What is true now.`, guard: NONE },
    ];
    ack(d, revised);
    git('add', '-A');
    assert.equal(check(d, ['--staged']).status, 0);
    revised['C-01.1'].revisions[0].finding = 'F-99';
    ack(d, revised);
    git('add', '-A');
    assert.match(check(d, ['--staged']).stderr, /must name a finding in the ledger/);
    // removing an answer is refused too
    const fewer = ANSWERS();
    delete fewer['C-02.1'];
    ack(d, fewer);
    git('add', '-A');
    assert.match(check(d, ['--staged']).stderr, /C-02\.1: a committed answer was removed/);
    // in CI a rewrite in a middle commit is seen even if a later commit restores it
    ack(d, rewritten);
    git('add', '-A');
    commit(git, 'docs: rewrite');
    ack(d, ANSWERS());
    git('add', '-A');
    commit(git, 'docs: restore');
    r = check(d, ['--range', 'main']);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /commit [0-9a-f]{7}: findings\/acks\/feat-y\.json: C-01\.1: a committed answer was rewritten/,
    );
  });
  test('renaming the branch does not unfreeze its answers (review I2)', () => {
    const { d, git } = repo();
    ack(d, ANSWERS());
    writeFileSync(join(d, 'src', 'x.mjs'), 'export const x = 7;\n');
    git('add', '-A');
    commit(git, 'feat: x with answers');
    git('branch', '-m', 'feat/y', 'feat/y2');
    const fresh = ANSWERS();
    fresh['C-01.1'].answer = `${ANSWER} A different promise, written under the new name.`;
    writeFileSync(
      join(d, 'findings', 'acks', 'feat-y2.json'),
      JSON.stringify({
        version: 2,
        branch: 'feat/y2',
        answers: Object.fromEntries(
          Object.entries(fresh).map(([q, a]) => [q, { guard: NONE, ...a }]),
        ),
      }),
    );
    git('add', '-A');
    commit(git, 'docs: answers under the new name');
    let r = check(d, ['--range', 'main']);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /feat-y\.json was this branch's answers file under another name — findings\/acks\/feat-y2\.json must carry its answers forward: C-01\.1: a committed answer was rewritten/,
    );
    // the contradicting file is itself frozen once committed; before pushing, undo that commit and
    // carry the answers forward unchanged instead
    git('reset', '-q', '--soft', 'HEAD~1');
    writeFileSync(
      join(d, 'findings', 'acks', 'feat-y2.json'),
      readFileSync(join(d, 'findings', 'acks', 'feat-y.json'), 'utf8').replace(
        '"feat/y"',
        '"feat/y2"',
      ),
    );
    git('add', '-A');
    commit(git, 'docs: carry the answers forward');
    r = check(d, ['--range', 'main']);
    assert.equal(r.status, 0, r.stderr);
  });
  test('every answer names a guard that resolves, or says none with a reason', () => {
    const req = required(LEDGER, CLASSES, ['src/x.mjs']);
    const why = (guards) =>
      missingAnswers(
        {
          version: 2,
          answers: {
            'C-01.1': { answer: ANSWER, guard: guards[0] },
            'C-02.1': { answer: `${ANSWER} Every field.`, guard: guards[1] },
          },
        },
        req,
      ).map((m) => m.why);
    assert.match(why([undefined, NONE])[0], /no guard/);
    assert.match(why(['none: short', NONE])[0], /is not "path::test name"/);
    assert.match(why(['test/a.test.mjs', NONE])[0], /is not "path::test name"/);
    assert.deepEqual(why(['test/a.test.mjs::refuses absent input', NONE]), []);
    // a guard is a test, not the answers file or a document (review I4)
    assert.match(
      why(['findings/acks/feat-y.json::C-01.1 answer', NONE])[0],
      /must point at a test file/,
    );
    assert.match(why(['docs/SELF_EVOLUTION.md::answer', NONE])[0], /must point at a test file/);
    assert.match(why(['test/fixtures/data.json::key', NONE])[0], /must point at a test file/);
    assert.deepEqual(why(['tests/test_gate.py::test_refuses', NONE]), []);
    // the hook needs only the field (the test may not exist yet); the commit needs it to resolve
    const { d, git } = repo();
    ack(d, {
      ...ANSWERS(),
      'C-01.1': { answer: ANSWER, guard: 'test/a.test.mjs::refuses absent input' },
    });
    assert.equal(
      check(d, ['--edit'], JSON.stringify({ cwd: d, tool_input: { file_path: 'src/x.mjs' } }))
        .status,
      0,
    );
    writeFileSync(join(d, 'src', 'x.mjs'), 'export const x = 4;\n');
    git('add', '-A');
    const r = check(d, ['--staged']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /guard test\/a\.test\.mjs::refuses absent input does not resolve/);
    mkdirSync(join(d, 'test'), { recursive: true });
    writeFileSync(join(d, 'test', 'a.test.mjs'), "test('refuses absent input', () => {});\n");
    git('add', '-A');
    assert.equal(check(d, ['--staged']).status, 0);
  });
});

describe('R4: a recurrence under an answered question names the answer that failed', () => {
  test('a finding added under an answered class names the answer that failed', () => {
    const { d, git } = repo();
    ack(d, ANSWERS());
    git('add', '-A');
    commit(git, 'docs: answers');
    const ledger = JSON.parse(readFileSync(join(d, 'findings', 'ledger.json'), 'utf8'));
    const f = {
      id: 'F-03',
      class: 'C-01',
      areas: ['src/x.mjs'],
      title: 'absent input read as success again',
      introduced_in: 'worktree',
    };
    const stage = (finding) => {
      writeFileSync(
        join(d, 'findings', 'ledger.json'),
        JSON.stringify({ findings: [...ledger.findings, finding] }),
      );
      git('add', '-A');
      return check(d, ['--staged']);
    };
    let r = stage(f);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /F-03 \(C-01\) was introduced on this branch after it answered C-01\.1: add "answer_failed"/,
    );
    assert.match(
      stage({
        ...f,
        answer_failed: { qid: 'C-02.1', why: 'the guard only covered one field of three' },
      }).stderr,
      /must be one of this branch's answers for C-01/,
    );
    assert.match(
      stage({ ...f, answer_failed: { qid: 'C-01.1', why: 'short' } }).stderr,
      /must say why/,
    );
    r = stage({
      ...f,
      answer_failed: {
        qid: 'C-01.1',
        why: 'the guard fed one absent key; the second key was never deleted',
      },
    });
    assert.equal(r.status, 0, r.stderr);
    // a problem that predates the branch is not this branch's miss
    assert.equal(stage({ ...f, introduced_in: 'unknown' }).status, 0);
  });
});

describe('R5: stop-the-line is a gate, not a document', () => {
  const STOPPED = {
    findings: [
      ...LEDGER.findings,
      {
        id: 'F-03',
        class: 'C-01',
        areas: ['src/x.mjs'],
        title: 'escape one',
        mechanism_gap: 'the detector fed one key',
        mechanism_upgrade: 'none: instance fix only',
      },
      {
        id: 'F-04',
        class: 'C-01',
        areas: ['src/x.mjs'],
        title: 'escape two',
        mechanism_gap: 'the detector fed one key',
        mechanism_upgrade: 'none: instance fix only',
      },
    ],
  };
  const withStopline = (stopline, detectors) => ({
    classes: CLASSES.classes.map((c) => (c.id === 'C-01' ? { ...c, stopline, detectors } : c)),
  });
  const edit = (d) =>
    check(d, ['--edit'], JSON.stringify({ cwd: d, tool_input: { file_path: 'src/x.mjs' } }));
  test('a class whose last two escapes upgraded nothing stops changes that must answer it', () => {
    const { d, git } = repo({ ledger: STOPPED });
    ack(d, ANSWERS());
    let r = edit(d);
    assert.equal(r.status, 2);
    assert.match(
      r.stderr,
      /C-01 is stopped: its last two escapes \(F-03, F-04\) upgraded no check, and no stopline record/,
    );
    // a review document releases nothing
    mkdirSync(join(d, 'findings', 'reviews'), { recursive: true });
    writeFileSync(join(d, 'findings', 'reviews', 'stop.md'), 'C-01 stop-line review: F-03, F-04');
    assert.equal(edit(d).status, 2);
    // a record for an older pair releases nothing
    const reg = (s, det) =>
      writeFileSync(join(d, 'findings', 'classes.json'), JSON.stringify(withStopline(s, det)));
    reg({
      after: 'F-03',
      waiver: { by: 'owner', on: '2026-10-21', record: 'accepted the risk in review' },
    });
    assert.match(edit(d).stderr, /is for F-03, not the latest escape F-04/);
    // a detector must be listed by the class and resolve
    reg({ after: 'F-04', detector: 'test/d.test.mjs::feeds every key absent' }, []);
    assert.match(edit(d).stderr, /not in the class detectors/);
    reg({ after: 'F-04', detector: 'test/d.test.mjs::feeds every key absent' }, [
      'test/d.test.mjs::feeds every key absent',
    ]);
    assert.match(edit(d).stderr, /does not resolve/);
    mkdirSync(join(d, 'test'), { recursive: true });
    writeFileSync(join(d, 'test', 'd.test.mjs'), "test('feeds every key absent', () => {});\n");
    assert.equal(edit(d).status, 0);
    // the commit and CI see the same stop
    reg(undefined);
    writeFileSync(join(d, 'src', 'x.mjs'), 'export const x = 5;\n');
    git('add', '-A');
    assert.match(check(d, ['--staged']).stderr, /C-01 is stopped/);
    commit(git, 'feat: x');
    assert.match(check(d, ['--range', 'main']).stderr, /C-01 is stopped/);
    // a shell write is stopped too
    assert.match(bash(d, 'echo 6 > src/x.mjs').stderr, /C-01 is stopped/);
    // a later escape that upgraded a check releases the class without a record
    const up = {
      ...STOPPED,
      findings: [
        ...STOPPED.findings,
        {
          id: 'F-05',
          class: 'C-01',
          areas: ['src/x.mjs'],
          title: 'escape three',
          mechanism_gap: 'g',
          mechanism_upgrade: 'test/d.test.mjs::feeds every key absent',
        },
      ],
    };
    writeFileSync(join(d, 'findings', 'ledger.json'), JSON.stringify(up));
    assert.equal(edit(d).status, 0);
  });
  test('a later escape releases a stopped class only with an upgrade that resolves (review I3)', () => {
    const escape = (id, up) => ({
      id,
      class: 'C-01',
      areas: ['src/x.mjs'],
      title: id,
      mechanism_gap: 'g',
      mechanism_upgrade: up,
    });
    const files = { 'test/d.test.mjs': "test('feeds every key absent', () => {});" };
    const read = (p) => files[p] ?? null;
    const at = (third) => [
      ...stoppedClasses(
        {
          findings: [
            escape('F-03', 'none: instance'),
            escape('F-04', 'none: instance'),
            escape('F-05', third),
          ],
        },
        CLASSES,
        { read, today: '2026-10-21' },
      ).keys(),
    ];
    assert.deepEqual(at('x'), ['C-01'], 'prose upgrades nothing');
    assert.deepEqual(
      at('test/d.test.mjs::no such test'),
      ['C-01'],
      'a reference that does not resolve upgrades nothing',
    );
    assert.deepEqual(
      at('test/d.test.mjs::feeds every key absent'),
      [],
      'a check that resolves releases it',
    );
  });
  test('waivers and debt release a stopped class; debt falls due', () => {
    const cls = (stopline) => ({ id: 'C-01', detectors: [], stopline });
    const at = (stopline, today = '2026-10-21') =>
      stoplineGap(cls(stopline), 'F-04', { read: () => null, today });
    assert.equal(
      at({
        after: 'F-04',
        waiver: { by: 'owner', on: '2026-10-21', record: 'accepted in the pull request review' },
      }),
      null,
    );
    assert.match(
      at({ after: 'F-04', waiver: { by: 'owner', on: 'today', record: 'x' } }),
      /needs \{by, on/,
    );
    const debt = {
      after: 'F-04',
      debt: { plan: 'a counter-based bound for every matcher', until: '2026-10-28' },
    };
    assert.equal(at(debt), null);
    assert.equal(at(debt, '2026-10-28'), null, 'due on the day itself');
    assert.match(at(debt, '2026-10-29'), /was due 2026-10-28/);
    assert.match(at({ after: 'F-04' }), /one of detector, waiver or debt/);
  });
  test('control: the stop-line sees the classes stopped in the ledger, and only those', () => {
    // the ledger as it stood on 2026-10-21 before this change (F-01…F-128, with
    // F-105 and F-120 still open and their upgrades still "none", as they were then)
    const real = JSON.parse(readFileSync(join(REPO, 'findings', 'ledger.json'), 'utf8'));
    const reg = JSON.parse(readFileSync(join(REPO, 'findings', 'classes.json'), 'utf8'));
    const then = {
      findings: real.findings
        .filter((f) => Number(f.id.slice(2)) <= 128)
        .map(
          (f) =>
            ({
              'F-120': {
                ...f,
                mechanism_upgrade: 'none: open — commit-time and CI enforcement cover it',
              },
              'F-105': { ...f, mechanism_upgrade: 'none: open — product decision' },
            })[f.id] ?? f,
        ),
    };
    const bare = { classes: reg.classes.map(({ stopline, ...c }) => c) };
    const read = (p) => {
      try {
        return readFileSync(join(REPO, p), 'utf8');
      } catch {
        return null;
      }
    };
    const stopped = [...stoppedClasses(then, bare, { read, today: '2026-10-21' }).keys()].sort();
    assert.deepEqual(stopped, ['C-02', 'C-03', 'C-04', 'C-13', 'C-15']);
  });
});

describe('every refusal says what to do', () => {
  test('absent inputs refuse: no answers, no guard, no version, no answer_failed, no stop-line record', () => {
    const { d } = repo();
    const edit = () =>
      check(d, ['--edit'], JSON.stringify({ cwd: d, tool_input: { file_path: 'src/x.mjs' } }));
    assert.equal(edit().status, 2, 'no answers file');
    ack(d, ANSWERS());
    assert.equal(edit().status, 0);
    const noGuard = JSON.parse(readFileSync(join(d, 'findings', 'acks', 'feat-y.json'), 'utf8'));
    delete noGuard.answers['C-01.1'].guard;
    writeFileSync(join(d, 'findings', 'acks', 'feat-y.json'), JSON.stringify(noGuard));
    assert.match(edit().stderr, /no guard/, 'no guard');
    delete noGuard.version;
    noGuard.answers['C-01.1'].guard = NONE;
    writeFileSync(join(d, 'findings', 'acks', 'feat-y.json'), JSON.stringify(noGuard));
    assert.match(edit().stderr, /must carry "version": 2/, 'no version on a new answers file');
    writeFileSync(join(d, 'findings', 'acks', 'feat-y.json'), '{ not json');
    assert.match(edit().stderr, /is not valid JSON/, 'a malformed file is not "no answers yet"');
  });
  test('each refusal says what to do, and doing it passes', () => {
    const { d } = repo();
    const r = check(
      d,
      ['--edit'],
      JSON.stringify({ cwd: d, tool_input: { file_path: 'src/x.mjs' } }),
    );
    assert.match(r.stderr, /write them to findings\/acks\/feat-y\.json/);
    ack(d, ANSWERS()); // doing exactly that
    assert.equal(
      check(d, ['--edit'], JSON.stringify({ cwd: d, tool_input: { file_path: 'src/x.mjs' } }))
        .status,
      0,
    );
    const s = bash(d, 'echo $(date) > src/x.mjs');
    assert.equal(s.status, 0, 'answered: the shell write passes too');
  });
});

describe('R6: the data the gate reads only moves forward', () => {
  const BASE_LEDGER = {
    findings: [
      {
        id: 'F-01',
        class: 'C-01',
        areas: ['src/x.mjs'],
        title: 'a known problem in x',
        status: 'open',
        why: ['a', 'b'],
      },
      {
        id: 'F-02',
        class: 'C-02',
        areas: ['docs/'],
        title: 'a known docs problem',
        status: 'fixed',
      },
    ],
  };
  const BASE_CLASSES = {
    classes: [
      {
        id: 'C-01',
        name: 'absence',
        questions: [{ id: 'C-01.1', ask: 'What happens when the input is absent here?' }],
        detectors: ['test/d.test.mjs::feeds every key absent'],
      },
      {
        id: 'C-02',
        name: 'lists',
        questions: [{ id: 'C-02.1', ask: 'Does a list stand in for all of them here?' }],
      },
    ],
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const regress = (mutate) => {
    const head = { ledger: clone(BASE_LEDGER), registry: clone(BASE_CLASSES) };
    mutate(head);
    return dataRegressions({ ledger: BASE_LEDGER, registry: BASE_CLASSES }, head);
  };
  test('the registry and the ledger only move forward between base and head (R6)', () => {
    assert.deepEqual(
      regress(() => {}),
      [],
      'unchanged passes',
    );
    assert.match(regress((h) => h.registry.classes[0].questions.pop())[0], /C-01\.1 was removed/);
    assert.match(
      regress((h) => (h.registry.classes[0].questions[0].ask = 'Anything absent?'))[0],
      /C-01\.1\.ask was reworded/,
    );
    assert.match(
      regress((h) => (h.registry.classes[0].detectors = []))[0],
      /C-01\.detectors lost entries/,
    );
    assert.match(regress((h) => h.registry.classes.pop())[0], /C-02 was removed/);
    assert.match(regress((h) => h.ledger.findings.pop())[0], /F-02 was removed from the ledger/);
    assert.match(regress((h) => (h.ledger.findings[0].title = 'softer'))[0], /F-01\.title changed/);
    assert.match(
      regress((h) => (h.ledger.findings[1].status = 'open'))[0],
      /F-02\.status moved back from fixed to open/,
    );
    assert.match(regress((h) => (h.ledger.findings[0].why = ['a']))[0], /F-01\.why lost entries/);
    // the same rule at commit and in CI
    const { d, git } = repo({ ledger: BASE_LEDGER, classes: BASE_CLASSES });
    ack(d, ANSWERS());
    const loosened = clone(BASE_CLASSES);
    loosened.classes[0].questions[0].ask = 'Anything absent?';
    writeFileSync(join(d, 'findings', 'classes.json'), JSON.stringify(loosened));
    git('add', '-A');
    assert.match(check(d, ['--staged']).stderr, /C-01\.1\.ask was reworded/);
    commit(git, 'docs: answers and a softer question');
    assert.match(check(d, ['--range', 'main']).stderr, /C-01\.1\.ask was reworded/);
  });
  test('a correction record allows a changed field, with its reason', () => {
    const fix = (why) =>
      regress((h) => {
        h.ledger.findings[0].title = 'a known problem in x, read wrongly before';
        h.ledger.findings[0].corrections = [{ field: 'title', from: 'a known problem in x', why }];
      });
    assert.deepEqual(fix('the review showed the title named the wrong file'), []);
    assert.match(fix('short')[0], /F-01\.title changed/);
    // corrections only grow
    const base = { ledger: clone(BASE_LEDGER), registry: BASE_CLASSES };
    base.ledger.findings[0].corrections = [
      { field: 'x', from: 1, why: 'an earlier correction with its reason' },
    ];
    assert.match(
      dataRegressions(base, { ledger: clone(BASE_LEDGER), registry: BASE_CLASSES })[0],
      /F-01\.corrections lost entries/,
    );
  });
  test('legitimate progress passes: open to fixed, a new detector, an appended question', () => {
    assert.deepEqual(
      regress((h) => {
        h.ledger.findings[0].status = 'fixed';
        h.ledger.findings[0].areas.push('src/y.mjs');
        h.ledger.findings.push({ id: 'F-03', class: 'C-01', areas: ['src/x.mjs'], title: 'new' });
        h.registry.classes[0].detectors.push('test/e.test.mjs::another check');
        h.registry.classes[0].questions[0].ask += ' Say how the test deletes it.';
        h.registry.classes[0].questions.push({
          id: 'C-01.2',
          ask: 'A new question learned this week?',
        });
        h.registry.classes.push({ id: 'C-03', name: 'new class', questions: [] });
      }),
      [],
    );
    // the real ledger's own history from the stacked base to this branch is progress, not regression
    const at = (rev, f) =>
      JSON.parse(execFileSync('git', ['show', `${rev}:${f}`], { cwd: REPO, env: ENV }));
    let base;
    try {
      base = {
        ledger: at('release/oss-prep', 'findings/ledger.json'),
        registry: at('release/oss-prep', 'findings/classes.json'),
      };
    } catch {
      return; // a shallow clone without that branch: the planted cases above still hold
    }
    const head = {
      ledger: JSON.parse(readFileSync(join(REPO, 'findings', 'ledger.json'), 'utf8')),
      registry: JSON.parse(readFileSync(join(REPO, 'findings', 'classes.json'), 'utf8')),
    };
    assert.deepEqual(dataRegressions(base, head), []);
  });
  test('every frozen field of a real finding is checked', () => {
    const real = JSON.parse(readFileSync(join(REPO, 'findings', 'ledger.json'), 'utf8'));
    const f =
      real.findings.find((x) => FROZEN.every((k) => x[k] !== undefined)) ??
      real.findings.find((x) => x.answer_failed);
    assert.ok(f, 'a real finding carrying the frozen fields');
    for (const k of FROZEN) {
      if (f[k] === undefined) continue;
      const head = clone(real);
      const h = head.findings.find((x) => x.id === f.id);
      h[k] = typeof h[k] === 'string' ? `${h[k]} (changed)` : { changed: true };
      const out = dataRegressions(
        { ledger: real, registry: { classes: [] } },
        { ledger: head, registry: { classes: [] } },
      );
      assert.ok(
        out.some((m) => m.includes(`${f.id}.${k} changed`)),
        `${k} is not frozen`,
      );
    }
  });
  test("the gate's files are listed once, and the list is what the checker loads (F-144)", () => {
    assert.ok(existsSync(MANIFEST), 'scripts/gate-files.json lists the files the gate runs from');
    // every relative module the checker reaches, statically or lazily
    const closure = new Set();
    const visit = (rel) => {
      if (closure.has(rel)) return;
      closure.add(rel);
      const text = readFileSync(join(REPO, rel), 'utf8');
      const specs = [
        ...text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]/gm),
        ...text.matchAll(/^\s*import\s*['"](\.[^'"]+)['"]/gm),
        ...text.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g),
      ].map((m) => m[1]);
      for (const sp of specs) visit(join(dirname(rel), sp).split('\\').join('/'));
    };
    visit('scripts/findings-check.mjs');
    assert.deepEqual([...closure].sort(), [...GATE_FILES].sort());
    // and everything that copies the gate reads the list instead of its own
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ci, /scripts\/gate-files\.json/, 'the CI base-checker step reads the list');
  });
  test("the base branch's checker judges the pull request too", () => {
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    const start = ci.indexOf('\n  self-evolution:\n');
    const job = ci.slice(start + 1).split(/\n {2}[a-z][\w-]*:\n/)[0];
    assert.match(
      job,
      /git show "origin\/\$base:\$f"/,
      'the step reads the base scripts with git show',
    );
    assert.match(
      job,
      /node "\$RUNNER_TEMP\/base-checker\/scripts\/findings-check\.mjs" --range "origin\/\$base"/,
    );
    // functionally: a branch that guts its own checker is still judged by the base's
    const { d, git } = repo();
    writeFileSync(join(d, 'scripts', 'findings-check.mjs'), 'process.exit(0);\n');
    writeFileSync(join(d, 'src', 'x.mjs'), 'export const x = 9;\n');
    git('add', '-A');
    commit(git, 'feat: x, with a checker that says yes');
    assert.equal(check(d, ['--range', 'main']).status, 0, "the branch's own checker now says yes");
    const baseDir = mkdtempSync(join(tmpdir(), 'base-checker-'));
    // as the CI step does: every file of the gate, as the base has it
    for (const f of GATE_FILES) {
      mkdirSync(dirname(join(baseDir, f)), { recursive: true });
      writeFileSync(
        join(baseDir, f),
        execFileSync('git', ['show', `main:${f}`], { cwd: d, env: ENV }),
      );
    }
    const r = spawnSync(
      process.execPath,
      [join(baseDir, 'scripts', 'findings-check.mjs'), '--range', 'main'],
      { cwd: d, encoding: 'utf8', env: ENV },
    );
    assert.equal(r.status, 1, "the base's checker still refuses");
    assert.match(r.stderr, /C-01\.1/);
  });
});
