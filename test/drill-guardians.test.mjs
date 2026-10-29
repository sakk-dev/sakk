import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardianCommand, DrillSelectionError } from '../scripts/drill-guardians.mjs';

/**
 * Findings F-219: the mutation drill reran a whole suite per mutant, so its
 * CI time grew as mutants x suite (18 min at 26 mutants, 52-61 min at 40).
 * Each mutant now runs only the files that hold its named test. These tests
 * hold the selection to three things: every mutant's test is found, the
 * command is the suite's own with only the glob narrowed, and a test no file
 * holds refuses instead of passing.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRILL = readFileSync(join(ROOT, 'scripts', 'mutation-drill.sh'), 'utf8');

// Every `run_drill MUT-X <file> \` call with its quoted arguments; the
// count is checked against a plain line count so a call the parser misses
// fails here instead of going unchecked.
function drillCalls() {
  const calls = [];
  const call = /^run_drill (MUT-[A-Z]+) (\S+) \\\n([\s\S]*?)(?=\n\n|\n#)/gm;
  for (const [, id, file, body] of DRILL.matchAll(call)) {
    const args = [...body.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(([, dq, sq]) =>
      dq !== undefined ? dq.replace(/\\([$`"\\])/g, '$1') : sq,
    );
    calls.push({ id, file, named: args[2], suite: args[3] ?? 'test:eval' });
  }
  return calls;
}

function plant(files) {
  const dir = mkdtempSync(join(tmpdir(), 'drill-guardians-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

describe('the mutation drill runs each mutant against its guardian files (F-219)', () => {
  test("every mutant's named test is found in a file its suite runs", () => {
    const calls = drillCalls();
    const lines = (DRILL.match(/^run_drill MUT-/gm) ?? []).length;
    assert.ok(lines >= 30, `found only ${lines} mutants — the count is broken`);
    assert.equal(calls.length, lines, 'a run_drill call was not parsed');
    for (const c of calls) {
      assert.ok(['test', 'test:eval'].includes(c.suite), `${c.id}: unknown suite ${c.suite}`);
      const { files, command } = guardianCommand(ROOT, c.suite, c.named);
      assert.ok(files.length > 0, c.id);
      for (const f of files)
        assert.ok(readFileSync(join(ROOT, f), 'utf8').includes(c.named), `${c.id}: ${f}`);
      assert.doesNotMatch(command, /\*\.test\.mjs/, `${c.id} still runs a whole suite`);
    }
  });

  test("a mutant runs only its guardian files, through the suite's own command", () => {
    const dir = plant({
      'package.json': JSON.stringify({
        scripts: { t: 'node pre.mjs && node --import ./x.mjs --test --flag=1 spec/*.test.mjs' },
      }),
      'spec/a.test.mjs': "test('alpha holds', () => {});",
      'spec/b.test.mjs': "test('beta holds', () => {});",
      'spec/c.test.mjs': "// alpha holds is mentioned here too\ntest('gamma', () => {});",
      'spec/alpha holds.txt': 'alpha holds',
    });
    try {
      const got = guardianCommand(dir, 't', 'alpha holds');
      assert.deepEqual(got.files, ['spec/a.test.mjs', 'spec/c.test.mjs']);
      assert.equal(
        got.command,
        'node pre.mjs && node --import ./x.mjs --test --flag=1 spec/a.test.mjs spec/c.test.mjs',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // the drill itself: selection per mutant, the whole of test:all only for the control
    const start = DRILL.indexOf('run_drill() {');
    const body = DRILL.slice(start, DRILL.indexOf('\n}\n', start));
    assert.ok(start > 0 && body.length > 200, 'run_drill() not found');
    assert.match(body, /scripts\/drill-guardians\.mjs" "\$dir" "\$ts" "\$named"/);
    assert.match(body, /DRILL BROKEN: \$cmd/);
    assert.doesNotMatch(body, /npm run/, 'a mutant reruns a whole npm suite again');
    assert.match(DRILL, /^out="\$\(cd "\$dir" && npm run --silent test:all 2>&1\)"$/m);
  });

  test('a named test found in no file refuses, and a suite without one glob refuses', () => {
    const dir = plant({
      'package.json': JSON.stringify({
        scripts: {
          one: 'node --test spec/*.test.mjs',
          none: 'node --test spec/a.test.mjs',
          two: 'node --test spec/*.test.mjs more/*.test.mjs',
        },
      }),
      'spec/a.test.mjs': "test('alpha holds', () => {});",
      'more/b.test.mjs': "test('beta holds', () => {});",
    });
    try {
      const refuses = (script, named, why) =>
        assert.throws(() => guardianCommand(dir, script, named), DrillSelectionError, why);
      refuses('one', 'no such test', 'a name no file holds');
      refuses('one', '', 'an empty name matches every file');
      refuses('one', '   ', 'a blank name');
      refuses('one', undefined, 'a missing name');
      refuses('missing', 'alpha holds', 'a script package.json lacks');
      refuses('none', 'alpha holds', 'a script without a glob');
      refuses('two', 'alpha holds', 'a script with two globs');
      const cli = spawnSync(
        process.execPath,
        [join(ROOT, 'scripts', 'drill-guardians.mjs'), dir, 'one', 'no such test'],
        { encoding: 'utf8' },
      );
      assert.equal(cli.status, 2);
      assert.equal(cli.stdout, '');
      assert.match(cli.stderr, /no file in spec\/\*\.test\.mjs contains the test "no such test"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
