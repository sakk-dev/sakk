import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The pre-push hook as git runs it: a real `git push` from a throwaway
 * repository to a local bare one, with the real hook script. The range checker
 * and the test script are stand-ins: each logs its call and exits with a code
 * the test writes, so the test decides pass or fail and counts what ran.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const which = (cmd, path) =>
  path
    .split(delimiter)
    .filter(Boolean)
    .map((d) => join(d, cmd))
    .find((p) => {
      try {
        accessSync(p, constants.X_OK);
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
const GIT = which('git', process.env.PATH ?? ''); // by path, so a PATH without it still runs git
const NPM = which('npm', process.env.PATH ?? '');
const ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) =>
      !k.startsWith('GIT_') &&
      ![
        'SAKK_PR_BASE',
        'SAKK_BRANCH',
        'XDG_CONFIG_HOME',
        'SAKK_HEAVY_LOCK',
        'SAKK_HEAVY_LOCK_PID',
      ].includes(k),
  ),
);

// npm runs this in the repository root (a worktree sits beside it); the control files sit next to it
const SUITE = 'node ../ctl/suite.mjs';
// the fake suite does what a test fixture does: a throwaway repository, made with the
// environment the suite was given, and it records which GIT_ variables it saw
const suite = (
  ctl,
) => `import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ctl = ${JSON.stringify(ctl)};
appendFileSync(join(ctl, 'suite.log'), 'ran\\n');
// who held the machine-wide lock while the suite ran (F-220)
appendFileSync(
  join(ctl, 'suite.lock'),
  JSON.stringify({
    pid: process.env.SAKK_HEAVY_LOCK_PID ?? null,
    held: existsSync(process.env.SAKK_HEAVY_LOCK ?? ''),
  }) + '\\n',
);
appendFileSync(
  join(ctl, 'suite.env'),
  Object.keys(process.env).filter((k) => k.startsWith('GIT_')).sort().join(' ') + '\\n',
);
const d = mkdtempSync(join(tmpdir(), 'fixture-'));
try {
  execFileSync(${JSON.stringify(GIT)}, ['init', '-q', d], { stdio: 'ignore' });
  execFileSync(${JSON.stringify(GIT)}, ['-C', d, 'config', 'fixture.wrote', 'here'], { stdio: 'ignore' });
} finally {
  rmSync(d, { recursive: true, force: true });
}
process.exit(Number(readFileSync(join(ctl, 'suite.code'), 'utf8')));
`;
const checker = (ctl) => `import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(
  ${JSON.stringify(join(ctl, 'range.log'))},
  JSON.stringify({ args: process.argv.slice(2), branch: process.env.SAKK_BRANCH ?? null }) + '\\n',
);
process.exit(Number(readFileSync(${JSON.stringify(join(ctl, 'range.code'))}, 'utf8')));
`;

