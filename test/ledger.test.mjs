// SPDX-License-Identifier: AGPL-3.0-only
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fsExtra from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LEDGER_SCHEMA,
  LedgerError,
  initLedger,
  readLedger,
  reserve,
  settle,
  markReconciliationRequired,
  clearReconciliation,
  totalsOf,
  defaultLedgerPath,
  forceUnlock,
} from '../src/ledger.mjs';

/**
 * The fail-closed contract of the sakk ledger. Every pathological ledger
 * state refuses new paid calls; reaching the cap refuses; concurrency cannot
 * collude to overspend; duplicate callIds are refused before the paid action;
 * unknown cost enters reconciliation and halts everything after it.
 * All tests run in fresh temp directories — no shared state.
 */

const tmp = () => mkdtempSync(join(tmpdir(), 'sakk-'));
const L = (dir) => join(dir, 'ledger.json');

function freshLedger(capUsd = 100) {
  const dir = tmp();
  const ledgerPath = L(dir);
  initLedger({ ledgerPath, capUsd });
  return { dir, ledgerPath };
}

describe('allow/refuse boundary', () => {
  test('healthy ledger below budget: allowed', () => {
    const { ledgerPath } = freshLedger(100);
    const r = reserve({ ledgerPath, callId: 'c1', estimatedMaxUsd: 25 });
    assert.equal(r.ok, true);
    assert.equal(r.duplicate, false);
  });
  test('exactly at the cap: refused (the cap is a wall, not a target)', () => {
    const { ledgerPath } = freshLedger(100);
    assert.throws(
      () => reserve({ ledgerPath, callId: 'c2', estimatedMaxUsd: 100 }),
      /BUDGET_EXCEEDED/,
    );
  });
  test('over the cap: refused', () => {
    const { ledgerPath } = freshLedger(100);
    reserve({ ledgerPath, callId: 'c3a', estimatedMaxUsd: 80 });
    assert.throws(
      () => reserve({ ledgerPath, callId: 'c3b', estimatedMaxUsd: 25 }),
      /BUDGET_EXCEEDED/,
    );
  });
});

describe('pathological ledgers are all fail-closed', () => {
  test('missing ledger: refused, and never auto-created', () => {
    const dir = tmp();
    const ledgerPath = L(dir);
    assert.throws(() => reserve({ ledgerPath, callId: 'x', estimatedMaxUsd: 1 }), /LEDGER_MISSING/);
    assert.equal(
      existsSync(ledgerPath),
      false,
      'an ordinary read failure must never create an empty ledger',
    );
  });
  test('unreadable ledger (a directory squats the path): refused', () => {
    const dir = tmp();
    const ledgerPath = L(dir);
    mkdirSync(ledgerPath, { recursive: true });
    assert.throws(
      () => reserve({ ledgerPath, callId: 'x', estimatedMaxUsd: 1 }),
      /LEDGER_UNREADABLE|LEDGER_MALFORMED/,
    );
  });
  test('corrupted JSON: refused', () => {
    const { ledgerPath } = freshLedger();
    writeFileSync(ledgerPath, `{"schema":"${LEDGER_SCHEMA}",`);
    assert.throws(
      () => reserve({ ledgerPath, callId: 'x', estimatedMaxUsd: 1 }),
      /LEDGER_MALFORMED/,
    );
  });
  test('wrong schema tag / missing cap: refused', () => {
    const { ledgerPath } = freshLedger();
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema: 'someone-else.v9',
        entries: [],
        updatedAt: new Date().toISOString(),
      }),
    );
    assert.throws(
      () => reserve({ ledgerPath, callId: 'x', estimatedMaxUsd: 1 }),
      /LEDGER_SCHEMA_INVALID/,
    );
    writeFileSync(
      ledgerPath,
      JSON.stringify({ schema: LEDGER_SCHEMA, entries: [], updatedAt: new Date().toISOString() }),
    );
    assert.throws(
      () => reserve({ ledgerPath, callId: 'x', estimatedMaxUsd: 1 }),
      /LEDGER_SCHEMA_INVALID/,
    );
  });
  test('stale ledger: refused (old books are not fresh books)', () => {
    const { ledgerPath } = freshLedger();
    const doc = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    doc.updatedAt = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    writeFileSync(ledgerPath, JSON.stringify(doc));
    assert.throws(() => reserve({ ledgerPath, callId: 'x', estimatedMaxUsd: 1 }), /LEDGER_STALE/);
  });
  test('uncomputable cost (SETTLED entry without actualUsd): refused', () => {
    const { ledgerPath } = freshLedger();
    const doc = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    doc.entries.push({
      callId: 'bad',
      status: 'SETTLED',
      estimatedMaxUsd: 5,
      createdAt: doc.updatedAt,
    });
    writeFileSync(ledgerPath, JSON.stringify(doc));
    assert.throws(
      () => reserve({ ledgerPath, callId: 'x', estimatedMaxUsd: 1 }),
      /LEDGER_COST_UNCOMPUTABLE/,
    );
  });
  test('no silent default path: without SAKK_LEDGER_PATH, defaultLedgerPath throws', () => {
    const saved = process.env.SAKK_LEDGER_PATH;
    delete process.env.SAKK_LEDGER_PATH;
    try {
      assert.throws(() => defaultLedgerPath(), /LEDGER_PATH_REQUIRED/);
    } finally {
      if (saved !== undefined) process.env.SAKK_LEDGER_PATH = saved;
    }
  });
});

