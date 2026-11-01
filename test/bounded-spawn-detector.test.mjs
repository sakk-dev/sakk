// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * F-215: the C-04 detector in test/bounded-spawn.test.mjs matched only the literal
 * `node --test`, so a launch with another --import first went unseen and the check
 * passed on zero launches. This runs that detector, as the tree has it, on a copy whose
 * package.json launches tests that way: once without the bound (it must go red) and
 * once with it (it must stay green).
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'every node --test run loads the bound';
// the detector runs as its own test run, not a subtest of this one
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT' && k !== 'NODE_OPTIONS'),
);

function detectorOn(launch) {
  const dir = mkdtempSync(join(tmpdir(), 'sakk-detector-'));
  try {
    for (const d of ['test', 'scripts/hooks', '.github/workflows'])
      mkdirSync(join(dir, d), { recursive: true });
    copyFileSync(
      join(ROOT, 'test', 'bounded-spawn.test.mjs'),
      join(dir, 'test', 'bounded-spawn.test.mjs'),
    );
    const scripts = {
      test: launch('test/*.test.mjs'),
      'test:a': launch('a.test.mjs'),
      'test:b': launch('b.test.mjs'),
    };
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts }, null, 2));
    const r = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-reporter=tap',
        `--test-name-pattern=${NAME}`,
        join(dir, 'test', 'bounded-spawn.test.mjs'),
      ],
      { cwd: dir, encoding: 'utf8', env, timeout: 60_000 },
    );
    const count = (k) => Number(r.stdout.match(new RegExp(`^# ${k} (\\d+)`, 'm'))?.[1] ?? NaN);
    return { pass: count('pass'), fail: count('fail'), out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the bounded-spawn detector sees a launch with another --import first (F-215)', () => {
  const missing = detectorOn((files) => `node --import ./test/clean-git-env.mjs --test ${files}`);
  assert.equal(
    missing.fail,
    1,
    `a launch without the bound passed the detector:\n${missing.out.slice(-1500)}`,
  );
  // control: the same launch form with the bound is not refused
  const bounded = detectorOn(
    (files) =>
      `node --import ./test/clean-git-env.mjs --test --import ./test/bounded-spawn.mjs ${files}`,
  );
  assert.deepEqual([bounded.pass, bounded.fail], [1, 0], bounded.out.slice(-1500));
});