function setup(t) {
  assert.ok(GIT && NPM, `git (${GIT}) and npm (${NPM}) must be on PATH`);
  const root = mkdtempSync(join(tmpdir(), 'pre-push-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  const ctl = join(root, 'ctl');
  const origin = join(root, 'origin.git');
  for (const d of [join(work, 'scripts', 'hooks'), ctl, join(root, 'home')])
    mkdirSync(d, { recursive: true });
  const env = {
    ...ENV,
    HOME: join(root, 'home'),
    SAKK_PR_BASE: 'main',
    SAKK_HEAVY_LOCK: join(root, 'heavy.lock'),
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_update_notifier: 'false',
  };
  const git = (...a) =>
    execFileSync(GIT, a, { cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();
  const code = (what, n) => writeFileSync(join(ctl, `${what}.code`), String(n));
  const lines = (f) =>
    existsSync(join(ctl, f)) ? readFileSync(join(ctl, f), 'utf8').split('\n').filter(Boolean) : [];

  for (const h of ['pre-push', 'pre-push.mjs'])
    copyFileSync(join(REPO, 'scripts', 'hooks', h), join(work, 'scripts', 'hooks', h));
  // the hook takes the machine-wide lock with the real lock module (F-220)
  const lockModule = join(REPO, 'scripts', 'heavy-lock.mjs');
  if (existsSync(lockModule)) copyFileSync(lockModule, join(work, 'scripts', 'heavy-lock.mjs'));
  chmodSync(join(work, 'scripts', 'hooks', 'pre-push'), 0o755);
  writeFileSync(join(work, 'scripts', 'findings-check.mjs'), checker(ctl));
  writeFileSync(join(ctl, 'suite.mjs'), suite(ctl));
  writeFileSync(
    join(work, 'package.json'),
    JSON.stringify({ name: 'throwaway', private: true, scripts: { test: SUITE } }, null, 2),
  );
  writeFileSync(join(work, 'x.txt'), '1\n');
  code('range', 0);
  code('suite', 0);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'core.hooksPath', 'scripts/hooks');
  git('add', '-A');
  git('commit', '-qm', 'base');
  execFileSync(GIT, ['clone', '-q', '--bare', work, origin], { env, stdio: 'ignore' });
  git('remote', 'add', 'origin', origin);
  git('fetch', '-q', 'origin');
  git('checkout', '-qb', 'feat/y');

  return {
    root,
    work,
    origin,
    env,
    git,
    code,
    change(text, cwd = work) {
      writeFileSync(join(cwd, 'x.txt'), `${text}\n`);
      execFileSync(GIT, ['commit', '-qam', `x = ${text}`], { cwd, env, stdio: 'ignore' });
    },
    push(args, pushEnv = env, cwd = work) {
      const r = spawnSync(GIT, ['push', ...args], { cwd, env: pushEnv, encoding: 'utf8' });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    },
    suiteEnvs: () => lines('suite.env'),
    head: () => git('rev-parse', 'HEAD'),
    remoteHead(branch) {
      const r = spawnSync(GIT, ['--git-dir', origin, 'rev-parse', '--verify', '-q', branch], {
        env,
        encoding: 'utf8',
      });
      return r.status === 0 ? r.stdout.trim() : null;
    },
    ranges: () => lines('range.log').map((l) => JSON.parse(l)),
    suiteRuns: () => lines('suite.log').length,
    suiteLocks: () => lines('suite.lock').map((l) => JSON.parse(l)),
    lock: join(root, 'heavy.lock'),
  };
}

test('a push runs the range check and the full suite, and refuses when either fails', (t) => {
  const r = setup(t);
  r.change('2');
  let p = r.push(['origin', 'feat/y']);
  assert.equal(p.status, 0, p.out);
  assert.match(p.out, /base branch main \(SAKK_PR_BASE\)/);
  assert.deepEqual(r.ranges(), [{ args: ['--range', 'origin/main'], branch: 'feat/y' }]);
  assert.equal(r.suiteRuns(), 1);
  assert.equal(r.remoteHead('feat/y'), r.head());
  const pushed = r.head();

  // a red range check refuses the push, before the suite spends its time
  r.code('range', 1);
  r.change('3');
  p = r.push(['origin', 'feat/y']);
  assert.notEqual(p.status, 0, p.out);
  assert.match(p.out, /range check against origin\/main is red/);
  assert.equal(r.ranges().length, 2);
  assert.equal(r.suiteRuns(), 1);
  assert.equal(r.remoteHead('feat/y'), pushed);

  // a red suite refuses it too
  r.code('range', 0);
  r.code('suite', 1);
  p = r.push(['origin', 'feat/y']);
  assert.notEqual(p.status, 0, p.out);
  assert.match(p.out, /full suite failed on this tree/);
  assert.equal(r.suiteRuns(), 2);
  assert.equal(r.remoteHead('feat/y'), pushed);

  // the failed run left no pass mark, so the suite runs again once it is green
  r.code('suite', 0);
  p = r.push(['origin', 'feat/y']);
  assert.equal(p.status, 0, p.out);
  assert.equal(r.suiteRuns(), 3);
  assert.equal(r.remoteHead('feat/y'), r.head());
});

test('a push from a linked worktree: the suite gets no GIT_ variables, so a fixture cannot write into the repository (F-214)', (t) => {
  const r = setup(t);
  const wt = join(r.root, 'wt'); // beside work, so the suite's ../ctl still resolves
  r.git('worktree', 'add', '-q', wt, '-b', 'feat/wt');
  r.change('w1', wt);
  // git exports GIT_DIR to a hook run from a linked worktree; the main checkout gets less
  const p = r.push(['origin', 'feat/wt'], r.env, wt);
  assert.equal(p.status, 0, p.out);
  assert.equal(r.suiteRuns(), 1);
  assert.deepEqual(r.suiteEnvs(), [], 'the suite saw GIT_ variables from the hook');
  const leaked = spawnSync(GIT, ['config', '--get', 'fixture.wrote'], {
    cwd: r.work,
    env: r.env,
    encoding: 'utf8',
  });
  assert.equal(leaked.stdout.trim(), '', 'a fixture wrote into the pushed repository');
  assert.equal(r.git('config', '--get', 'core.bare'), 'false');
});

test('the full suite runs once per tree: a second push of the same tree skips it', (t) => {
  const r = setup(t);
  r.change('2');
  assert.equal(r.push(['origin', 'feat/y']).status, 0);
  assert.equal(r.suiteRuns(), 1);
  const tree = r.git('rev-parse', 'HEAD^{tree}');
  assert.ok(existsSync(join(r.work, '.git', 'sakk-tested', tree)));

  // a new commit with the same tree (an amended message, a no-op rebase)
  r.git('commit', '-q', '--allow-empty', '-m', 'same tree, new commit');
  const p = r.push(['origin', 'feat/y']);
  assert.equal(p.status, 0, p.out);
  assert.match(p.out, /already passed the full suite/);
  assert.equal(r.suiteRuns(), 1);
  assert.equal(r.ranges().length, 2); // the range check still runs on every push
  assert.equal(r.remoteHead('feat/y'), r.head());

  // a different tree runs it again
  r.change('3');
  assert.equal(r.push(['origin', 'feat/y']).status, 0);
  assert.equal(r.suiteRuns(), 2);
});

test('a dirty working tree or a push of a commit that is not HEAD is refused', (t) => {
  const r = setup(t);
  r.change('2');
  const stash = /commit or stash first; the checks run on the tree being pushed/;

  writeFileSync(join(r.work, 'untracked.txt'), 'u\n');
  let p = r.push(['origin', 'feat/y']);
  assert.notEqual(p.status, 0, p.out);
  assert.match(p.out, stash);
  rmSync(join(r.work, 'untracked.txt'));

  writeFileSync(join(r.work, 'x.txt'), 'edited, not committed\n');
  p = r.push(['origin', 'feat/y']);
  assert.notEqual(p.status, 0, p.out);
  assert.match(p.out, stash);
  r.git('checkout', '-q', '--', 'x.txt');

  r.git('checkout', '-q', 'main');
  p = r.push(['origin', 'feat/y']);
  assert.notEqual(p.status, 0, p.out);
  assert.match(p.out, /is not HEAD/);
  assert.match(p.out, stash);

  assert.equal(r.remoteHead('feat/y'), null);
  assert.deepEqual(r.ranges(), []);
  assert.equal(r.suiteRuns(), 0);

  // clean, with the pushed commit checked out, the same push goes through
  r.git('checkout', '-q', 'feat/y');
  p = r.push(['origin', 'feat/y']);
  assert.equal(p.status, 0, p.out);
  assert.equal(r.remoteHead('feat/y'), r.head());
});

test('without gh or SAKK_PR_BASE the base falls back to main and says so', (t) => {
  const r = setup(t);
  const PATH = [...new Set([dirname(process.execPath), dirname(NPM)])].join(delimiter);
  assert.equal(which('gh', PATH), undefined, `gh is on ${PATH}; this test needs a PATH without it`);
  // npm finds `sh` on PATH; name it, since /bin can hold gh (usrmerge: /bin → /usr/bin)
  const env = { ...r.env, PATH, npm_config_script_shell: '/bin/sh' };
  delete env.SAKK_PR_BASE;
  r.change('2');
  const p = r.push(['origin', 'feat/y'], env);
  assert.equal(p.status, 0, p.out);
  assert.match(p.out, /base branch main \(fallback: [^)]*gh is not installed\)/);
  assert.deepEqual(r.ranges(), [{ args: ['--range', 'origin/main'], branch: 'feat/y' }]);
  assert.equal(r.suiteRuns(), 1);
});

test('a push while another heavy run holds the machine-wide lock is refused before the suite runs, and the suite runs in the lock otherwise (F-220)', (t) => {
  const r = setup(t);
  r.change('2');
  // a live run (this test process) holds the lock, as a drill or a gate would
  mkdirSync(r.lock);
  writeFileSync(join(r.lock, 'owner'), `${process.pid} 2026-10-29T00:00:00.000Z mutation drill\n`);
  let p = r.push(['origin', 'feat/y']);
  assert.notEqual(p.status, 0, p.out);
  assert.match(p.out, /heavy-lock: refused the pre-push suite/);
  assert.match(p.out, new RegExp(`mutation drill \\(pid ${process.pid}`));
  assert.equal(r.suiteRuns(), 0);
  assert.equal(r.remoteHead('feat/y'), null);
  // the refusal left the holder's lock in place
  assert.match(readFileSync(join(r.lock, 'owner'), 'utf8'), new RegExp(`^${process.pid} `));

  // once it is free, the suite runs holding the lock and the hook releases it
  rmSync(r.lock, { recursive: true, force: true });
  p = r.push(['origin', 'feat/y']);
  assert.equal(p.status, 0, p.out);
  assert.equal(r.suiteRuns(), 1);
  const [seen] = r.suiteLocks();
  assert.equal(seen.held, true);
  assert.match(String(seen.pid), /^[1-9]\d*$/);
  assert.notEqual(Number(seen.pid), process.pid);
  assert.equal(existsSync(r.lock), false);
  assert.equal(r.remoteHead('feat/y'), r.head());
});

test('deleting a remote branch runs nothing', (t) => {
  const r = setup(t);
  r.change('2');
  assert.equal(r.push(['origin', 'feat/y']).status, 0); // the hook is live here
  assert.equal(r.ranges().length, 1);
  assert.equal(r.suiteRuns(), 1);

  // anything that ran now would refuse: a dirty tree, a red checker, a red suite
  r.code('range', 1);
  r.code('suite', 1);
  writeFileSync(join(r.work, 'untracked.txt'), 'u\n');
  const p = r.push(['origin', '--delete', 'feat/y']);
  assert.equal(p.status, 0, p.out);
  assert.equal(r.remoteHead('feat/y'), null);
  assert.equal(r.ranges().length, 1);
  assert.equal(r.suiteRuns(), 1);
});
