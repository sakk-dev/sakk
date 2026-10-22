#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Proof that a fix's guard test guards the bug (R7, docs/SELF_EVOLUTION.md).
// For every finding this range fixed, its guard test must FAIL on the base
// (the code before the fix, with the new test file copied in) and PASS at
// HEAD — the FAIL_TO_PASS rule SWE-bench uses to validate a fix. A guard
// that already passes before the fix proves nothing about it.
//
//   node scripts/findings-proof.mjs --range <base-ref>
//
// Exit 0 every fix proven, 1 a guard did not prove its fix, 2 usage or setup.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TEST_PATH, findRoot } from './findings-lib.mjs';

const args = process.argv.slice(2);
if (args[0] !== '--range' || !args[1]) {
  console.error('usage: findings-proof --range <base-ref>');
  process.exit(2);
}
const base = args[1];
const root = findRoot(process.cwd());
if (!root) {
  console.error('findings-proof: no findings/classes.json above the current directory');
  process.exit(2);
}
// a git hook's GIT_* and an outer test runner's NODE_TEST_CONTEXT / NODE_OPTIONS
// would change what the child git and the child test run see
const ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !k.startsWith('GIT_') && k !== 'NODE_TEST_CONTEXT' && k !== 'NODE_OPTIONS',
  ),
);
const git = (...a) =>
  execFileSync('git', a, {
    cwd: root,
    encoding: 'utf8',
    env: ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const at = (rev, f) => {
  try {
    return JSON.parse(git('show', `${rev}:${f}`));
  } catch {
    return null;
  }
};
const before = new Map((at(base, 'findings/ledger.json')?.findings ?? []).map((f) => [f.id, f]));
const now = at('HEAD', 'findings/ledger.json')?.findings ?? [];
const CLOSED = ['fixed', 'verified', 'class_closed'];
const revs = new Set(git('rev-list', `${base}..HEAD`).split('\n').filter(Boolean));
// a bug introduced in this range lives in new code, whose test may need that code
// to load; a bug in code that existed before needs its guard to fail by assertion
const inRange = (f) =>
  f.introduced_in === 'worktree' ||
  (/^[0-9a-f]{7,40}$/.test(f.introduced_in ?? '') &&
    [...revs].some((r) => r.startsWith(f.introduced_in)));
// fixed in this range: new and closed, or open at the base and closed now
const fixed = now.filter(
  (f) => CLOSED.includes(f.status) && (!before.has(f.id) || before.get(f.id).status === 'open'),
);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Run one named test; returns {code, ran, output}. `ran` counts tests that executed. */
function runTest(cwd, file, name) {
  const r = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=tap',
      `--test-name-pattern=${escape(name)}`,
      '--test-timeout=120000',
      file,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...ENV, CI: 'true' },
      maxBuffer: 64 * 1024 * 1024,
      // a hung child blocks this script; --test-timeout cannot interrupt it (F-143)
      timeout: 300_000,
      killSignal: 'SIGKILL',
    },
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0);
  const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? 0);
  // did the named test itself run and fail, or did the file not even load?
  const lines = out.split('\n');
  const named = (verdict) =>
    lines.some((l) => new RegExp(`^\\s*${verdict} \\d+ - `).test(l) && l.includes(name));
  return {
    code: r.status,
    ran: pass + fail,
    fail,
    output: out,
    failedItself: named('not ok'),
    passedItself: named('ok'),
  };
}

const problems = [];
const proven = [];
const weak = [];
let tree = null;
try {
  for (const f of fixed) {
    const g = String(f.guard ?? '');
    const i = g.indexOf('::');
    const file = i < 0 ? g : g.slice(0, i);
    const name = i < 0 ? '' : g.slice(i + 2);
    if (!name || !TEST_PATH.test(file)) {
      problems.push(
        `${f.id}: its guard (${g || 'none'}) is not a test, so the fix cannot be proven — name the test that fails without the fix`,
      );
      continue;
    }
    const after = runTest(root, file, name);
    if (after.ran === 0) {
      problems.push(`${f.id}: no test named "${name}" ran in ${file} at HEAD`);
      continue;
    }
    if (after.code !== 0) {
      problems.push(`${f.id}: its guard fails at HEAD — the fix is not in`);
      continue;
    }
    if (tree === null) {
      tree = mkdtempSync(join(tmpdir(), 'findings-proof-'));
      git('worktree', 'add', '--detach', '-f', tree, base);
    }
    mkdirSync(join(tree, dirname(file)), { recursive: true });
    copyFileSync(join(root, file), join(tree, file)); // the new test against the old code
    const prior = runTest(tree, file, name);
    git('-C', tree, 'checkout', '-q', '--', '.'); // the next finding starts from the clean base
    if (prior.code === 0 && prior.fail === 0)
      problems.push(
        `${f.id}: its guard "${name}" already passes on ${base}, before the fix — it does not guard this bug. Name a test that fails without the fix.`,
      );
    else if (prior.failedItself)
      proven.push(`${f.id}: the guard runs and fails before the fix, passes after`);
    else {
      // the test needs code the fix added: red before, but not by its own assertion
      if (!inRange(f))
        problems.push(
          `${f.id}: its guard cannot even load on ${base} (it imports code the fix added), so it shows nothing about the old code. The bug predates this range (introduced_in ${f.introduced_in}): name a guard that runs on the old code and fails by its own assertion — e.g. drive the command, not the new function.`,
        );
      else
        proven.push(
          `${f.id}: the guard cannot load before the fix (it needs new code, introduced in this range), passes after`,
        );
      weak.push(f.id);
    }
  }
} finally {
  if (tree !== null) {
    try {
      git('worktree', 'remove', '--force', tree);
    } catch {
      rmSync(tree, { recursive: true, force: true });
    }
  }
}
for (const p of proven) console.log(`proof: ${p}`);
if (problems.length) {
  console.error(problems.map((p) => `self-evolution: ${p}`).join('\n'));
  process.exit(1);
}
console.log(
  `findings-proof: ${fixed.length} fix(es) in this range, each guard red before and green after; ${fixed.length - weak.length} by their own assertion, ${weak.length} because the test needs the new code (${weak.join(', ') || 'none'})`,
);