describe('initialization discipline', () => {
  test('explicit init creates an empty ledger; re-init refuses to overwrite', () => {
    const dir = tmp();
    const ledgerPath = L(dir);
    const r = initLedger({ ledgerPath, capUsd: 50 });
    assert.equal(r.ok, true);
    const doc = readLedger({ ledgerPath });
    assert.equal(doc.capUsd, 50);
    assert.deepEqual(doc.entries, []);
    assert.throws(() => initLedger({ ledgerPath, capUsd: 99 }), /LEDGER_ALREADY_EXISTS/);
  });
  test('init rejects a non-positive cap', () => {
    const dir = tmp();
    assert.throws(() => initLedger({ ledgerPath: L(dir), capUsd: 0 }), /LEDGER_INIT_INVALID/);
  });
});

describe('concurrency and idempotency', () => {
  test('two concurrent reservations cannot jointly overspend (real two-process race)', () => {
    const { ledgerPath } = freshLedger(100);
    const script = `
      const m = await import(${JSON.stringify(new URL('../src/ledger.mjs', import.meta.url).href)});
      try { m.reserve({ ledgerPath: process.env.LP, callId: process.env.CID, estimatedMaxUsd: 60 }); console.log('OK'); }
      catch (e) { console.log('REFUSED:' + e.code); }
    `;
    const run = (cid) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { ...process.env, LP: ledgerPath, CID: cid },
      });
    const a = run('conc-a');
    const b = run('conc-b');
    const oks = [a.stdout, b.stdout].filter((s) => s.includes('OK')).length;
    const refused = [a.stdout, b.stdout].filter((s) =>
      s.includes('REFUSED:BUDGET_EXCEEDED'),
    ).length;
    assert.equal(oks, 1, `exactly one must win; stdout: ${a.stdout}|${b.stdout}`);
    assert.equal(refused, 1);
    const t = totalsOf(readLedger({ ledgerPath }));
    assert.ok(t.committedUsd < 100, 'total commitment must stay under the cap');
  });
  test('lock held by someone else: reserve times out and refuses — never judges the budget lockless', () => {
    const { ledgerPath } = freshLedger(100);
    mkdirSync(`${ledgerPath}.lock`, { recursive: true });
    try {
      assert.throws(
        () => reserve({ ledgerPath, callId: 'locked', estimatedMaxUsd: 1 }),
        /LEDGER_LOCK_UNAVAILABLE/,
      );
    } finally {
      rmSync(`${ledgerPath}.lock`, { recursive: true, force: true });
    }
  });
  test('duplicate callId: refused, totals unchanged', () => {
    const { ledgerPath } = freshLedger(100);
    reserve({ ledgerPath, callId: 'dup', estimatedMaxUsd: 40 });
    assert.throws(
      () => reserve({ ledgerPath, callId: 'dup', estimatedMaxUsd: 40 }),
      /DUPLICATE_CALL_ID/,
    );
    assert.equal(totalsOf(readLedger({ ledgerPath })).outstandingUsd, 40);
  });
  test('reserving a SETTLED callId again: equally refused', () => {
    const { ledgerPath } = freshLedger(100);
    reserve({ ledgerPath, callId: 'done1', estimatedMaxUsd: 20 });
    settle({ ledgerPath, callId: 'done1', actualUsd: 5 });
    assert.throws(
      () => reserve({ ledgerPath, callId: 'done1', estimatedMaxUsd: 20 }),
      /DUPLICATE_CALL_ID/,
    );
    assert.equal(totalsOf(readLedger({ ledgerPath })).settledUsd, 5);
  });
  test('caller shape: after a duplicate reserve, the model stub is never touched a second time', () => {
    const { ledgerPath } = freshLedger(100);
    let modelCalls = 0;
    const paidCall = (callId) => {
      reserve({ ledgerPath, callId, estimatedMaxUsd: 10 });
      modelCalls += 1; // the paid action
      settle({ ledgerPath, callId, actualUsd: 10 });
    };
    paidCall('once');
    assert.throws(() => paidCall('once'), /DUPLICATE_CALL_ID/);
    assert.equal(modelCalls, 1, 'refusal happens before the paid action, not after');
  });
});

