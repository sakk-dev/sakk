// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * F-165: a spend test passed only on the day its fixtures were stamped, because the
 * code under test read the real clock. This runs the whole spend suite with the clock
 * moved 400 days ahead, in every test process: a test whose fixtures carry a date must
 * also fix the clock the code reads, or it goes red here.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AHEAD_MS = 400 * 86_400_000;
const SHIFT = `const RealDate = Date;
class AheadDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [RealDate.now() + ${AHEAD_MS}])); }
  static now() { return RealDate.now() + ${AHEAD_MS}; }
}
globalThis.Date = AheadDate;
`;

test('the spend suite passes with the clock 400 days past its fixtures (F-165)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sakk-clock-'));
  try {
    const shift = join(dir, 'ahead.mjs');
    writeFileSync(shift, SHIFT);
    // NODE_OPTIONS reaches every process the runner starts, not only this child
    // and the child runs its own test run, not a subtest of this one
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')),
      NODE_OPTIONS: `--import ${pathToFileURL(shift).href}`,
    };
    const bound = join(ROOT, 'test', 'bounded-spawn.mjs');
    // control: the moved clock really reaches a child process
    const probe = spawnSync(
      process.execPath,
      ['-e', 'console.log(Date.now(), new Date().getTime())'],
      {
        encoding: 'utf8',
        env,
        timeout: 30_000,
      },
    );
    const [now, made] = probe.stdout.trim().split(' ').map(Number);
    assert.ok(
      now - Date.now() > AHEAD_MS - 60_000,
      `the clock did not move: ${probe.stdout}${probe.stderr}`,
    );
    assert.ok(made - Date.now() > AHEAD_MS - 60_000, 'new Date() did not move with Date.now()');
    const r = spawnSync(
      process.execPath,
      [
        ...(existsSync(bound) ? ['--import', pathToFileURL(bound).href] : []),
        '--test',
        '--test-reporter=tap',
        join(ROOT, 'test', 'spend.test.mjs'),
      ],
      { cwd: ROOT, encoding: 'utf8', env, timeout: 240_000 },
    );
    const failed = r.stdout.split('\n').filter((l) => /^\s*not ok /.test(l));
    assert.equal(
      r.status,
      0,
      `failing a year ahead:\n${failed.join('\n')}\n${r.stderr.slice(-2000)}`,
    );
    assert.match(r.stdout, /^# pass [1-9]/m, 'no spend test ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
