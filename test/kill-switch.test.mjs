import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initLedger,
  reserve,
  settle,
  readLedger,
  halt,
  resume,
  markReconciliationRequired,
  clearReconciliation,
  LedgerError,
} from '../src/ledger.mjs';

/** One test per row of the specs/kill-switch adversary table. */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'sakk.mjs');
const fresh = (cap = 100) => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'ks-')), 'l.json');
  initLedger({ ledgerPath, capUsd: cap });
  return ledgerPath;
};
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof LedgerError, e.message);
    return e.code;
  }
  return null;
};
const alerts = (ledgerPath) =>
  readFileSync(join(dirname(ledgerPath), 'sakk-alerts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

describe('row 1: a global halt refuses every reservation, and logs each attempt', () => {
  test('50 retries after the halt → 50 LEDGER_HALTED, zero new entries, 50 HALT_REFUSED alerts', () => {
    const lp = fresh();
    reserve({ ledgerPath: lp, callId: 'before', estimatedMaxUsd: 1 });
    halt({ ledgerPath: lp, by: 'maintainer', reason: 'runaway' });
    for (let i = 0; i < 50; i++)
      assert.equal(
        code(() => reserve({ ledgerPath: lp, callId: `r${i}`, estimatedMaxUsd: 0.1 })),
        'LEDGER_HALTED',
      );
    assert.equal(readLedger({ ledgerPath: lp }).entries.length, 1);
    assert.equal(alerts(lp).filter((a) => a.kind === 'HALT_REFUSED').length, 50);
  });
});

describe('row 2: a per-agent halt stops that agent only', () => {
  test('halted agent refuses AGENT_HALTED; other agents and anonymous callers proceed', () => {
    const lp = fresh();
    halt({ ledgerPath: lp, by: 'maintainer', agentId: 'bot-7' });
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'a', estimatedMaxUsd: 1, agentId: 'bot-7' })),
      'AGENT_HALTED',
    );
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'b', estimatedMaxUsd: 1, agentId: 'bot-8' })),
      null,
    );
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'c', estimatedMaxUsd: 1 })),
      null,
    );
  });
});

describe('row 3: no ordinary money path can lift a halt', () => {
  test('settle, unknown-cost settle, markReconciliationRequired and clearReconciliation all leave the halt intact', () => {
    const lp = fresh();
    reserve({ ledgerPath: lp, callId: 'x', estimatedMaxUsd: 1 });
    reserve({ ledgerPath: lp, callId: 'y', estimatedMaxUsd: 1 });
    halt({ ledgerPath: lp, by: 'maintainer' });
    settle({ ledgerPath: lp, callId: 'x', actualUsd: 0.5 }); // in-flight calls still settle honestly
    settle({ ledgerPath: lp, callId: 'y', failedUnknownCost: true }); // rewrites flags wholesale
    settle({ ledgerPath: lp, callId: 'y', actualUsd: 0.2 });
    markReconciliationRequired({ ledgerPath: lp, reason: 'invoice mismatch' });
    clearReconciliation({ ledgerPath: lp, by: 'maintainer' });
    assert.equal(
      readLedger({ ledgerPath: lp }).halt.global.by,
      'maintainer',
      'halt survived every flags rewrite',
    );
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'z', estimatedMaxUsd: 1 })),
      'LEDGER_HALTED',
    );
  });
});

describe('row 4: a stop is never blocked by the conditions it exists for', () => {
  test('a STALE ledger can be halted', () => {
    const lp = fresh();
    const doc = JSON.parse(readFileSync(lp, 'utf8'));
    doc.updatedAt = new Date(Date.now() - 365 * 864e5).toISOString();
    writeFileSync(lp, JSON.stringify(doc));
    assert.equal(
      code(() => halt({ ledgerPath: lp, by: 'maintainer' })),
      null,
    );
    assert.ok(readLedger({ ledgerPath: lp, maxAgeMs: Infinity }).halt.global);
  });
  test('a ledger in RECONCILIATION can be halted', () => {
    const lp = fresh();
    markReconciliationRequired({ ledgerPath: lp, reason: 'r' });
    assert.equal(
      code(() => halt({ ledgerPath: lp, by: 'maintainer' })),
      null,
    );
  });
});