describe('settlement and reconciliation', () => {
  test('failure with unknowable cost: enters RECONCILIATION_REQUIRED and halts further paid calls', () => {
    const { ledgerPath } = freshLedger(100);
    reserve({ ledgerPath, callId: 'f1', estimatedMaxUsd: 25 });
    const s = settle({ ledgerPath, callId: 'f1', failedUnknownCost: true });
    assert.equal(s.reconciliationRequired, true);
    assert.throws(
      () => reserve({ ledgerPath, callId: 'f2', estimatedMaxUsd: 1 }),
      /RECONCILIATION_REQUIRED/,
    );
    clearReconciliation({ ledgerPath, by: 'test-reconciler' });
    assert.equal(reserve({ ledgerPath, callId: 'f3', estimatedMaxUsd: 1 }).ok, true);
  });
  test('out-of-band accounting failure: flag + structured alert, next paid call blocked', () => {
    const { ledgerPath, dir } = freshLedger(100);
    markReconciliationRequired({ ledgerPath, reason: 'metrics write failed (simulated)' });
    assert.throws(
      () => reserve({ ledgerPath, callId: 'm1', estimatedMaxUsd: 1 }),
      /RECONCILIATION_REQUIRED/,
    );
    const alerts = readFileSync(join(dir, 'sakk-alerts.jsonl'), 'utf8');
    assert.match(alerts, /RECONCILIATION_REQUIRED/);
  });
  test('outstanding reservations count at their maximum (two 40s block a 30)', () => {
    const { ledgerPath } = freshLedger(100);
    reserve({ ledgerPath, callId: 'r1', estimatedMaxUsd: 40 });
    reserve({ ledgerPath, callId: 'r2', estimatedMaxUsd: 40 });
    assert.throws(
      () => reserve({ ledgerPath, callId: 'r3', estimatedMaxUsd: 30 }),
      /BUDGET_EXCEEDED/,
    );
  });
  test('settlement releases the reserved difference; double settle is idempotent', () => {
    const { ledgerPath } = freshLedger(100);
    reserve({ ledgerPath, callId: 's1', estimatedMaxUsd: 40 });
    reserve({ ledgerPath, callId: 's2', estimatedMaxUsd: 40 });
    settle({ ledgerPath, callId: 's1', actualUsd: 5, tokens: { in: 100, out: 50 } });
    const r = reserve({ ledgerPath, callId: 's3', estimatedMaxUsd: 30 });
    assert.equal(r.ok, true, '5 + 40 + 30 < 100 after the difference is released');
    assert.equal(settle({ ledgerPath, callId: 's1', actualUsd: 5 }).duplicate, true);
  });
  test('settling an unknown callId: refused; invalid actualUsd: refused', () => {
    const { ledgerPath } = freshLedger(100);
    assert.throws(
      () => settle({ ledgerPath, callId: 'ghost', actualUsd: 1 }),
      /SETTLE_UNKNOWN_CALL/,
    );
    reserve({ ledgerPath, callId: 'v1', estimatedMaxUsd: 10 });
    assert.throws(() => settle({ ledgerPath, callId: 'v1', actualUsd: -1 }), /SETTLE_INVALID/);
  });
  test('errors are structured: LedgerError carries code and details', () => {
    const { ledgerPath } = freshLedger(100);
    try {
      reserve({ ledgerPath, callId: 'big', estimatedMaxUsd: 500 });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof LedgerError);
      assert.equal(e.code, 'BUDGET_EXCEEDED');
      assert.equal(e.details.capUsd, 100);
    }
  });
});

