import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The DCO check CI runs on every pull request commit (CONTRIBUTING.md). Each
 * case makes real commits in a throwaway repository and runs the real script
 * over them, so a pass is the script reading git, not a parser fed a string.
 */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dco-check.mjs');
const AUTHOR = 'A Dev';
const EMAIL = 'dev@example.com';

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'sakk-dco-'));
  const git = (...a) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd: d, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', AUTHOR);
  git('config', 'user.email', EMAIL);
  let n = 0;
  /** One commit; returns its sha. */
  const commit = (message, ...flags) => {
    writeFileSync(join(d, `f${n++}.txt`), String(n));
    git('add', '-A');
    git('commit', '-q', ...flags, '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const base = commit('base, before the range');
  return { d, git, commit, base, done: () => rmSync(d, { recursive: true, force: true }) };
}

const run = (cwd, ...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });

describe('DCO check (scripts/dco-check.mjs)', () => {
  test('every commit signed off by its author passes', () => {
    const r = repo();
    try {
      r.commit('feat: one', '-s');
      // the trailer written by hand, the email in another case: still the author
      r.commit(`fix: two\n\nSigned-off-by: ${AUTHOR} <DEV@Example.COM>`);
      r.commit('docs: three\r\n\r\nSigned-off-by: A Dev <dev@example.com>\r\n');
      const out = run(r.d, '--range', `${r.base}..HEAD`);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /3 commit\(s\) signed off by their authors/);
    } finally {
      r.done();
    }
  });

  test('an unsigned commit, or one signed off by someone else, fails and is named', () => {
    const r = repo();
    try {
      const good = r.commit('feat: signed off', '-s');
      const bare = r.commit('fix: no trailer at all');
      const other = r.commit('fix: someone else\n\nSigned-off-by: Other <other@example.com>');
      const mention = r.commit('docs: mentions Signed-off-by: in prose, not as a trailer line');
      const out = run(r.d, '--range', `${r.base}..HEAD`);
      assert.equal(out.status, 1, out.stdout + out.stderr);
      assert.match(out.stderr, /3 of 4 commit\(s\) lack a sign-off by their author/);
      const line = (sha) => out.stderr.split('\n').find((l) => l.includes(sha.slice(0, 12))) ?? '';
      assert.match(line(bare), /no trailer at all — no Signed-off-by trailer/);
      assert.match(
        line(other),
        /signed off by <other@example\.com>, not by its author <dev@example\.com>/,
      );
      assert.match(line(mention), /no Signed-off-by trailer/);
      assert.equal(line(good), '', 'a signed-off commit was named');
      // acting on the printed fix makes it pass
      assert.match(out.stderr, new RegExp(`fix: git rebase --signoff ${r.base}`));
      r.git('rebase', '-q', '--signoff', r.base);
      const after = run(r.d, '--range', `${r.base}..HEAD`);
      // `other` now has the author's sign-off beside the other one
      assert.equal(after.status, 0, after.stderr);
    } finally {
      r.done();
    }
  });

  test('a merge commit is skipped, an empty or unknown range refuses', () => {
    const r = repo();
    try {
      const main = r.git('rev-parse', '--abbrev-ref', 'HEAD');
      r.git('checkout', '-q', '-b', 'side');
      r.commit('feat: on the side', '-s');
      r.git('checkout', '-q', main);
      r.commit('feat: on main', '-s');
      r.git('merge', '-q', '--no-ff', '-m', 'merge side, with no sign-off', 'side');
      const merged = run(r.d, '--range', `${r.base}..HEAD`);
      assert.equal(merged.status, 0, merged.stderr);
      assert.match(
        merged.stdout,
        /2 commit\(s\) signed off by their authors \(1 merge commit skipped\)/,
      );

      const cannot = (range, why) => {
        const out = range === undefined ? run(r.d) : run(r.d, '--range', range);
        assert.equal(out.status, 2, `${range}: ${out.stdout}${out.stderr}`);
        assert.match(out.stderr, why, String(range));
      };
      cannot('HEAD..HEAD', /holds no commit/);
      cannot(`no-such-ref..HEAD`, /unknown revision: no-such-ref/);
      cannot(`${r.base}..no-such-ref`, /unknown revision: no-such-ref/);
      cannot('--output=/tmp/x..HEAD', /not a <base>\.\.<head> range/);
      cannot(`${r.base}...HEAD`, /not a <base>\.\.<head> range/);
      cannot('HEAD', /not a <base>\.\.<head> range/);
      cannot(undefined, /usage/);
      // outside a repository it cannot check, and says so rather than passing
      const bare = mkdtempSync(join(tmpdir(), 'sakk-dco-none-'));
      try {
        const out = run(bare, '--range', 'a..b');
        assert.equal(out.status, 2, out.stdout + out.stderr);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    } finally {
      r.done();
    }
  });
});
