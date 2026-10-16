import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Class detector for the fail-open-absence pattern (findings F-06, F-21, …):
 * an argument a command does not understand must refuse (exit 2), never be
 * ignored in favour of a default. Commands are discovered from `sakk
 * --help`, so a new command is covered the day it is documented.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAKK = join(ROOT, 'bin', 'sakk.mjs');
const run = (file, args, cwd) =>
  spawnSync(process.execPath, [file, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, SAKK_LEDGER_PATH: '' },
  });
const COMMANDS = [
  ...spawnSync(process.execPath, [SAKK, '--help'], { encoding: 'utf8' }).stdout.matchAll(
    /^ {2}sakk ([a-z]+)\b/gm,
  ),
].map((m) => m[1]);

describe('every CLI refuses what it does not understand', () => {
  test('sakk --help lists the commands this detector covers', () => {
    assert.ok(COMMANDS.length >= 8, COMMANDS.join());
  });
  for (const cmd of COMMANDS)
    test(`sakk ${cmd}: unknown flag, --flag=value and a repeated flag exit 2 and touch nothing`, () => {
      const cwd = mkdtempSync(join(tmpdir(), 'strict-'));
      for (const args of [
        ['--definitely-not-a-flag'],
        ['--ledger=x.json'],
        ['--ledger', 'a.json', '--ledger', 'b.json'],
      ]) {
        const r = run(SAKK, [cmd, ...args], cwd);
        assert.equal(r.status, 2, `${cmd} ${args.join(' ')}: ${r.stderr}`);
        assert.match(r.stderr, /USAGE_/);
      }
      assert.deepEqual(readdirSync(cwd), [], 'nothing was created');
    });
  test('gold-runner: unknown flag exits 2', () => {
    const r = run(join(ROOT, 'eval', 'bin', 'gold-runner.mjs'), ['--dry-run', '--packs', 'x']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /USAGE_UNKNOWN_ARGUMENT/);
  });
  test('evidence-bundle: an extra argument exits 2', () => {
    const d = mkdtempSync(join(tmpdir(), 'strict-'));
    const r = run(join(ROOT, 'scripts', 'evidence-bundle.mjs'), [
      d,
      '--to',
      join(d, 'b.tgz'),
      '--force',
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /USAGE_UNKNOWN_ARGUMENT/);
  });
});