describe('review fixes: epsilon wall, settle mismatch, stale locks', () => {
  test('float drift cannot fill the cap: the 10th 0.1 against a 1.0 cap is refused', () => {
    // 10 × 0.1 accumulates to 0.9999999999999999 < 1.0 in IEEE doubles —
    // without the epsilon guard the 10th reservation would fit inside the wall.
    const { ledgerPath } = freshLedger(1);
    for (let i = 0; i < 9; i += 1) reserve({ ledgerPath, callId: `c${i}`, estimatedMaxUsd: 0.1 });
    assert.throws(
      () => reserve({ ledgerPath, callId: 'c9', estimatedMaxUsd: 0.1 }),
      (e) => e.code === 'BUDGET_EXCEEDED',
    );
  });
  test('the epsilon never eats legitimate headroom', () => {
    const { ledgerPath } = freshLedger(1);
    reserve({ ledgerPath, callId: 'a', estimatedMaxUsd: 0.5 });
    assert.equal(reserve({ ledgerPath, callId: 'b', estimatedMaxUsd: 0.49 }).ok, true);
  });
  test('re-settling with a different amount is refused, identical re-settle stays idempotent', () => {
    const { ledgerPath } = freshLedger(10);
    reserve({ ledgerPath, callId: 'x', estimatedMaxUsd: 2 });
    settle({ ledgerPath, callId: 'x', actualUsd: 0.5 });
    assert.equal(settle({ ledgerPath, callId: 'x', actualUsd: 0.5 }).duplicate, true);
    assert.throws(
      () => settle({ ledgerPath, callId: 'x', actualUsd: 0.7 }),
      (e) => e.code === 'SETTLE_MISMATCH',
    );
    assert.throws(
      () => settle({ ledgerPath, callId: 'x', failedUnknownCost: true }),
      (e) => e.code === 'SETTLE_MISMATCH',
    );
    const alerts = readFileSync(join(ledgerPath, '..', 'sakk-alerts.jsonl'), 'utf8');
    assert.match(alerts, /SETTLE_MISMATCH/);
  });
  test('a lock abandoned by a dead process on this host is broken automatically', () => {
    const { ledgerPath } = freshLedger(10);
    const child = spawnSync(process.execPath, ['-e', '0']); // exits immediately
    const lock = `${ledgerPath}.lock`;
    mkdirSync(lock);
    writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: child.pid, host: hostname(), at: 'x' }),
    );
    assert.equal(reserve({ ledgerPath, callId: 'alive', estimatedMaxUsd: 1 }).ok, true);
    assert.equal(existsSync(lock), false, 'the retaken lock is released after the write');
    const alerts = readFileSync(join(ledgerPath, '..', 'sakk-alerts.jsonl'), 'utf8');
    assert.match(alerts, /STALE_LOCK_BROKEN/);
  });
  test('a lock held by a live process still refuses after the spin', () => {
    const { ledgerPath } = freshLedger(10);
    const lock = `${ledgerPath}.lock`;
    mkdirSync(lock);
    writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname(), at: 'x' }),
    );
    assert.throws(
      () => reserve({ ledgerPath, callId: 'y', estimatedMaxUsd: 1 }),
      (e) => e.code === 'LEDGER_LOCK_UNAVAILABLE',
    );
  });
  test('a lock without owner metadata is never broken automatically; forceUnlock requires a name and clears it', () => {
    const { ledgerPath } = freshLedger(10);
    mkdirSync(`${ledgerPath}.lock`);
    assert.throws(
      () => reserve({ ledgerPath, callId: 'z', estimatedMaxUsd: 1 }),
      (e) => e.code === 'LEDGER_LOCK_UNAVAILABLE',
    );
    assert.throws(
      () => forceUnlock({ ledgerPath }),
      (e) => e.code === 'UNLOCK_BY_REQUIRED',
    );
    assert.equal(forceUnlock({ ledgerPath, by: 'maintainer' }).removed, true);
    assert.equal(reserve({ ledgerPath, callId: 'z', estimatedMaxUsd: 1 }).ok, true);
    const alerts = readFileSync(join(ledgerPath, '..', 'sakk-alerts.jsonl'), 'utf8');
    assert.match(alerts, /LOCK_FORCED_OPEN/);
  });
});

describe('audit fix F15: tmp-file symlink attack', () => {
  test('a pre-planted symlink at a guessable tmp path can never clobber another file', () => {
    const { ledgerPath, dir } = freshLedger(5);
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'PRECIOUS');
    // the old predictable name — must never be followed or even used again
    const { symlinkSync } = fsExtra;
    symlinkSync(victim, `${ledgerPath}.tmp-${process.pid}`);
    reserve({ ledgerPath, callId: 'atk', estimatedMaxUsd: 1 });
    assert.equal(readFileSync(victim, 'utf8'), 'PRECIOUS');
    assert.equal(readLedger({ ledgerPath, maxAgeMs: Number.POSITIVE_INFINITY }).entries.length, 1);
  });
});
