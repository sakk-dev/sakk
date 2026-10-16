import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
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
  LEDGER_SCHEMA,
  LEDGER_SCHEMA_V2,
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
const onDisk = (ledgerPath) => JSON.parse(readFileSync(ledgerPath, 'utf8'));
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
  test('review S1: halting or resuming a STALE ledger never makes it fresh — a stop never reopens spending', () => {
    for (const ops of [
      (lp) => halt({ ledgerPath: lp, by: 'maintainer', agentId: 'bot' }),
      (lp) => {
        halt({ ledgerPath: lp, by: 'maintainer' });
        resume({ ledgerPath: lp, by: 'maintainer' });
      },
    ]) {
      const lp = fresh();
      const doc = onDisk(lp);
      doc.updatedAt = new Date(Date.now() - 365 * 864e5).toISOString();
      writeFileSync(lp, JSON.stringify(doc));
      assert.equal(
        code(() => reserve({ ledgerPath: lp, callId: 'c0', estimatedMaxUsd: 1 })),
        'LEDGER_STALE',
      );
      ops(lp);
      assert.equal(
        code(() => reserve({ ledgerPath: lp, callId: 'c1', estimatedMaxUsd: 1 })),
        'LEDGER_STALE',
      );
    }
  });
  test('review S4: a halt outranks reconciliation — LEDGER_HALTED, and the attempt is alerted', () => {
    const lp = fresh();
    markReconciliationRequired({ ledgerPath: lp, reason: 'r' });
    halt({ ledgerPath: lp, by: 'maintainer' });
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'c', estimatedMaxUsd: 1 })),
      'LEDGER_HALTED',
    );
    assert.equal(alerts(lp).filter((a) => a.kind === 'HALT_REFUSED').length, 1);
  });
});

describe('review S3: a resume lifts exactly its own scope', () => {
  const both = () => {
    const lp = fresh();
    halt({ ledgerPath: lp, by: 'maintainer' });
    halt({ ledgerPath: lp, by: 'maintainer', agentId: 'bot' });
    return lp;
  };
  test('a scoped resume leaves the global halt in force', () => {
    const lp = both();
    resume({ ledgerPath: lp, by: 'maintainer', agentId: 'bot' });
    assert.ok(onDisk(lp).halt.global, 'global halt survived');
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'c', estimatedMaxUsd: 1, agentId: 'bot' })),
      'LEDGER_HALTED',
    );
  });
  test('a global resume leaves every agent halt in force', () => {
    const lp = both();
    resume({ ledgerPath: lp, by: 'maintainer' });
    assert.ok(onDisk(lp).halt.agents.bot, 'agent halt survived');
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'c', estimatedMaxUsd: 1, agentId: 'bot' })),
      'AGENT_HALTED',
    );
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'd', estimatedMaxUsd: 1 })),
      null,
    );
  });
  test('a blank name cannot halt or resume (its record would fail its own read check)', () => {
    const lp = fresh();
    assert.equal(
      code(() => halt({ ledgerPath: lp, by: '  ' })),
      'HALT_BY_REQUIRED',
    );
    halt({ ledgerPath: lp, by: 'maintainer' });
    assert.equal(
      code(() => resume({ ledgerPath: lp, by: '\t' })),
      'RESUME_BY_REQUIRED',
    );
    assert.ok(onDisk(lp).halt.global);
  });
});

