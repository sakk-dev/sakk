// SPDX-License-Identifier: Apache-2.0
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hookMod from '../src/hook.mjs';

const { runHook } = hookMod;

/**
 * Other spellings of the same act (F-183, F-184, F-186): a name in another
 * case, a flag git accepts in a shorter or clustered form, a path reached
 * through a symbolic link. Each is judged as the act it spells. The hook runs
 * in process, as `sakk hook` runs it, against a throwaway project and HOME.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !k.startsWith('GIT_') && k !== 'NODE_TEST_CONTEXT' && k !== 'SAKK_LEDGER_PATH',
  ),
);

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'guard-')));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(repo, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.env'), 'TOKEN=not-a-real-secret\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: ENV });
  const env = { ...ENV, HOME: home, SAKK_HOME: join(home, '.sakk') };
  return { base, repo, home, env, sakkHome: join(home, '.sakk') };
}

/** The verdict and reason Claude Code reads from the hook's answer. */
function judge(w, tool_name, tool_input) {
  const out = runHook(
    'claude-code',
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name,
      tool_input,
      cwd: w.repo,
      session_id: 's1',
      tool_use_id: 't-spell',
    }),
    { env: w.env, log: false },
  );
  if (out === '') return { v: 'allow', why: '' };
  const h = JSON.parse(out).hookSpecificOutput;
  return { v: h.permissionDecision, why: h.permissionDecisionReason };
}
const sh = (w, command) => judge(w, 'Bash', { command });
const write = (w, file_path) => judge(w, 'Write', { file_path, content: 'x\n' });

describe('a protected name spelled in another case (F-183)', () => {
  test('F-183 a protected name spelled in another case is judged as the protected name, by every rule kind', () => {
    const w = world();
    // the lower-case folders are never created: on a case-insensitive volume an
    // existing folder would hand back its own spelling and hide the bug
    for (const p of ['.CLAUDE/settings.json', '.Sakk/policy.json', '.GITHUB/workflows/ci.yml'])
      assert.equal(write(w, join(w.repo, p)).v, 'deny', `Write ${p}`);
    assert.equal(write(w, join(w.home, '.CLAUDE', 'settings.json')).v, 'deny', 'Write ~/.CLAUDE');
    assert.equal(sh(w, 'rm -f MIGRATIONS/x.sql').v, 'deny', 'rm MIGRATIONS/x.sql');
    assert.equal(sh(w, 'echo x > .Codex/hooks.json').v, 'deny', 'redirect into .Codex');
    // the decision names the protected scope it judged, not only the alias
    assert.match(
      write(w, join(w.repo, '.CLAUDE', 'settings.json')).why,
      /\.claude\/settings\.json/,
    );
    // control: an ordinary upper-case name in the project stays allowed
    assert.equal(write(w, join(w.repo, 'README.md')).v, 'allow');
    assert.equal(write(w, join(w.repo, 'Src', 'B.js')).v, 'allow');
  });

  test('F-183 every shipped deny and ask scope gives the same answer in upper case, enumerated from the policy file', () => {
    const w = world();
    const policy = JSON.parse(readFileSync(join(ROOT, 'policies', 'guard-default.json'), 'utf8'));
    const where = (prefix) => {
      if (prefix.startsWith('~protected/')) return null; // a delete's container, not a path
      if (prefix.startsWith('~home/')) return [w.home, prefix.slice('~home/'.length)];
      if (prefix.startsWith('~sakk/')) return [w.sakkHome, prefix.slice('~sakk/'.length)];
      if (prefix.startsWith('~outside/')) return ['/', prefix.slice('~outside/'.length)];
      return [w.repo, prefix];
    };
    let checked = 0;
    for (const rule of policy.rules) {
      if (rule.verdict === 'allow' || !rule.match.scope) continue;
      for (const prefix of rule.match.scope) {
        const at = where(prefix);
        if (at === null) continue;
        const [base, rest] = at;
        const lower = join(base, `${rest}probe`);
        const upper = join(base, `${rest}probe`.toUpperCase());
        const ask = (p) =>
          rule.match.action === 'file.write' ? write(w, p).v : sh(w, `rm -f '${p}'`).v;
        const want = ask(lower);
        assert.notEqual(want, 'allow', `${rule.id} ${prefix}: the lower-case path is guarded`);
        assert.equal(ask(upper), want, `${rule.id} ${prefix} in upper case: ${upper}`);
        checked++;
      }
    }
    assert.ok(checked >= 15, `enumerated ${checked} shipped scopes`);
  });

  test('F-183 a command, wrapper or git subcommand spelled in another case is judged as the lower-case command', () => {
    const w = world();
    const pairs = [
      ['rm -rf ~', 'RM -rf ~'],
      ['sudo rm -rf ~', 'SUDO rm -rf ~'],
      ['env X=1 rm -rf ~', 'ENV X=1 rm -rf ~'],
      ['timeout 5 rm -rf ~', 'TIMEOUT 5 rm -rf ~'],
      ['find ~ -exec rm -rf {} +', 'find ~ -exec RM -rf {} +'],
      ['git push --force origin main', 'GIT push --force origin main'],
      ['git push --force origin main', 'git PUSH --force origin main'],
      ['git reset --hard HEAD~1', 'git reset --HARD HEAD~1'],
      ['cat .env', 'CAT .env'],
    ];
    for (const [lower, upper] of pairs) {
      const want = sh(w, lower).v;
      assert.notEqual(want, 'allow', `${lower} is guarded`);
      assert.equal(sh(w, upper).v, want, upper);
    }
    // control: an upper-case program that is not a guarded command stays allowed
    assert.equal(sh(w, 'LS -la').v, 'allow');
    assert.equal(sh(w, 'echo RM -rf ~').v, 'allow');
  });
});