describe('row 5: halting wins a lock storm', () => {
  test('CLI halt succeeds while 6 processes hammer the ledger', async () => {
    const lp = fresh(1e6);
    const worker = `
      import { reserve } from ${JSON.stringify(new URL('../src/ledger.mjs', import.meta.url).href)};
      for (let i = 0; i < 1e9; i++) {
        try { reserve({ ledgerPath: ${JSON.stringify(lp)}, callId: process.pid + '-' + i, estimatedMaxUsd: 0.01 }); }
        catch (e) { if (e.code === 'LEDGER_HALTED') process.exit(0); }
      }`;
    const kids = Array.from({ length: 6 }, () =>
      spawn(process.execPath, ['--input-type=module', '-e', worker], { stdio: 'ignore' }),
    );
    await new Promise((r) => setTimeout(r, 400));
    const h = spawnSync(process.execPath, [CLI, 'halt', '--by', 'maintainer', '--ledger', lp], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    const exits = await Promise.all(
      kids.map((k) => new Promise((r) => (k.exitCode !== null ? r(k.exitCode) : k.on('exit', r)))),
    );
    assert.equal(h.status, 0, h.stderr);
    assert.deepEqual(exits, [0, 0, 0, 0, 0, 0], 'every worker saw LEDGER_HALTED and stopped');
    const n = readLedger({ ledgerPath: lp }).entries.length;
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'late', estimatedMaxUsd: 0.01 })),
      'LEDGER_HALTED',
    );
    assert.equal(readLedger({ ledgerPath: lp }).entries.length, n, 'nothing booked after the halt');
  });
});

describe('row 6: a malformed halt record never reads as "not halted"', () => {
  test('garbage halt shapes refuse LEDGER_SCHEMA_INVALID', () => {
    for (const bad of [
      'yes',
      null,
      { global: true, agents: {} },
      { global: { by: '', at: new Date().toISOString(), reason: '' }, agents: {} },
      { global: null, agents: { x: 'halted' } },
      { global: null },
      { global: null, agents: {}, extra: 1 },
    ]) {
      const lp = fresh();
      const doc = JSON.parse(readFileSync(lp, 'utf8'));
      doc.halt = bad;
      writeFileSync(lp, JSON.stringify(doc));
      assert.equal(
        code(() => readLedger({ ledgerPath: lp })),
        'LEDGER_SCHEMA_INVALID',
        JSON.stringify(bad),
      );
      assert.equal(
        code(() => reserve({ ledgerPath: lp, callId: 'x', estimatedMaxUsd: 1 })),
        'LEDGER_SCHEMA_INVALID',
      );
    }
  });
  test('genesis ledgers (no halt key) stay readable and spendable', () => {
    const lp = fresh();
    assert.equal('halt' in JSON.parse(readFileSync(lp, 'utf8')), false);
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'g', estimatedMaxUsd: 1 })),
      null,
    );
  });
});

describe('row 8: after halt() returns, no reserve can succeed', () => {
  test('halt and reserve serialize on the same lock — no interleaving gets through', () => {
    const lp = fresh();
    halt({ ledgerPath: lp, by: 'maintainer' });
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'after', estimatedMaxUsd: 1 })),
      'LEDGER_HALTED',
    );
  });
});

describe('row 9 + record semantics', () => {
  test('signatures are required for both directions', () => {
    const lp = fresh();
    assert.equal(
      code(() => halt({ ledgerPath: lp })),
      'HALT_BY_REQUIRED',
    );
    assert.equal(
      code(() => resume({ ledgerPath: lp })),
      'RESUME_BY_REQUIRED',
    );
  });
  test('resume when nothing is halted says so; resume lifts and spending works again', () => {
    const lp = fresh();
    assert.equal(resume({ ledgerPath: lp, by: 'maintainer' }).wasHalted, false);
    halt({ ledgerPath: lp, by: 'maintainer' });
    assert.equal(resume({ ledgerPath: lp, by: 'ann' }).wasHalted, true);
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'ok', estimatedMaxUsd: 1 })),
      null,
    );
    const kinds = alerts(lp).map((a) => a.kind);
    assert.deepEqual(
      kinds.filter((k) => k.startsWith('HALT_')),
      ['HALT_SET', 'HALT_CLEARED'],
    );
  });
  test('first halt wins: a second halt keeps the original record', () => {
    const lp = fresh();
    halt({ ledgerPath: lp, by: 'first', reason: 'a' });
    const r = halt({ ledgerPath: lp, by: 'second', reason: 'b' });
    assert.equal(r.alreadyHalted, true);
    assert.equal(readLedger({ ledgerPath: lp }).halt.global.by, 'first');
  });
  test('CLI status exits 4 while globally halted and shows who stopped it', () => {
    const lp = fresh();
    halt({ ledgerPath: lp, by: 'maintainer', reason: 'incident 42' });
    const r = spawnSync(process.execPath, [CLI, 'status', '--ledger', lp], { encoding: 'utf8' });
    assert.equal(r.status, 4);
    assert.match(r.stdout, /HALTED by maintainer .*incident 42/);
    const j = JSON.parse(
      spawnSync(process.execPath, [CLI, 'status', '--json', '--ledger', lp], { encoding: 'utf8' })
        .stdout,
    );
    assert.equal(j.halted.by, 'maintainer');
  });
});
