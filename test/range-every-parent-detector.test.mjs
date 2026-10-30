// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * F-221: the docs say the range check compares a merge commit with every parent, yet a checker
 * that compared it with its first parent only passed every test in test/range-topology.test.mjs.
 * This runs that file, as the tree has it, against a copy of the checker with exactly that bug
 * planted (it must go red) and against an unmutated copy (it must stay green).
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = 'scripts/findings-check.mjs';
const EVERY = 'for (const v of parents.flatMap(nearAt))';
const FIRST_ONLY = 'for (const v of parents.slice(0, 1).flatMap(nearAt))';
// the copy runs as its own test run, with no git or branch state from whoever started this one
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) =>
      k !== 'NODE_TEST_CONTEXT' &&
      k !== 'NODE_OPTIONS' &&
      k !== 'SAKK_BRANCH' &&
      !k.startsWith('GIT_'),
  ),
);

function rangeTestsOn(plant) {
  const dir = mkdtempSync(join(tmpdir(), 'sakk-every-parent-'));
  try {
    const gate = JSON.parse(readFileSync(join(ROOT, 'scripts', 'gate-files.json'), 'utf8')).files;
    for (const f of ['test/range-topology.test.mjs', 'scripts/gate-files.json', ...gate]) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      copyFileSync(join(ROOT, f), join(dir, f));
    }
    const src = readFileSync(join(dir, CHECKER), 'utf8');
    assert.equal(
      src.split(EVERY).length,
      2,
      `${CHECKER} no longer holds the every-parent line once`,
    );
    if (plant) writeFileSync(join(dir, CHECKER), src.replace(EVERY, FIRST_ONLY));
    const r = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', join(dir, 'test', 'range-topology.test.mjs')],
      { cwd: dir, encoding: 'utf8', env, timeout: 180_000 },
    );
    const count = (k) => Number(r.stdout.match(new RegExp(`^# ${k} (\\d+)`, 'm'))?.[1] ?? NaN);
    return { pass: count('pass'), fail: count('fail'), out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the range tests go red when the checker compares a merge commit with its first parent only (F-221)', () => {
  const planted = rangeTestsOn(true);
  // a file that fails to load, or runs no tests, is not a kill: the other range tests still pass
  assert.ok(planted.pass > 0, `the range tests did not run:\n${planted.out.slice(-1500)}`);
  assert.ok(
    planted.fail >= 1,
    `a first-parent-only checker passed every range test:\n${planted.out.slice(-1500)}`,
  );
});

test('an unmutated copy of the checker keeps the range tests green (control)', () => {
  const clean = rangeTestsOn(false);
  assert.ok(clean.pass > 0, `the range tests did not run:\n${clean.out.slice(-1500)}`);
  assert.equal(clean.fail, 0, clean.out.slice(-1500));
});
