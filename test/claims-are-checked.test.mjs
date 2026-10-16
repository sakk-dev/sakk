import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Class detector for findings RC-10 / fail-open-absence (findings/ledger.json):
 * what the project claims must be backed by something that runs.
 *  1. every refusal code a source file can emit is asserted by some test
 *     (AGENTS.md "every refusal path needs a negative test", mechanized);
 *  2. every code the user-facing docs name exists in the code;
 *  3. no test run and no CI job can hang instead of failing.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set([
  'node_modules',
  '.git',
  'fixtures',
  'gold',
  'fake',
  'packs',
  'cases',
  'schemas',
]);
const walk = (d) =>
  readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (SKIP.has(e.name) ? [] : walk(join(d, e.name))) : [join(d, e.name)],
  );
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

const SOURCES = [
  ...walk('src'),
  ...walk('bin'),
  ...walk('eval/lib'),
  ...walk('eval/bin'),
  'scripts/evidence-bundle.mjs',
  'scripts/gate-certificate.mjs',
].filter((f) => f.endsWith('.mjs'));
const TESTS = [...walk('test'), ...walk('eval/__tests__')]
  .filter((f) => f.endsWith('.mjs'))
  .map(read)
  .join('\n');
const EMIT =
  /(?:Error\(\s*|bad\(\s*|gap\(\s*|fail\(\s*|usage\(\s*|code:\s*)['`]([A-Z][A-Z0-9_]{3,}[A-Za-z0-9_]*)/g;

/**
 * Codes on purely defensive paths that no input can reach without a broken
 * dependency. Each entry needs its reason; adding one is a reviewed choice.
 */
const DEFENSIVE = {
  SCAN_FAILED: 'git produced output the scanner cannot parse, or an unexpected I/O error',
  VERIFIER_ERROR: 'a bug inside the verifier itself (it must still fail closed)',
};

describe('claims are checked', () => {
  test('every refusal code a source can emit is asserted by at least one test', () => {
    const untested = [];
    for (const f of SOURCES)
      for (const m of read(f).matchAll(EMIT))
        if (!Object.hasOwn(DEFENSIVE, m[1]) && !TESTS.includes(m[1]))
          untested.push(`${m[1]} (${f})`);
    assert.deepEqual(
      [...new Set(untested)],
      [],
      'write the negative test, or justify it in DEFENSIVE',
    );
  });
  test('every DEFENSIVE entry is still emitted somewhere (no stale exemptions)', () => {
    const all = SOURCES.map(read).join('\n');
    for (const code of Object.keys(DEFENSIVE)) assert.ok(all.includes(`'${code}'`), code);
  });
  test('every code the user-facing docs name exists in the code', () => {
    const code = [...walk('src'), ...walk('bin'), ...walk('eval'), ...walk('scripts')]
      .filter((f) => /\.(mjs|sh)$/.test(f))
      .map(read)
      .join('\n');
    const missing = [];
    for (const doc of ['README.md', 'docs/AUDITOR_REPLAY.md', 'eval/README.md', 'SECURITY.md'])
      for (const m of read(doc).matchAll(/`([A-Z][A-Z0-9_]{5,})`/g))
        if (!code.includes(m[1])) missing.push(`${doc}: ${m[1]}`);
    assert.deepEqual([...new Set(missing)], []);
  });
});

describe('nothing hangs instead of failing (findings F-15)', () => {
  test('every node --test script carries --test-timeout', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    for (const [name, cmd] of Object.entries(scripts))
      if (cmd.includes('node --test')) assert.match(cmd, /--test-timeout=\d+/, name);
  });
  test('the commit gate passes exit codes straight through', () => {
    const gate = read('scripts/gate.sh');
    assert.match(gate, /set -euo pipefail/);
    assert.doesNotMatch(
      gate,
      /\|\s*(tail|grep|head)\b/,
      'no pipe may sit between a check and its exit code',
    );
    for (const step of ['lint', 'format:check', 'test', 'test:eval'])
      assert.match(gate, new RegExp(`npm run --silent ${step}\\b`), step);
  });
  test('every CI job has timeout-minutes', () => {
    const ci = read('.github/workflows/ci.yml');
    const jobs = [...ci.matchAll(/^ {2}([a-z][\w-]*):\n/gm)].map((m) => m[1]);
    assert.ok(jobs.length >= 3, jobs.join());
    for (const job of jobs) {
      const body = ci.slice(ci.indexOf(`  ${job}:\n`)).split(/\n {2}[a-z][\w-]*:\n/)[0];
      assert.match(body, /timeout-minutes:\s*\d+/, job);
    }
  });
});