describe('row 5: halting wins a lock storm', () => {
  // Pass/fail is decided by order, never by a stopwatch (F-66): once the
  // CLI halt has RETURNED, a worker's next reserve must refuse — one that
  // still books is the bug (exit 5). The halt may take seconds under load
  // (the lock is not fair); the 120 s deadline only stops a broken build
  // (drill MUT-G) from hanging the suite.
  test('CLI halt succeeds while 6 processes hammer the ledger', { timeout: 180_000 }, async () => {
    const lp = fresh(1e6);
    const signal = `${lp}.halt-returned`;
    const worker = `
      import { existsSync } from 'node:fs';
      import { reserve } from ${JSON.stringify(new URL('../src/ledger.mjs', import.meta.url).href)};
      const until = Date.now() + 120_000;
      for (let i = 0; Date.now() < until; i++) {
        const after = existsSync(${JSON.stringify(signal)});
        try { reserve({ ledgerPath: ${JSON.stringify(lp)}, callId: process.pid + '-' + i, estimatedMaxUsd: 0.01 }); }
        catch (e) { if (e.code === 'LEDGER_HALTED') process.exit(0); continue; }
        if (after) process.exit(5);
      }
      process.exit(3);`;
    const kids = Array.from({ length: 6 }, () =>
      spawn(process.execPath, ['--input-type=module', '-e', worker], { stdio: 'ignore' }),
    );
    let exits;
    let h;
    try {
      await new Promise((r) => setTimeout(r, 400));
      h = spawnSync(process.execPath, [CLI, 'halt', '--by', 'maintainer', '--ledger', lp], {
        encoding: 'utf8',
        timeout: 120_000,
      });
      writeFileSync(signal, '');
      exits = await Promise.all(
        kids.map(
          (k) => new Promise((r) => (k.exitCode !== null ? r(k.exitCode) : k.on('exit', r))),
        ),
      );
    } finally {
      for (const k of kids) if (k.exitCode === null) k.kill('SIGKILL');
    }
    assert.equal(h.status, 0, h.stderr);
    assert.deepEqual(
      exits,
      [0, 0, 0, 0, 0, 0],
      'every worker saw LEDGER_HALTED; none booked after it',
    );
    const d = readLedger({ ledgerPath: lp });
    const booked = d.entries.filter((e) => Date.parse(e.createdAt) > Date.parse(d.halt.global.at));
    assert.equal(booked.length, 0, 'nothing booked after the halt record was written');
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'late', estimatedMaxUsd: 0.01 })),
      'LEDGER_HALTED',
    );
  });
});

