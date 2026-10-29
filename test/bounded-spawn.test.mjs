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
  test('every node --test run loads the bound, whatever flags come first (F-215)', () => {
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
    // a launch is any `node … --test …` up to the next shell separator, whatever flags
    // come before --test: matching the literal `node --test` found nothing once a
    // launch put another --import first, and the check then passed on zero launches (F-215)
    const launches = places.flatMap(([where, text]) =>
      (text.match(/\bnode\b[^\n&|;'"]*?\s--test\b[^\n&|;'"]*/g) ?? []).map((l) => [where, l]),
    );
    assert.ok(launches.length >= 3, `only ${launches.length} node --test launches found`);
    const missing = launches
      .filter(([, l]) => !l.includes(`--import ${PRELOAD}`))
      .map(([where, l]) => `${where}: ${l.trim()}`);
    assert.deepEqual(missing, [], `add --import ${PRELOAD} to each`);
  });
  test('every non-test script that spawns node --test bounds it with a timeout (F-157)', () => {
    // scripts spawn node --test with an argv array (not a shell string), so they
    // carry the bound as a spawn `timeout`, not the --import preload; test files
    // are excluded because the preload above already bounds their spawns
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')) files.push(rel);
      }
    };
    walk('scripts');
    walk('eval');
    // the text of a spawnSync/execFileSync call, by balanced parentheses
    const calls = (text) => {
      const out = [];
      for (const m of text.matchAll(/\b(?:spawnSync|execFileSync)\(/g)) {
        let depth = 0;
        let i = m.index + m[0].length - 1;
        for (; i < text.length; i++) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')' && --depth === 0) break;
        }
        out.push(text.slice(m.index, i + 1));
      }
      return out;
    };
    const unbounded = [];
    for (const rel of files)
      for (const call of calls(readFileSync(join(ROOT, rel), 'utf8')))
        if (/['"]--test['"]/.test(call) && !/\btimeout\b/.test(call)) unbounded.push(rel);
    assert.deepEqual([...new Set(unbounded)], [], 'give the spawnSync a timeout option');
  });
  for (const [name, call] of [
    ['spawnSync', 'cp.spawnSync(...forever)'],
    ['spawnSync with options but no timeout', "cp.spawnSync(...forever, { encoding: 'utf8' })"],
    ['execFileSync', 'cp.execFileSync(...forever)'],
    ['execSync', `cp.execSync(\`"\${process.execPath}" -e "setInterval(() => {}, 1000)"\`)`],
    // an explicit nullish options slot must still be bounded, not appended past (F-157)
    ['spawnSync with explicit undefined options', 'cp.spawnSync(...forever, undefined)'],
    ['spawnSync with explicit null options', 'cp.spawnSync(forever[0], forever[1], null)'],
    ['execFileSync with explicit undefined options', 'cp.execFileSync(...forever, undefined)'],
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
