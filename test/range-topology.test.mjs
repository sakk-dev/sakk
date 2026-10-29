import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The CI gate (`findings-check --range <base>`) over the shapes git history really takes:
 * parallel lines merged together, a stack of pull requests merged into main as one, a parent
 * rebase- or squash-merged before its child, and the merge commit CI checks out. Every test
 * runs the real checker in a throwaway repository.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
/** The gate's own files, listed once (F-144, F-216); the fallback only lets this file load on a base without the list. */
const MANIFEST = join(REPO, 'scripts', 'gate-files.json');
const GATE_FILES = existsSync(MANIFEST)
  ? JSON.parse(readFileSync(MANIFEST, 'utf8')).files
  : ['scripts/findings-check.mjs', 'scripts/findings-lib.mjs'];

// The three classes with the most findings are asked of every change (the watch list). Three
// busier classes without questions hold it here, so C-01.1 is asked only of a change to
// src/x.mjs, and an unrelated file such as README.md asks nothing.
const BUSY = ['C-02', 'C-03', 'C-04'];
const LEDGER = {
  findings: [
    {
      id: 'F-01',
      class: 'C-01',
      areas: ['src/x.mjs'],
      title: 'a known problem in x',
      status: 'fixed',
    },
    ...BUSY.flatMap((cls, i) =>
      [1, 2].map((k) => ({
        id: `F-${10 + 2 * i + k}`,
        class: cls,
        areas: ['docs/'],
        title: `a busy class (${cls})`,
        status: 'fixed',
      })),
    ),
  ],
};
const CLASSES = {
  classes: [
    {
      id: 'C-01',
      questions: [{ id: 'C-01.1', ask: 'What happens when the input is absent here?' }],
    },
    ...BUSY.map((id) => ({ id, questions: [] })),
  ],
};
/** An acceptable answer to C-01.1, in `who`'s own words. */
const said = (who) =>
  `Absent input refuses with a named code (as ${who} puts it) and a test proves it.`;
const NONE = 'none: this throwaway repository has no test suite to point at';
const acksFile = (branch) => `findings/acks/${branch.replaceAll('/', '-')}.json`;

// a git hook exports GIT_INDEX_FILE and friends; a child git in a throwaway repo must not see
// them, and the checker must not see a branch name the caller did not give it
const ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'SAKK_BRANCH'),
);

/** A throwaway repository on main: the checker, the ledger and src/x.mjs, committed. */
function repo() {
  const d = mkdtempSync(join(tmpdir(), 'range-topology-'));
  // every git call a minute after the last, so the order rev-list prints commits in is fixed
  let clock = 1767225600;
  const git = (...a) => {
    const at = `${(clock += 60)} +0000`;
    return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
      cwd: d,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...ENV, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
      timeout: 30_000,
    }).trim();
  };
  const write = (path, text) => {
    mkdirSync(dirname(join(d, path)), { recursive: true });
    writeFileSync(join(d, path), text);
  };
  const remove = (path) => rmSync(join(d, path));
  /** `branch`'s answers file, version 2: every answer names its guard (R3). */
  const answers = (branch, given = {}) => {
    const v2 = Object.fromEntries(
      Object.entries(given).map(([q, a]) => [q, { guard: NONE, ...a }]),
    );
    write(acksFile(branch), `${JSON.stringify({ version: 2, branch, answers: v2 }, null, 2)}\n`);
  };
  /** Commit everything; returns the short sha the checker names commits by. */
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', msg);
    return git('rev-parse', 'HEAD').slice(0, 7);
  };
  const merge = (branch) =>
    git('merge', '-q', '--no-ff', '--no-verify', '-m', `merge ${branch}`, branch);
  const check = (base, env = {}) =>
    spawnSync(process.execPath, [join(d, 'scripts', 'findings-check.mjs'), '--range', base], {
      cwd: d,
      encoding: 'utf8',
      env: { ...ENV, ...env },
      timeout: 30_000,
    });
  for (const f of GATE_FILES) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    copyFileSync(join(REPO, f), join(d, f));
  }
  write('findings/ledger.json', JSON.stringify(LEDGER));
  write('findings/classes.json', JSON.stringify(CLASSES));
  write('src/x.mjs', 'export const x = 1;\n');
  git('init', '-q', '-b', 'main');
  commit('base');
  return { git, write, remove, answers, commit, merge, check };
}

/**
 * Start `branch` from the current commit and commit one piece of work on it: a change to
 * src/x.mjs, answered (C-01.1, in the branch's own words) in its own answers file. `edit` adds
 * to that commit. Returns the commit's short sha.
 */
function work(r, branch, edit = () => {}) {
  r.git('checkout', '-qb', branch);
  r.write('src/x.mjs', `export const x = ${JSON.stringify(branch)};\n`);
  r.answers(branch, { 'C-01.1': { answer: said(branch) } });
  edit(r);
  return r.commit(`work on ${branch}`);
}