describe('row 6: a malformed halt record never reads as "not halted"', () => {
  test('garbage halt shapes refuse LEDGER_SCHEMA_INVALID', () => {
    for (const bad of [
      'yes',
      null,
      // each shape carries every other part valid, so ITS defect is what refuses
      { global: true, agents: {}, lifts: [] },
      { global: { by: '', at: new Date().toISOString(), reason: '' }, agents: {}, lifts: [] },
      { global: { by: '  ', at: new Date().toISOString(), reason: '' }, agents: {}, lifts: [] },
      { global: null, agents: { x: 'halted' }, lifts: [] },
      {
        global: null,
        agents: { '': { by: 'r', at: new Date().toISOString(), reason: '' } },
        lifts: [],
      },
      { global: null, lifts: [] },
      { global: null, agents: {}, lifts: [], extra: 1 },
      { global: null, agents: {} }, // review S2: the lift history may not be deleted
      { global: null, agents: {}, lifts: [{ by: 'r' }] },
      { global: null, agents: {}, lifts: 'none' },
    ]) {
      const lp = fresh();
      const doc = JSON.parse(readFileSync(lp, 'utf8'));
      doc.schema = LEDGER_SCHEMA_V2; // v2, so the halt validator itself is what refuses
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
  test('CLI status never writes an operator-supplied control sequence to the terminal', () => {
    const lp = fresh();
    halt({ ledgerPath: lp, by: 'maintainer\u001b[2Jx', reason: 'r\u009b2K' });
    halt({ ledgerPath: lp, by: 'mo', agentId: 'bot\u001b]0;pwn\u0007' });
    const r = spawnSync(process.execPath, [CLI, 'status', '--ledger', lp], { encoding: 'utf8' });
    assert.equal(r.status, 4);
    assert.doesNotMatch(
      r.stdout,
      // eslint-disable-next-line no-control-regex -- the control characters ARE the assertion
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/,
      JSON.stringify(r.stdout),
    );
    assert.match(r.stdout, /HALTED by maintainer\\x1b\[2Jx/);
  });
  test('an agent-only halt is listed by status and exits 0 (only a global halt stops CI)', () => {
    const lp = fresh();
    halt({ ledgerPath: lp, by: 'maintainer', agentId: 'bot-7' });
    const r = spawnSync(process.execPath, [CLI, 'status', '--ledger', lp], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /agent bot-7 halted by maintainer/);
  });
});

describe('review B1: agent ids that are prototype names are ordinary ids', () => {
  const NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  test('never read as halted before a halt; halt is written to disk; refuse; resume lifts', () => {
    for (const id of NAMES) {
      const lp = fresh();
      halt({ ledgerPath: lp, by: 'maintainer', agentId: 'someone-else' }); // a v2 ledger with an agents map
      assert.equal(
        code(() => reserve({ ledgerPath: lp, callId: 'pre', estimatedMaxUsd: 1, agentId: id })),
        null,
        `${id} must not read as halted off the prototype`,
      );
      const r = halt({ ledgerPath: lp, by: 'maintainer', agentId: id });
      assert.equal(r.alreadyHalted, false, `${id}: halt must not claim an existing record`);
      assert.ok(Object.hasOwn(onDisk(lp).halt.agents, id), `${id}: halt record on disk`);
      assert.equal(
        code(() => reserve({ ledgerPath: lp, callId: 'post', estimatedMaxUsd: 1, agentId: id })),
        'AGENT_HALTED',
        id,
      );
      assert.equal(
        code(() => reserve({ ledgerPath: lp, callId: 'other', estimatedMaxUsd: 1, agentId: 'x' })),
        null,
      );
      assert.equal(resume({ ledgerPath: lp, by: 'ann', agentId: id }).wasHalted, true, id);
      assert.equal(Object.hasOwn(onDisk(lp).halt.agents, id), false);
      assert.equal(
        code(() => reserve({ ledgerPath: lp, callId: 'again', estimatedMaxUsd: 1, agentId: id })),
        null,
      );
    }
  });
  test('the first halt on a fresh ledger can be a prototype name', () => {
    const lp = fresh();
    halt({ ledgerPath: lp, by: 'maintainer', agentId: '__proto__' });
    assert.equal(
      code(() =>
        reserve({ ledgerPath: lp, callId: 'a', estimatedMaxUsd: 1, agentId: '__proto__' }),
      ),
      'AGENT_HALTED',
    );
    assert.equal(resume({ ledgerPath: lp, by: 'maintainer', agentId: 'constructor' }).wasHalted, false);
  });
});

describe('agent ids: one shape everywhere, exact match', () => {
  test('reserve, halt and resume refuse non-string or empty ids AGENT_ID_INVALID', () => {
    const lp = fresh();
    for (const bad of [7, '', {}, ['a']]) {
      assert.equal(
        code(() =>
          reserve({ ledgerPath: lp, callId: `x${typeof bad}`, estimatedMaxUsd: 1, agentId: bad }),
        ),
        'AGENT_ID_INVALID',
        JSON.stringify(bad),
      );
      assert.equal(
        code(() => halt({ ledgerPath: lp, by: 'maintainer', agentId: bad })),
        'AGENT_ID_INVALID',
      );
      assert.equal(
        code(() => resume({ ledgerPath: lp, by: 'maintainer', agentId: bad })),
        'AGENT_ID_INVALID',
      );
    }
    assert.equal(onDisk(lp).schema, LEDGER_SCHEMA, 'a refused halt changes nothing');
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'anon', estimatedMaxUsd: 1, agentId: null })),
      null,
      'null stays anonymous',
    );
  });
  test('matching is exact and case-sensitive (documented)', () => {
    const lp = fresh();
    halt({ ledgerPath: lp, by: 'maintainer', agentId: 'Bot' });
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'a', estimatedMaxUsd: 1, agentId: 'bot' })),
      null,
    );
  });
  test('CLI --agent "" exits 2 for halt and resume instead of widening to all spending', () => {
    const lp = fresh();
    for (const cmd of ['halt', 'resume']) {
      const r = spawnSync(
        process.execPath,
        [CLI, cmd, '--by', 'maintainer', '--agent', '', '--ledger', lp],
        {
          encoding: 'utf8',
        },
      );
      assert.equal(r.status, 2, cmd);
      assert.match(r.stderr, /AGENT_ID_INVALID/);
    }
    assert.equal('halt' in onDisk(lp), false);
  });
});

