import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Class detector for C-04 on the test harness (F-143): every synchronous
 * child a test starts is bounded, because `--test-timeout` cannot fire while
 * a synchronous child blocks the event loop.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = './test/bounded-spawn.mjs';

/** A child that never ends, started without a timeout under the preload; prints the signal it got. */
const hang = (call) =>
  spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(join(ROOT, 'test', 'bounded-spawn.mjs')).href,
      '--input-type=module',
      '-e',
      `import * as cp from 'node:child_process';
       const forever = [process.execPath, ['-e', 'setInterval(() => {}, 1000)']];
       try { const r = ${call}; console.log(r?.signal ?? r?.error?.code ?? 'returned'); }
       catch (e) { console.log(e.signal ?? e.code); }`,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, SAKK_TEST_SPAWN_TIMEOUT_MS: '300' },
      timeout: 60_000,
    },
  );

describe('C-04: every synchronous child a test starts is bounded (F-143)', () => {
  test('every node --test run loads the bound', () => {
    const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const places = [
      ...Object.entries(scripts).map(([name, cmd]) => [`npm run ${name}`, cmd]),
      ...['scripts/hooks', '.github/workflows'].flatMap((dir) =>
        readdirSync(join(ROOT, dir)).map((f) => [
          `${dir}/${f}`,
          readFileSync(join(ROOT, dir, f), 'utf8'),
        ]),
      ),
    ];
    const missing = places.flatMap(([where, text]) =>
      text
        .split(/&&|\n/)
        .filter((part) => /\bnode --test\b/.test(part) && !part.includes(`--import ${PRELOAD}`))
        .map((part) => `${where}: ${part.trim()}`),
    );
    assert.deepEqual(missing, [], `add --import ${PRELOAD} to each`);
  });
  for (const [name, call] of [
    ['spawnSync', 'cp.spawnSync(...forever)'],
    ['spawnSync with options but no timeout', "cp.spawnSync(...forever, { encoding: 'utf8' })"],
    ['execFileSync', 'cp.execFileSync(...forever)'],
    ['execSync', `cp.execSync(\`"\${process.execPath}" -e "setInterval(() => {}, 1000)"\`)`],
  ])
    test(`${name} without a timeout is killed by the default bound`, () => {
      const r = hang(call);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), 'SIGKILL');
      assert.match(r.stderr, /bounded-spawn: .* killed after 300 ms \(F-143\)/);
    });
  test('a timeout the test sets is kept', () => {
    const r = hang("cp.spawnSync(...forever, { timeout: 200, killSignal: 'SIGTERM' })");
    assert.equal(r.stdout.trim(), 'SIGTERM');
    assert.doesNotMatch(r.stderr, /bounded-spawn/);
  });
});
