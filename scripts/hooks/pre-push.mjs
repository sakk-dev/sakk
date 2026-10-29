#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// git pre-push: what CI would refuse, refused before the push leaves.
//
//   1. the self-evolution range check, run exactly as the CI job runs it,
//      against the pull request's base;
//   2. the full suite (`npm test`), once per tree: a tree that passed once is
//      not run again (marker in <git common dir>/sakk-tested/<tree>).
//
// Both run on the working tree, so the pushed commit must be HEAD and the
// tree must be clean. A delete runs nothing. There is no switch that skips
// the checks: `git push --no-verify` exists, and the edit hook flags it.
//
// git passes `<remote-name> <remote-url>` as arguments and one line per ref
// on stdin: `<local ref> <local sha> <remote ref> <remote sha>`.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const GH_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 60_000;
const ZERO = /^0+$/;
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

const say = (m) => process.stderr.write(`pre-push: ${m}\n`);
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const top = run('git', ['rev-parse', '--show-toplevel']);
const ROOT = top.status === 0 ? top.stdout.trim() : process.cwd();
const git = (...a) => {
  const r = run('git', a, { cwd: ROOT });
  return r.status === 0 ? r.stdout.trim() : null;
};
const remote = process.argv[2];

const lines = readFileSync(0, 'utf8')
  .split('\n')
  .map((l) => l.trim().split(/\s+/))
  .filter((f) => f.length === 4);

// The pull request's base: SAKK_PR_BASE, else gh, else main — and say which.
function baseFor(branch) {
  if (process.env.SAKK_PR_BASE) return { base: process.env.SAKK_PR_BASE, from: 'SAKK_PR_BASE' };
  let why;
  if (!branch) why = 'no branch name to ask gh about';
  else {
    const r = run('gh', ['pr', 'view', branch, '--json', 'baseRefName', '-q', '.baseRefName'], {
      cwd: ROOT,
      timeout: GH_TIMEOUT_MS,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    });
    const out = (r.stdout ?? '').trim();
    if (r.error?.code === 'ENOENT') why = 'gh is not installed';
    else if (r.error?.code === 'ETIMEDOUT')
      why = `gh did not answer within ${GH_TIMEOUT_MS / 1000} s`;
    else if (r.error) why = `gh did not run (${r.error.code})`;
    else if (r.status !== 0 || !out) why = `gh gave no pull request base for ${branch}`;
    else return { base: out, from: `gh pr view ${branch}` };
  }
  return { base: 'main', from: `fallback: SAKK_PR_BASE is unset and ${why}` };
}

function checkRef(localRef, sha) {
  if (ZERO.test(sha)) return true; // a delete: nothing is pushed, nothing to check
  const commit = git('rev-parse', '--verify', '-q', `${sha}^{commit}`);
  const head = git('rev-parse', '--verify', '-q', 'HEAD^{commit}');
  if (!commit || commit !== head) {
    say(
      `refused ${localRef}: ${sha.slice(0, 12)} is not HEAD — check it out, or commit or ` +
        `stash first; the checks run on the tree being pushed`,
    );
    return false;
  }
  const dirty = git('--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal');
  if (dirty !== '') {
    say(
      `refused ${localRef}: ${dirty === null ? 'git status failed' : 'the working tree has uncommitted or untracked changes'} — ` +
        `commit or stash first; the checks run on the tree being pushed`,
    );
    return false;
  }

  const branch = localRef.startsWith('refs/heads/')
    ? localRef.slice('refs/heads/'.length)
    : git('symbolic-ref', '-q', '--short', 'HEAD');
  const { base, from } = baseFor(branch);
  say(`base branch ${base} (${from})`);
  if (!BRANCH_NAME.test(base)) {
    say(`refused ${localRef}: base "${base}" is not a branch name`);
    return false;
  }

  const fetch = run('git', ['fetch', '-q', '--', remote, base], {
    cwd: ROOT,
    timeout: FETCH_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (fetch.status !== 0)
    say(
      `warning: git fetch ${remote} ${base} failed (${fetch.error?.code ?? `exit ${fetch.status}`}); ` +
        `using the ${remote}/${base} already here`,
    );
  if (!git('rev-parse', '--verify', '-q', `refs/remotes/${remote}/${base}^{commit}`)) {
    say(
      `refused ${localRef}: refs/remotes/${remote}/${base} does not exist, so there is no ` +
        `range to check — run: git fetch ${remote} ${base}`,
    );
    return false;
  }

  // the range check, as the CI job `self-evolution` runs it
  const range = spawnSync(
    process.execPath,
    ['scripts/findings-check.mjs', '--range', `${remote}/${base}`],
    {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ...(branch ? { SAKK_BRANCH: branch } : {}) },
    },
  );
  if (range.status !== 0) {
    say(
      `refused ${localRef}: the self-evolution range check against ${remote}/${base} is red — ` +
        `run: SAKK_BRANCH=${branch ?? '<branch>'} node scripts/findings-check.mjs --range ${remote}/${base}`,
    );
    return false;
  }

  // the full suite, once per tree
  const tree = git('rev-parse', `${sha}^{tree}`);
  const common = git('rev-parse', '--git-common-dir');
  if (!tree || !common) {
    say(`refused ${localRef}: git could not name the tree being pushed`);
    return false;
  }
  const dir = join(resolve(ROOT, common), 'sakk-tested');
  const marker = join(dir, tree);
  if (existsSync(marker)) {
    say(`tree ${tree.slice(0, 12)} already passed the full suite; not running npm test again`);
    return true;
  }
  say(`running the full suite (npm test) on tree ${tree.slice(0, 12)}`);
  const t = spawnSync('npm', ['test'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  if (t.status !== 0) {
    const how = t.error ? t.error.code : t.signal ? `signal ${t.signal}` : `exit ${t.status}`;
    say(
      `refused ${localRef}: the full suite failed on this tree (${how}) — fix it, commit, push again`,
    );
    return false;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, `${new Date().toISOString()} ${commit} ${branch ?? ''}\n`);
  return true;
}

let ok = true;
for (const [localRef, sha] of lines) ok = checkRef(localRef, sha) && ok;
process.exit(ok ? 0 : 1);