describe('review B2: a halted ledger is a different schema', () => {
  test('genesis is v1 with no halt key; the first halt makes it v2; resume keeps v2 with an emptied record', () => {
    const lp = fresh();
    assert.equal(onDisk(lp).schema, LEDGER_SCHEMA);
    halt({ ledgerPath: lp, by: 'maintainer', agentId: 'a' });
    assert.equal(onDisk(lp).schema, LEDGER_SCHEMA_V2);
    resume({ ledgerPath: lp, by: 'mo', agentId: 'a' });
    const d = onDisk(lp);
    assert.equal(d.schema, LEDGER_SCHEMA_V2);
    assert.deepEqual([d.halt.global, d.halt.agents], [null, {}]);
    // review S2: who lifted it is in the books, not only in the alert log
    assert.equal(d.halt.lifts.length, 1);
    assert.deepEqual(
      [
        d.halt.lifts[0].by,
        d.halt.lifts[0].scope,
        d.halt.lifts[0].agentId,
        d.halt.lifts[0].haltedBy,
      ],
      ['mo', 'agent', 'a', 'maintainer'],
    );
  });
  test('a pre-kill-switch reader refuses a halted ledger by schema name', () => {
    const lp = fresh();
    halt({ ledgerPath: lp, by: 'maintainer' });
    // the exact check every earlier release performs
    assert.notEqual(onDisk(lp).schema, 'sakk-ledger.v1');
  });
  test('v1 carrying halt, or v2 missing it, refuses — deleting the record never reads as "not halted"', () => {
    const v1 = fresh();
    const a = onDisk(v1);
    a.halt = { global: null, agents: {}, lifts: [] };
    writeFileSync(v1, JSON.stringify(a));
    assert.equal(
      code(() => readLedger({ ledgerPath: v1 })),
      'LEDGER_SCHEMA_INVALID',
    );
    const v2 = fresh();
    halt({ ledgerPath: v2, by: 'maintainer' });
    const b = onDisk(v2);
    delete b.halt;
    writeFileSync(v2, JSON.stringify(b));
    assert.equal(
      code(() => reserve({ ledgerPath: v2, callId: 'x', estimatedMaxUsd: 1 })),
      'LEDGER_SCHEMA_INVALID',
    );
  });
  test('resume on a v1 ledger reports nothing halted and writes nothing', () => {
    const lp = fresh();
    const before = readFileSync(lp, 'utf8');
    assert.equal(resume({ ledgerPath: lp, by: 'maintainer' }).wasHalted, false);
    assert.equal(readFileSync(lp, 'utf8'), before);
  });
});

describe('review M1: the CLI outlasts a lock held longer than one acquire budget', () => {
  test(
    'a live holder keeps the lock 3s; `sakk halt` retries and succeeds',
    { timeout: 90_000 },
    async () => {
      const lp = fresh();
      const lock = `${lp}.lock`;
      mkdirSync(lock);
      writeFileSync(
        join(lock, 'owner.json'),
        JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }),
      );
      const t0 = Date.now();
      const child = spawn(process.execPath, [CLI, 'halt', '--by', 'maintainer', '--ledger', lp], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (b) => (err += b));
      const timer = setTimeout(() => rmSync(lock, { recursive: true, force: true }), 3000);
      try {
        const status = await new Promise((r) => child.on('exit', r));
        assert.equal(status, 0, err);
        assert.ok(Date.now() - t0 >= 2900, 'the halt really waited out the holder');
        assert.equal(onDisk(lp).halt.global.by, 'maintainer');
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    },
  );
});

