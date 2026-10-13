import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reserve, settle } from '../src/ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'sakk.mjs');

const run = (args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SAKK_LEDGER_PATH: '', ...env },
  });

const tdir = () => mkdtempSync(join(tmpdir(), 'sakk-cli-'));

describe('sakk init', () => {
  test('creates a ledger at --ledger and refuses a second init', () => {
    const p = join(tdir(), 'l.json');
    const r1 = run(['init', '--cap', '25', '--ledger', p]);
    assert.equal(r1.status, 0, r1.stderr);
    assert.ok(existsSync(p));
    assert.match(r1.stdout, /ledger created/);
    const r2 = run(['init', '--cap', '25', '--ledger', p]);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /LEDGER_ALREADY_EXISTS/);
  });
  test('missing --cap is a usage error (exit 2)', () => {
    const r = run(['init', '--ledger', join(tdir(), 'l.json')]);
    assert.equal(r.status, 2);
  });
  test('resolves the path from SAKK_LEDGER_PATH when no flag is given', () => {
    const p = join(tdir(), 'env.json');
    const r = run(['init', '--cap', '5'], { SAKK_LEDGER_PATH: p });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(p));
  });
});

describe('sakk status', () => {
  test('missing ledger → LEDGER_MISSING, exit 1', () => {
    const r = run(['status', '--ledger', join(tdir(), 'nope.json')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /LEDGER_MISSING/);
  });
  test('--json reports totals that match the ledger', () => {
    const p = join(tdir(), 'l.json');
    run(['init', '--cap', '10', '--ledger', p]);
    reserve({ ledgerPath: p, callId: 'a', estimatedMaxUsd: 2 });
    settle({ ledgerPath: p, callId: 'a', actualUsd: 1.25 });
    reserve({ ledgerPath: p, callId: 'b', estimatedMaxUsd: 3 });
    const r = run(['status', '--json', '--ledger', p]);
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.cap_usd, 10);
    assert.equal(s.settled_usd, 1.25);
    assert.equal(s.outstanding_usd, 3);
    assert.equal(s.committed_usd, 4.25);
    assert.equal(s.remaining_usd, 5.75);
    assert.equal(s.entries.SETTLED, 1);
    assert.equal(s.entries.RESERVED, 1);
    assert.equal(s.reconciliation_required, false);
  });
  test('reconciliation-required ledger → exit 3 with the reason shown', () => {
    const p = join(tdir(), 'l.json');
    run(['init', '--cap', '10', '--ledger', p]);
    reserve({ ledgerPath: p, callId: 'x', estimatedMaxUsd: 2 });
    settle({ ledgerPath: p, callId: 'x', failedUnknownCost: true });
    const r = run(['status', '--ledger', p]);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /RECONCILIATION REQUIRED/);
  });
});

describe('sakk reconcile', () => {
  test('requires --by (exit 2); clears the flag with a signature', () => {
    const p = join(tdir(), 'l.json');
    run(['init', '--cap', '10', '--ledger', p]);
    reserve({ ledgerPath: p, callId: 'x', estimatedMaxUsd: 2 });
    settle({ ledgerPath: p, callId: 'x', failedUnknownCost: true });
    assert.equal(run(['reconcile', '--ledger', p]).status, 2);
    const r = run(['reconcile', '--by', 'maintainer', '--ledger', p]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(run(['status', '--ledger', p]).status, 0);
  });
});

describe('usage surface', () => {
  test('--help exits 0, unknown command exits 2, --version prints semver', () => {
    assert.equal(run(['--help']).status, 0);
    assert.equal(run(['frobnicate']).status, 2);
    assert.match(run(['--version']).stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});