describe('every spelling git accepts for a destructive flag (F-184)', () => {
  const GIT_ENV = (w) => ({
    ...w.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    MANPAGER: 'cat',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  /** A project with one commit and a local bare remote, so git can parse each spelling for real. */
  function gitWorld() {
    const w = world();
    const remote = join(w.base, 'remote.git');
    const env = GIT_ENV(w);
    const git = (args, cwd = w.repo) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.test',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd, env, stdio: 'pipe' },
      );
    git(['init', '-q', '--bare', remote], w.base);
    git(['add', 'src/a.js']);
    git(['commit', '-q', '-m', 'one']);
    git(['remote', 'add', 'origin', remote]);
    return { ...w, gitEnv: env };
  }
  /** Does the installed git parse this spelling? 129 is git's usage error. */
  const accepts = (w, args) =>
    spawnSync('git', args, { cwd: w.repo, env: w.gitEnv, stdio: 'pipe', timeout: 10000 }).status !==
    129;
  const prefixes = (word) =>
    Array.from({ length: word.length }, (_, i) => `--${word.slice(0, i + 1)}`);

  const FLAGS = {
    push: {
      long: ['force', 'force-with-lease', 'force-if-includes', 'mirror', 'delete', 'prune'],
      short: ['-f', '-d', '-fu', '-uf', '-nf', '-vf', '-qf'],
      parses: (s) => ['push', '--dry-run', s, 'origin', 'main'],
      hook: (s) => `git push ${s} origin main`,
    },
    reset: {
      long: ['hard', 'merge', 'keep'],
      short: [],
      parses: (s) => ['reset', s, 'HEAD'],
      hook: (s) => `git reset ${s} HEAD~1`,
    },
    clean: {
      long: ['force'],
      short: ['-f', '-fd', '-fdx', '-dfx', '-xf'],
      parses: (s) => ['clean', s, '-n'],
      hook: (s) => `git clean ${s}`,
    },
    branch: {
      long: ['delete'],
      short: ['-D', '-d', '-vD', '-dv', '-Dv', '-df'],
      parses: (s) => ['branch', s, 'nosuch'],
      hook: (s) => `git branch ${s} main`,
    },
  };

  test('F-184 every spelling git accepts for a destructive flag is denied: short clusters and long prefixes', () => {
    const w = gitWorld();
    const missed = [];
    let measured = 0;
    for (const [sub, f] of Object.entries(FLAGS)) {
      const spellings = [...new Set([...f.long.flatMap(prefixes), ...f.short])];
      for (const s of spellings) {
        if (!accepts(w, f.parses(s))) continue; // git refuses it, so it is no bypass
        measured++;
        const got = sh(w, f.hook(s)).v;
        if (got !== 'deny') missed.push(`${f.hook(s)} -> ${got}`);
      }
      assert.ok(measured > 0, `git accepted some spelling for ${sub}`);
    }
    assert.deepEqual(missed, [], `${measured} spellings git accepts`);
    // the audit's own spelling, judged whether or not this git calls it ambiguous
    assert.equal(sh(w, 'git push --forc origin main').v, 'deny');
    // an alias defined on the command line can rename any subcommand
    assert.notEqual(sh(w, 'git -c alias.y=push y --force origin main').v, 'allow');
    assert.notEqual(sh(w, 'git --config-env=alias.y=X y --force origin main').v, 'allow');
  });

  test('F-184 control: neighbouring flags that are not destructive keep their old answer', () => {
    const w = gitWorld();
    for (const cmd of [
      'git push -u origin main',
      'git push --follow-tags origin main',
      'git push --set-upstream origin main',
      'git push --dry-run origin main',
      'git push --no-verify origin main',
      'git push --tags origin',
      'git push origin main',
      'git reset --soft HEAD~1',
      'git reset --mixed HEAD',
      'git branch -v',
      'git branch -d feature',
      'git clean -n',
      'git -c core.pager=cat log -1',
      'git status',
    ])
      assert.equal(sh(w, cmd).v, 'allow', cmd);
  });
});

describe('a path reached through a symbolic link (F-186)', () => {
  test('F-186 a read through a symlink to a secret file is denied, by every tool and route', () => {
    const w = world();
    symlinkSync(join(w.repo, '.env'), join(w.repo, 'notes.txt'));
    symlinkSync('.env', join(w.repo, 'rel.txt')); // a relative target too
    for (const [what, got] of [
      ['cat notes.txt', sh(w, 'cat notes.txt')],
      ['head notes.txt', sh(w, 'head -n 1 notes.txt')],
      ['grep TOKEN rel.txt', sh(w, 'grep TOKEN rel.txt')],
      ['Read notes.txt', judge(w, 'Read', { file_path: join(w.repo, 'notes.txt') })],
      ['Grep notes.txt', judge(w, 'Grep', { pattern: 'TOKEN', path: join(w.repo, 'notes.txt') })],
    ]) {
      assert.equal(got.v, 'deny', what);
      assert.match(got.why, /secret\.read/, what);
    }
    // control: a link to an ordinary file reads as that file
    symlinkSync(join(w.repo, 'src', 'a.js'), join(w.repo, 'plain.txt'));
    assert.equal(sh(w, 'cat plain.txt').v, 'allow');
    assert.equal(judge(w, 'Read', { file_path: join(w.repo, 'plain.txt') }).v, 'allow');
  });

  test('F-186 a write or delete through a dangling symlink is judged by where the link points', () => {
    const w = world();
    // links to folders that do not exist yet: the write creates them
    symlinkSync(join(w.repo, '.claude'), join(w.repo, 'd'));
    assert.equal(write(w, join(w.repo, 'd', 'settings.json')).v, 'deny', 'Write d/settings.json');
    assert.equal(sh(w, 'echo x > d/settings.json').v, 'deny', 'redirect into d/');
    assert.equal(sh(w, 'rm -f d/settings.json').v, 'deny', 'rm d/settings.json');
    symlinkSync(join(w.repo, '.sakk'), join(w.repo, 's'));
    assert.equal(write(w, join(w.repo, 's', 'policy.json')).v, 'deny', 'Write s/policy.json');
    symlinkSync(join(w.home, '.claude'), join(w.repo, 'h'));
    assert.equal(write(w, join(w.repo, 'h', 'settings.json')).v, 'deny', 'Write h -> ~/.claude');
    // a link to a file that does not exist yet, in a folder that does
    mkdirSync(join(w.repo, '.github', 'workflows'), { recursive: true });
    symlinkSync(join(w.repo, '.github', 'workflows', 'ci.yml'), join(w.repo, 'f'));
    assert.equal(write(w, join(w.repo, 'f')).v, 'deny', 'Write f -> .github/workflows/ci.yml');
    // control: a dangling link to an ordinary place in the project stays allowed
    symlinkSync(join(w.repo, 'build'), join(w.repo, 'out'));
    assert.equal(write(w, join(w.repo, 'out', 'x.js')).v, 'allow');
  });

  test('F-186 a symlink loop stops at the hop bound instead of being followed forever', () => {
    const w = world();
    symlinkSync('b', join(w.repo, 'a'));
    symlinkSync('a', join(w.repo, 'b'));
    for (const [what, got] of [
      ['Write a/x', write(w, join(w.repo, 'a', 'x'))],
      ['Read a', judge(w, 'Read', { file_path: join(w.repo, 'a') })],
      ['cat a/x', sh(w, 'cat a/x')],
    ]) {
      assert.equal(got.v, 'deny', what);
      assert.match(got.why, /HOOK_PATH_UNREADABLE/, what);
    }
  });
});