/** Two stacked pull requests: feat/c started from feat/p. Ends on feat/c; both branches exist. */
function stack({ parent, child } = {}) {
  const r = repo();
  work(r, 'feat/p', parent);
  work(r, 'feat/c', child);
  return r;
}

/**
 * feat/p (two commits to src/x.mjs, answered) and feat/c started from it, which only touches
 * README.md; then main moves on and takes feat/p by rebase (new commits) or squash (one new
 * commit). Ends on feat/c, which still carries feat/p's original commits.
 */
function parentMergedFirst(how) {
  const r = repo();
  work(r, 'feat/p');
  r.write('src/x.mjs', 'export const x = 3;\n');
  r.commit('more work on feat/p');
  r.git('checkout', '-qb', 'feat/c');
  r.write('README.md', '# c\n');
  r.answers('feat/c');
  r.commit('feat/c documents c');
  r.git('checkout', '-q', 'main');
  r.write('CHANGELOG.md', '# changes\n');
  r.commit('main moves on');
  if (how === 'rebase') r.git('cherry-pick', 'main..feat/p');
  else {
    r.git('merge', '-q', '--squash', 'feat/p');
    r.commit('feat/p, squashed');
  }
  r.git('checkout', '-q', 'feat/c');
  return r;
}

/**
 * feat/y opens its answers file (`y`); line A (`a`) and line D (README.md only) start from
 * that commit, A committed first, and both are merged back into feat/y. Returns A's short sha.
 */
function parallelLines(r, { y, a }) {
  r.git('checkout', '-qb', 'feat/y');
  y(r);
  r.commit('feat/y opens its answers file');
  r.git('checkout', '-qb', 'line/a');
  a(r);
  const lineA = r.commit('line A');
  r.git('checkout', '-qb', 'line/d', 'feat/y');
  r.write('README.md', '# y\n');
  r.commit('line D documents y');
  r.git('checkout', '-q', 'feat/y');
  r.merge('line/a');
  r.merge('line/d');
  return lineA;
}