describe('verify pass round 2: paths the suite did not drive', () => {
  test('an OVERRUN settle under a global and an agent halt keeps both halts (S2: overrunLifts)', () => {
    const lp = fresh();
    reserve({ ledgerPath: lp, callId: 'x', estimatedMaxUsd: 1 });
    halt({ ledgerPath: lp, by: 'maintainer' });
    halt({ ledgerPath: lp, by: 'maintainer', agentId: 'bot' });
    settle({ ledgerPath: lp, callId: 'x', actualUsd: 5 }); // overrun: flags rewritten wholesale
    const d = onDisk(lp);
    assert.equal(d.flags.reconciliationRequired, true, 'the overrun was flagged');
    assert.equal(d.halt.global.by, 'maintainer', 'the global halt survived');
    assert.ok(Object.hasOwn(d.halt.agents, 'bot'), 'the agent halt survived');
  });
  test('settle, mark and clear on a RESUMED ledger keep it v2 with its halt record (S2: settleDowngrades)', () => {
    const lp = fresh();
    reserve({ ledgerPath: lp, callId: 'a', estimatedMaxUsd: 1 });
    reserve({ ledgerPath: lp, callId: 'b', estimatedMaxUsd: 1 });
    halt({ ledgerPath: lp, by: 'maintainer' });
    resume({ ledgerPath: lp, by: 'maintainer' });
    settle({ ledgerPath: lp, callId: 'a', actualUsd: 0.5 });
    settle({ ledgerPath: lp, callId: 'b', failedUnknownCost: true });
    settle({ ledgerPath: lp, callId: 'b', actualUsd: 0.2 });
    markReconciliationRequired({ ledgerPath: lp, reason: 'r' });
    clearReconciliation({ ledgerPath: lp, by: 'maintainer' });
    const d = onDisk(lp);
    assert.equal(d.schema, LEDGER_SCHEMA_V2);
    assert.deepEqual([d.halt.global, d.halt.agents, d.halt.lifts.length], [null, {}, 1]);
  });
  test('CLI: `--agent=bot`, `--agnet bot` or a repeated --agent never widen a resume to all spending (S1)', () => {
    const lp = fresh();
    halt({ ledgerPath: lp, by: 'maintainer' });
    for (const args of [
      ['--agent=bot'],
      ['--agnet', 'bot'],
      ['--agent', 'a', '--agent', 'b'],
      ['-a', 'bot'],
    ]) {
      const r = spawnSync(
        process.execPath,
        [CLI, 'resume', '--by', 'op', ...args, '--ledger', lp],
        {
          encoding: 'utf8',
        },
      );
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /USAGE_/);
    }
    assert.equal(onDisk(lp).halt.global.by, 'maintainer', 'the global halt is still on disk');
  });
  test('halt/resume with agentId null refuse — a failed id lookup never means "everyone" (N2)', () => {
    const lp = fresh();
    halt({ ledgerPath: lp, by: 'maintainer' });
    assert.equal(
      code(() => resume({ ledgerPath: lp, by: 'maintainer', agentId: null })),
      'AGENT_ID_INVALID',
    );
    assert.equal(
      code(() => halt({ ledgerPath: lp, by: 'maintainer', agentId: null })),
      'AGENT_ID_INVALID',
    );
    assert.equal(onDisk(lp).halt.global.by, 'maintainer');
    assert.equal(
      code(() => reserve({ ledgerPath: lp, callId: 'n', estimatedMaxUsd: 1, agentId: null })),
      'LEDGER_HALTED',
      'null stays anonymous for reserve',
    );
  });
});

describe('RC-08 class: every ledger write declares whether it confirms the books', () => {
  // updatedAt means "the books were last confirmed" (freshness bound). A
  // write that confirms nothing — a stop, a resume — must keep it (F-67).
  // A new write path fails here until someone decides which it is.
  const CONFIRMS = new Set([
    'initLedger',
    'reserve',
    'settle',
    'markReconciliationRequired',
    'clearReconciliation',
  ]);
  const KEEPS = new Set(['halt', 'resume']);
  test('each writeLedger call sits in a classified function, with the matching option', () => {
    const src = readFileSync(join(HERE, '..', 'src', 'ledger.mjs'), 'utf8');
    const calls = [...src.matchAll(/(?<!function )writeLedger\(ledgerPath, [^;]*?\);/gs)];
    assert.ok(calls.length >= 7, `only ${calls.length} writes found — pattern drifted?`);
    for (const m of calls) {
      const before = src.slice(0, m.index);
      const fn = [...before.matchAll(/^export function (\w+)\(/gm)].at(-1)?.[1];
      const keeps = /keepUpdatedAt: true/.test(m[0]);
      assert.ok(CONFIRMS.has(fn) || KEEPS.has(fn), `write in ${fn} is not classified`);
      assert.equal(keeps, KEEPS.has(fn), `${fn}: keepUpdatedAt must be ${KEEPS.has(fn)}`);
    }
  });
});