describe('the range check across real git histories', () => {
  test('a straight branch with answers passes', () => {
    const r = repo();
    work(r, 'feat/y');
    r.write('src/x.mjs', 'export const x = 3;\n');
    r.commit('more work on feat/y');
    const res = r.check('main');
    assert.equal(res.status, 0, res.stderr);
    // the same change unanswered is refused: C-01.1 is what src/x.mjs asks
    const bare = repo();
    bare.git('checkout', '-qb', 'feat/y');
    bare.write('src/x.mjs', 'export const x = 2;\n');
    bare.commit('change x without answering');
    const refused = bare.check('main');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /C-01\.1 \[no answer\]/);
  });

  test('two lines developed in parallel and merged are each compared with their own parents', () => {
    // line A answers C-01.1 for its change to src/x.mjs; line D never touches the answers file.
    // Read as one straight line, D's commit follows A's and seems to drop C-01.1.
    const r = repo();
    parallelLines(r, {
      y: (r) => r.answers('feat/y'),
      a: (r) => {
        r.write('src/x.mjs', 'export const x = 2;\n');
        r.answers('feat/y', { 'C-01.1': { answer: said('line A') } });
      },
    });
    assert.match(r.git('show', `HEAD:${acksFile('feat/y')}`), /C-01\.1/, 'the merge keeps A');
    const res = r.check('main');
    assert.equal(res.status, 0, res.stderr);

    // control: a line that rewrites the answer its own parent committed is refused, by name
    const c = repo();
    const lineA = parallelLines(c, {
      y: (c) => {
        c.write('src/x.mjs', 'export const x = 2;\n');
        c.answers('feat/y', { 'C-01.1': { answer: said('feat/y') } });
      },
      a: (c) => c.answers('feat/y', { 'C-01.1': { answer: said('line A') } }),
    });
    const bad = c.check('main');
    assert.equal(bad.status, 1);
    assert.match(
      bad.stderr,
      new RegExp(`${lineA}[^\\n]*C-01\\.1: a committed answer was rewritten`),
    );
  });

  test("a stack merged into main as one pull request: the parents' answers files are inherited, not carried forward", () => {
    // feat/g ← feat/p ← feat/c, each answering C-01.1 in its own words; every branch still exists
    const r = repo();
    for (const b of ['feat/g', 'feat/p', 'feat/c']) work(r, b);
    const res = r.check('main');
    assert.equal(res.status, 0, res.stderr);
  });

  test('an inherited answers file may not be removed, rewritten or keep a guard that no longer resolves', () => {
    // feat/p still exists, so its file is inherited: refused for what happened to it, not as a rename
    const removed = stack({ child: (r) => r.remove(acksFile('feat/p')) }).check('main');
    assert.equal(removed.status, 1, 'removed');
    assert.match(removed.stderr, /feat-p\.json/);
    assert.doesNotMatch(removed.stderr, /under another name/);

    const reworded = { 'C-01.1': { answer: `${said('feat/p')} Reworded on feat/c.` } };
    const rewritten = stack({ child: (r) => r.answers('feat/p', reworded) }).check('main');
    assert.equal(rewritten.status, 1, 'rewritten');
    assert.match(rewritten.stderr, /feat-p\.json[^\n]*C-01\.1: a committed answer was rewritten/);

    const guard = 'test/a.test.mjs::some test';
    const unguarded = stack({
      parent: (r) => {
        r.write('test/a.test.mjs', "test('some test', () => {});\n");
        r.answers('feat/p', { 'C-01.1': { answer: said('feat/p'), guard } });
      },
      child: (r) => r.remove('test/a.test.mjs'),
    }).check('main');
    assert.equal(unguarded.status, 1, 'guard gone');
    assert.match(
      unguarded.stderr,
      /feat-p\.json[^\n]*guard test\/a\.test\.mjs::some test does not resolve/,
    );
    assert.doesNotMatch(unguarded.stderr, /under another name/);
  });

  test('a parent whose branch is gone counts as a rename and must carry its answers forward', () => {
    const r = stack();
    r.git('branch', '-q', '-D', 'feat/p');
    const res = r.check('main');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /feat-p\.json[^\n]*under another name/);
  });

  test('a parent kept only as a remote ref still counts as inherited', () => {
    const r = stack();
    r.git('update-ref', 'refs/remotes/origin/feat/p', r.git('rev-parse', 'feat/p'));
    r.git('branch', '-q', '-D', 'feat/p');
    const res = r.check('main');
    assert.equal(res.status, 0, res.stderr);
  });

  test("a child whose parent was rebase-merged or squash-merged into main is not asked about the parent's files", () => {
    for (const how of ['rebase', 'squash']) {
      const r = parentMergedFirst(how);
      assert.equal(r.git('rev-list', '--count', 'main..HEAD'), '3', `${how}: feat/p's own commits`);
      const res = r.check('main');
      assert.equal(res.status, 0, `${how}: ${res.stderr}`);
      assert.doesNotMatch(res.stderr, /C-01\.1/, how);
    }
  });

  test('a pull request merge commit, as CI checks it out, passes the same way', () => {
    // actions/checkout puts the pull request's merge commit on a detached HEAD; the workflow
    // names the branch in SAKK_BRANCH
    for (const [what, r] of [
      ['a stack', stack()],
      ['a child of a squash-merged parent', parentMergedFirst('squash')],
    ]) {
      r.git('checkout', '-q', '--detach', 'main');
      r.merge('feat/c');
      const res = r.check('main', { SAKK_BRANCH: 'feat/c' });
      assert.equal(res.status, 0, `${what}: ${res.stderr}`);
    }
  });

  test('an answers file already on the base may not be removed or rewritten', () => {
    const run = (edit) => {
      const r = repo();
      r.answers('feat/old', { 'C-01.1': { answer: said('feat/old') } });
      r.commit('feat/old merged with its answers');
      work(r, 'feat/y', edit);
      return r.check('main');
    };
    const kept = run(() => {});
    assert.equal(kept.status, 0, kept.stderr);
    const reworded = { 'C-01.1': { answer: `${said('feat/old')} Reworded on feat/y.` } };
    const rewritten = run((r) => r.answers('feat/old', reworded));
    assert.equal(rewritten.status, 1, `rewritten: ${rewritten.stdout}`);
    assert.match(rewritten.stderr, /feat-old\.json/);
    // removed in the commit that adds feat-y.json, so git's rename detection pairs the two and
    // `git diff --name-only` lists only feat-y.json
    const removed = run((r) => r.remove(acksFile('feat/old')));
    assert.equal(removed.status, 1, `removed: ${removed.stdout}`);
    assert.match(removed.stderr, /feat-old\.json/);
  });

  test('moving a file asks about its old path too', () => {
    // git mv src/x.mjs elsewhere: rename detection would list only the new path, and the
    // ledger's areas name the old one
    const r = repo();
    r.git('checkout', '-qb', 'feat/m');
    r.git('mv', 'src/x.mjs', 'src/moved.mjs');
    r.answers('feat/m');
    r.commit('feat/m moves x');
    const unanswered = r.check('main');
    assert.equal(unanswered.status, 1, unanswered.stdout);
    assert.match(unanswered.stderr, /C-01\.1 \[no answer\]/);
    r.answers('feat/m', { 'C-01.1': { answer: said('feat/m') } });
    r.commit('feat/m answers for the old path');
    const answered = r.check('main');
    assert.equal(answered.status, 0, answered.stderr);
  });
});
