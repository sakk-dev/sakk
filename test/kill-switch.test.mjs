import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { normalize, evaluate } from '../src/hook.mjs';
import { HAS_PTY, atTerminal } from './pty.mjs';

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
    assert.equal(
      resume({ ledgerPath: lp, by: 'maintainer', agentId: 'constructor' }).wasHalted,
      false,
    );
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
    'markReconciliationRequired',
    'clearReconciliation',
  ]);
  // settle: an agent settling an old reservation confirmed nothing (ledger review S1)
  const KEEPS = new Set(['halt', 'resume', 'settle']);
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

describe('J-UAT-016: the agent cannot lift its own cap or remove its own guard (F-171)', () => {
  // The daily cap and an installed guard bind the AGENT. `sakk cap off/set` and
  // `sakk guard uninstall` are ordinary subcommands that write that config, so
  // two layers keep them a person's: the hook judges `sakk cap …` as the write to
  // ~/.sakk it makes (denied) and `sakk guard …` as the agent-config write it
  // makes (denied too, F-188), and the CLI itself refuses a loosening change unless
  // a person retypes a word at a terminal. Tightening (a first cap, a lower one)
  // never asks.
  const world = () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'juat016-')));
    const home = join(base, 'sakkhome'); // SAKK_HOME: holds config.json (the cap)
    mkdirSync(home, { recursive: true });
    const proj = join(base, 'proj'); // the agent's cwd: holds .claude/settings.json (the guard)
    mkdirSync(proj, { recursive: true });
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, `${JSON.stringify({ capUsd: 5 }, null, 2)}\n`);
    const env = { ...process.env, HOME: base, SAKK_HOME: home };
    const run = (args) =>
      spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: proj });
    return {
      base,
      home,
      proj,
      cwd: proj,
      configPath,
      env,
      run,
      settings: join(proj, '.claude', 'settings.json'),
    };
  };
  const guarded = (w) =>
    existsSync(w.settings) && readFileSync(w.settings, 'utf8').includes('sakk.mjs');

  test('J-UAT-016 cap off, a raised cap and guard uninstall refuse without a person at a terminal', () => {
    const w = world();
    for (const args of [
      ['cap', 'off'],
      ['cap', 'set', '999999'],
      ['cap', 'set', '5', '--zone', 'Pacific/Kiritimati'],
    ]) {
      const r = w.run(args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /^HUMAN_CONFIRMATION_REQUIRED: .*nothing changed/m, args.join(' '));
      assert.deepEqual(onDisk(w.configPath), { capUsd: 5 }, `${args.join(' ')} left the cap alone`);
    }
    assert.equal(
      w.run(['guard', 'install', 'claude-code']).status,
      0,
      'installing tightens: no ask',
    );
    assert.ok(guarded(w), 'precondition: the guard is installed');
    const off = w.run(['guard', 'uninstall', 'claude-code']);
    assert.equal(off.status, 2, off.stderr);
    assert.match(off.stderr, /^HUMAN_CONFIRMATION_REQUIRED: This removes the guard from /m);
    assert.ok(guarded(w), 'the guard is still installed');
    // tightening and no-ops never ask: a lower cap, the same zone, nothing to remove
    assert.equal(w.run(['cap', 'set', '3']).status, 0);
    assert.equal(onDisk(w.configPath).capUsd, 3);
    assert.equal(
      w.run(['guard', 'uninstall', 'cursor']).status,
      0,
      'nothing installed, nothing asked',
    );
  });

  test('J-UAT-016 the hook refuses `sakk cap` and `sakk guard`, and asks before a pseudo-terminal', () => {
    const w = world();
    const judge = (command) =>
      evaluate(
        normalize('claude-code', {
          hook_event_name: 'PreToolUse',
          cwd: w.proj,
          session_id: 's-juat016',
          tool_use_id: 'c-juat016',
          tool_name: 'Bash',
          tool_input: { command },
        }),
        { env: w.env, log: false },
      );
    for (const command of [
      'sakk cap off',
      'sakk cap set 999999',
      'sudo sakk cap off',
      'cd /tmp && sakk cap set 1',
    ]) {
      const r = judge(command);
      assert.equal(r.verdict, 'deny', command);
      assert.ok(
        r.decisions.some((d) => d.ruleId === 'protect-guard-state'),
        command,
      );
    }
    // the agent's own hook config is a protected zone (F-188): uninstall, project
    // or user level, is the agent-config write it makes — denied, never asked
    for (const command of [
      'sakk guard uninstall claude-code',
      'sakk guard uninstall codex --user',
    ]) {
      const r = judge(command);
      assert.equal(r.verdict, 'deny', command);
      assert.ok(
        r.decisions.some((d) => d.ruleId === 'deny-agent-config'),
        command,
      );
    }
    // a pseudo-terminal that runs sakk as a plain word is judged as sakk's own
    // control write (F-185) — denied; one that hides sakk inside a script it
    // types is still asked, never allowed
    for (const command of [
      'echo claude-code | script -q /dev/null sakk guard uninstall claude-code',
      'unbuffer sakk cap off',
    ]) {
      const r = judge(command);
      assert.equal(r.verdict, 'deny', command);
    }
    for (const command of ['expect -c "spawn sakk cap off; send off\\r"']) {
      const r = judge(command);
      assert.equal(r.verdict, 'require_approval', command);
    }
  });

  // F-177 (D11): resume, reconcile and unlock loosen the controls that bind
  // the agent, so the hook judges them as the guard-state write they make —
  // denied, never asked. `sakk halt` tightens and stays allowed (R-24 below).
  test('F-177 the hook denies the commands that lift a halt or clear the books', () => {
    const w = world();
    for (const command of [
      'sakk resume --by alice --agent bot-7',
      'sakk reconcile --by alice',
      'sakk unlock --by alice',
      'sudo sakk resume --by alice',
      'cd /tmp && sakk unlock --by alice',
    ]) {
      const r = evaluate(
        normalize('claude-code', {
          hook_event_name: 'PreToolUse',
          cwd: w.proj,
          session_id: 's-f177',
          tool_use_id: 'c-f177',
          tool_name: 'Bash',
          tool_input: { command },
        }),
        { env: w.env, log: false },
      );
      assert.equal(r.verdict, 'deny', command);
      assert.ok(
        r.decisions.some((d) => d.ruleId === 'protect-guard-state'),
        command,
      );
    }
  });

  test('J-UAT-016 an agent cannot re-point the ledger a halt is read from (F-181)', () => {
    const w = world();
    const ops = join(w.base, 'ops', 'ledger.json'); // the person's, found by SAKK_LEDGER_PATH
    mkdirSync(dirname(ops), { recursive: true });
    initLedger({ ledgerPath: ops, capUsd: 50, initializedBy: 'ops' });
    halt({ ledgerPath: ops, by: 'ops', agentId: 'cursor' });
    const env = { ...w.env, SAKK_LEDGER_PATH: ops };
    const cursorRuns = (command) =>
      evaluate(
        normalize('cursor', {
          hook_event_name: 'beforeShellExecution',
          cwd: w.proj,
          conversation_id: 's-f181',
          generation_id: 'g-f181',
          command,
        }),
        { env, log: false },
      );
    assert.equal(cursorRuns('rm -rf build').verdict, 'deny', 'precondition: cursor is halted');
    const rewire = 'sakk init --cap 5 --ledger ./x.json';
    const r = evaluate(
      normalize('claude-code', {
        hook_event_name: 'PreToolUse',
        cwd: w.proj,
        session_id: 's-f181',
        tool_use_id: 'c-f181',
        tool_name: 'Bash',
        tool_input: { command: rewire },
      }),
      { env, log: false },
    );
    assert.equal(r.verdict, 'deny', 'claude-code is not halted, and still may not run it');
    assert.ok(r.decisions.some((d) => d.ruleId === 'protect-guard-state'));
    // the control: run anyway, it records the agent's ledger and cursor's halt is gone
    const ran = spawnSync(process.execPath, [CLI, ...rewire.split(' ').slice(1)], {
      encoding: 'utf8',
      env,
      cwd: w.proj,
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(cursorRuns('rm -rf build').verdict, 'allow', 'the route the hook refuses is live');
  });

  // R-24: a control cannot be lifted by the party it binds. Every subcommand the
  // CLI dispatches is declared by its effect on a control the agent is bound by,
  // with commands showing how the hook judges an agent that runs it. A new
  // subcommand fails here until someone declares it; one that loosens a control
  // reaches an agent only under a GAP naming an open finding.
  const SUBCOMMANDS = {
    // records the ledger the hook reads halts from (F-181)
    init: { effect: 'loosens', judged: [['sakk init --cap 5 --ledger ./x.json', 'deny']] },
    status: { effect: 'none', judged: [['sakk status --json', 'allow']] },
    // the halt family loosens the control that binds the agent: judged as the
    // guard-state write it makes, denied (F-177, D11)
    reconcile: {
      effect: 'loosens',
      judged: [['sakk reconcile --by alice', 'deny']],
    },
    unlock: { effect: 'loosens', judged: [['sakk unlock --by alice', 'deny']] },
    // closes a held reservation at its worst case, freeing an outstanding slot (F-242)
    settle: { effect: 'loosens', judged: [['sakk settle gw-abc --by alice', 'deny']] },
    halt: { effect: 'tightens', judged: [['sakk halt --by alice --agent cursor', 'allow']] },
    resume: {
      effect: 'loosens',
      judged: [['sakk resume --by alice --agent cursor', 'deny']],
    },
    // the reserve gate an agent calls by choice; its own server holds nothing back
    mcp: { effect: 'none', judged: [['sakk mcp --ledger ./sakk-ledger.json', 'allow']] },
    // verify reads; export and reindex rebuild from the same record, halts included
    ledger: {
      effect: 'none',
      judged: [
        ['sakk ledger verify', 'allow'],
        ['sakk ledger export --out ./flat.json', 'allow'],
      ],
    },
    scan: {
      effect: 'tightens',
      judged: [
        ['sakk scan --staged', 'allow'],
        ['sakk scan --install-hook', 'allow'],
      ],
    },
    hook: { effect: 'none', judged: [['sakk hook --agent claude-code', 'allow']] },
    try: { effect: 'none', judged: [['sakk try "git status"', 'allow']] },
    guard: {
      effect: 'loosens',
      judged: [
        ['sakk guard install claude-code', 'deny'],
        ['sakk guard uninstall claude-code', 'deny'],
      ],
    },
    doctor: { effect: 'none', judged: [['sakk doctor', 'allow']] },
    ui: { effect: 'tightens', judged: [['sakk ui --allow-halt', 'allow']] },
    cap: {
      effect: 'loosens',
      judged: [
        ['sakk cap off', 'deny'],
        ['sakk cap set 3', 'deny'],
      ],
    },
    spend: { effect: 'none', judged: [['sakk spend --json', 'allow']] },
    prices: { effect: 'none', judged: [['sakk prices', 'allow']] },
    // writes the start script that names the ledger the gateway charges: in
    // Sakk's home that is guard state, judged as that write and denied
    gateway: {
      effect: 'loosens',
      judged: [
        ['sakk gateway init', 'deny'],
        ['sakk gateway init --force --ledger ./big.json', 'deny'],
      ],
    },
  };

  test('sakk gateway init is judged as the write it makes: into Sakk home denied, into the project as that write', () => {
    const w = world();
    const judge = (command) =>
      evaluate(
        normalize('claude-code', {
          hook_event_name: 'PreToolUse',
          cwd: w.proj,
          session_id: 's-gw',
          tool_use_id: 'c-gw',
          tool_name: 'Bash',
          tool_input: { command },
        }),
        { env: w.env, log: false },
      );
    for (const command of [
      'sakk gateway init',
      'sakk gateway init --port 4100',
      `sakk gateway init --dir ${join(w.home, 'gateway')} --force`,
      `sakk gateway init --dir ${w.home}`,
    ])
      assert.equal(judge(command).verdict, 'deny', command);
    // into the project it is the same write a plain redirect makes there
    const write = judge('echo x > ./gw/start.sh').verdict;
    assert.equal(judge('sakk gateway init --dir ./gw').verdict, write);
    assert.notEqual(write, 'deny', 'a write into the project is not guard state');
  });

  test('R-24 every sakk subcommand is declared by its effect on a control, and judged by it', () => {
    const src = readFileSync(CLI, 'utf8');
    const table = src.match(/^const COMMANDS = \{\n([\s\S]*?)\n\};/m)?.[1] ?? '';
    const names = new Set([...table.matchAll(/^ {2}([a-z]+):/gm)].map((m) => m[1]));
    assert.ok(names.size >= 10, `only ${names.size} commands in the flag table — pattern drifted?`);
    for (const m of src.matchAll(/cmd === '([a-z][a-z-]*)'/g)) names.add(m[1]);
    assert.deepEqual(
      Object.keys(SUBCOMMANDS).sort(),
      [...names].sort(),
      'a subcommand is dispatched but not declared here, or declared but gone',
    );
    const open = new Set(
      JSON.parse(readFileSync(join(HERE, '..', 'findings', 'ledger.json'), 'utf8'))
        .findings.filter((f) => f.status === 'open')
        .map((f) => f.id),
    );
    const w = world();
    for (const [name, { effect, gap, judged }] of Object.entries(SUBCOMMANDS)) {
      assert.ok(['none', 'tightens', 'loosens'].includes(effect), `${name}: effect ${effect}`);
      assert.ok(judged.length > 0, `${name}: no command shows how the hook judges it`);
      const verdicts = [];
      for (const [command, expected] of judged) {
        assert.ok(command.startsWith(`sakk ${name}`), `${name}: "${command}" runs another command`);
        const r = evaluate(
          normalize('claude-code', {
            hook_event_name: 'PreToolUse',
            cwd: w.proj,
            session_id: 's-r24',
            tool_use_id: 'c-r24',
            tool_name: 'Bash',
            tool_input: { command },
          }),
          { env: w.env, log: false },
        );
        assert.equal(r.verdict, expected, command);
        verdicts.push(r.verdict);
      }
      if (gap === undefined) {
        if (effect === 'loosens')
          assert.ok(
            !verdicts.includes('allow'),
            `${name} loosens a control and an agent may run it`,
          );
      } else {
        assert.ok(open.has(gap), `${name}: GAP ${gap} is not an open finding — remove the mark`);
        assert.ok(verdicts.includes('allow'), `${name}: GAP ${gap} no longer reaches the agent`);
      }
    }
  });

  // F-185: the program is the same whatever starts it. Every launcher a person
  // could type runs the same bin, so a control-loosening subcommand is judged as
  // the same write through each one — never looser than `sakk <args>` itself.
  test('F-185 every control-loosening sakk subcommand is judged the same through every launcher', () => {
    const w = world();
    const judge = (command) =>
      evaluate(
        normalize('claude-code', {
          hook_event_name: 'PreToolUse',
          cwd: w.proj,
          session_id: 's-f185',
          tool_use_id: 'c-f185',
          tool_name: 'Bash',
          tool_input: { command },
        }),
        { env: w.env, log: false },
      ).verdict;
    const LAUNCHERS = [
      (a) => `npx sakk ${a}`,
      (a) => `npx -y sakk@0.4.0 ${a}`,
      (a) => `npx -p sakk sakk ${a}`,
      (a) => `npx --package=sakk sakk ${a}`,
      (a) => `npx @sakk-dev/sakk@latest ${a}`,
      (a) => `pnpm dlx sakk ${a}`,
      (a) => `pnpm exec sakk ${a}`,
      (a) => `yarn sakk ${a}`,
      (a) => `yarn dlx sakk ${a}`,
      (a) => `bunx sakk ${a}`,
      (a) => `bun x sakk ${a}`,
      (a) => `npm exec -- sakk ${a}`,
      (a) => `npm exec sakk -- ${a}`,
      (a) => `deno run -A npm:sakk ${a}`,
      (a) => `node ./node_modules/sakk/bin/sakk.mjs ${a}`,
      (a) => `node /usr/local/lib/node_modules/sakk/bin/sakk.mjs ${a}`,
      (a) => `./node_modules/.bin/sakk ${a}`,
      (a) => `volta run sakk ${a}`,
      (a) => `sudo npx sakk ${a}`,
    ];
    const RANK = { allow: 0, require_approval: 1, deny: 2 };
    for (const { effect, judged } of Object.values(SUBCOMMANDS))
      for (const [command] of judged) {
        const args = command.slice('sakk '.length);
        const plain = judge(command);
        for (const launch of LAUNCHERS) {
          const via = launch(args);
          const got = judge(via);
          if (effect === 'loosens') assert.equal(got, plain, `${via} (plain: ${plain})`);
          else assert.ok(RANK[got] >= RANK[plain], `${via} is looser than ${command}`);
        }
      }
    // controls: a mention of the name that runs nothing keeps its old answer
    for (const command of [
      'echo "sakk cap off"',
      'cat bin/sakk.mjs',
      'grep -rn sakk README.md',
      'npx prettier --check sakk.mjs',
    ])
      assert.equal(judge(command), 'allow', command);
  });

  test(
    'J-UAT-016 a person at a terminal who types the word makes the change',
    { skip: !HAS_PTY && 'python3 with pty is not installed' },
    () => {
      const w = world();
      const wrong = atTerminal(['cap', 'off'], 'yes', w);
      assert.equal(wrong.status, 2);
      assert.ok(wrong.asked);
      assert.match(wrong.out, /HUMAN_CONFIRMATION_REQUIRED: the answer was not off/);
      assert.deepEqual(onDisk(w.configPath), { capUsd: 5 });
      const raised = atTerminal(['cap', 'set', '50'], '50', w);
      assert.equal(raised.status, 0, raised.out);
      assert.equal(onDisk(w.configPath).capUsd, 50);
      const lifted = atTerminal(['cap', 'off'], 'off', w);
      assert.equal(lifted.status, 0, lifted.out);
      assert.equal(onDisk(w.configPath).capUsd, undefined);
      assert.equal(w.run(['guard', 'install', 'claude-code']).status, 0);
      const removed = atTerminal(['guard', 'uninstall', 'claude-code'], 'claude-code', w);
      assert.equal(removed.status, 0, removed.out);
      assert.ok(!guarded(w), 'the person removed the guard');
    },
  );
});

describe('J-UAT-030 / G-FN-016 — a halt reaches the hook in a default install (F-172)', () => {
  test('J-UAT-030 sakk init wires the ledger into the hook, so a halt from any directory stops the guarded agent', () => {
    const base = mkdtempSync(join(tmpdir(), 'ks-juat030-'));
    const home = join(base, 'sakkhome');
    const proj = join(base, 'proj');
    const elsewhere = join(base, 'elsewhere');
    for (const d of [home, proj, elsewhere]) mkdirSync(d, { recursive: true });
    // A default install: config.json exists but carries no ledgerPath and no capUsd
    // (so the cap branch is skipped and cannot set `unknown`, which would mask halt).
    writeFileSync(join(home, 'config.json'), '{}\n');

    const env = { ...process.env, HOME: base, SAKK_HOME: home };
    delete env.SAKK_LEDGER_PATH;
    const run = (args, cwd = proj) =>
      spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd });

    // The operator sets up in the project with no --ledger and no SAKK_LEDGER_PATH:
    // init creates the ledger under SAKK_HOME (F-177: never in the agent-writable
    // project cwd) and records its absolute path for the hook.
    const inited = run(['init', '--cap', '100', '--by', 'alice']);
    assert.equal(inited.status, 0, `init should succeed: ${inited.stderr}`);
    const wrote = join(home, 'sakk-ledger.json');
    assert.ok(existsSync(wrote), 'init wrote SAKK_HOME/sakk-ledger.json');
    assert.equal(
      existsSync(join(proj, 'sakk-ledger.json')),
      false,
      'nothing lands in the project cwd',
    );
    assert.equal(
      JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).ledgerPath,
      wrote,
      'init records the absolute ledger path in config.json',
    );

    const ev = {
      hook_event_name: 'PreToolUse',
      cwd: proj,
      session_id: 's-juat030',
      tool_use_id: 'c-juat030',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' }, // a non-read, mutating action
    };
    const decide = () => evaluate(normalize('claude-code', ev), { env, log: false });
    const byHalt = (r) => (r.decisions ?? []).some((d) => d.ruleId === 'halt');
    assert.equal(byHalt(decide()), false, 'before the halt nothing is stopped');

    // The kill switch, pulled from another directory and still with no flag: the
    // CLI resolves the recorded ledger, so the halt lands where the hook reads.
    const halted = run(['halt', '--by', 'alice', '--reason', 'stop everything'], elsewhere);
    assert.equal(halted.status, 0, `halt should succeed: ${halted.stderr}`);
    assert.equal(
      existsSync(join(elsewhere, 'sakk-ledger.json')),
      false,
      'no stray ledger where halt ran',
    );
    const stopped = decide();
    assert.ok(byHalt(stopped), 'the default-install hook honors the halt');
    assert.equal(stopped.verdict, 'deny', 'the halted call is denied');

    // F-177: lifting the halt is a person's move — without a terminal the CLI
    // refuses and changes nothing.
    const refused = run(['resume', '--by', 'alice'], elsewhere);
    assert.equal(refused.status, 2, `no-TTY resume must refuse: ${refused.stderr}`);
    assert.match(refused.stderr, /^HUMAN_CONFIRMATION_REQUIRED: /m);
    assert.ok(byHalt(decide()), 'the refused resume left the halt in place');

    if (HAS_PTY) {
      const resumed = atTerminal(['resume', '--by', 'alice'], 'resume', { env, cwd: elsewhere });
      assert.equal(resumed.status, 0, `resume at a terminal should succeed: ${resumed.out}`);
    } else {
      resume({ ledgerPath: wrote, by: 'alice' }); // no pty available: lift via the library
    }
    assert.equal(byHalt(decide()), false, 'resume lifts the halt the hook reads');
  });
});

describe('F-177 — lifting a halt, clearing the books and breaking a lock are person-only at the CLI', () => {
  const world = () => {
    const base = mkdtempSync(join(tmpdir(), 'ks-f177-'));
    const home = join(base, 'sakkhome');
    mkdirSync(home, { recursive: true });
    const lp = join(home, 'sakk-ledger.json');
    initLedger({ ledgerPath: lp, capUsd: 100 });
    const env = { ...process.env, HOME: base, SAKK_HOME: home, SAKK_LEDGER_PATH: lp };
    const run = (args) =>
      spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: base });
    return { base, home, lp, env, run };
  };

  test('without a terminal, resume / reconcile / unlock refuse and change nothing', () => {
    const w = world();
    halt({ ledgerPath: w.lp, by: 'maintainer', reason: 'stop' });
    markReconciliationRequired({ ledgerPath: w.lp, reason: 'books diverged' });
    const before = readFileSync(w.lp, 'utf8');
    mkdirSync(`${w.lp}.lock`);
    for (const args of [
      ['resume', '--by', 'bot'],
      ['reconcile', '--by', 'bot'],
      ['unlock', '--by', 'bot'],
    ]) {
      const r = w.run(args);
      assert.equal(r.status, 2, `${args[0]} must refuse without a TTY: ${r.stderr}`);
      assert.match(r.stderr, /^HUMAN_CONFIRMATION_REQUIRED: /m, args[0]);
    }
    assert.ok(existsSync(`${w.lp}.lock`), 'the lock is still in place');
    rmSync(`${w.lp}.lock`, { recursive: true });
    assert.equal(readFileSync(w.lp, 'utf8'), before, 'the ledger bytes did not move');
  });

  test('resume with nothing halted never enters the write path (F-209)', () => {
    // The no-op read must not reach resume(): called anyway, it would lift a
    // halt that landed AFTER the unlocked read above it, with no confirmation.
    // A held lock makes the write path observable: entering it spins on the
    // lock and fails, while the honest no-op answers at once and exits 0.
    const w = world();
    mkdirSync(`${w.lp}.lock`);
    try {
      const r = w.run(['resume', '--by', 'bot']);
      assert.equal(r.status, 0, `the no-op must not touch the lock: ${r.stderr}`);
      assert.match(r.stdout, /nothing halted \(all spending\)/);
      const scoped = w.run(['resume', '--by', 'bot', '--agent', 'a1']);
      assert.equal(scoped.status, 0, `scoped no-op must not touch the lock: ${scoped.stderr}`);
      assert.match(scoped.stdout, /nothing halted \(agent "a1"\)/);
      assert.ok(existsSync(`${w.lp}.lock`), 'the lock is untouched');
    } finally {
      rmSync(`${w.lp}.lock`, { recursive: true, force: true });
    }
  });

  test('with nothing to lift, clear or break, each command answers honestly without asking', () => {
    const w = world();
    const resume0 = w.run(['resume', '--by', 'bot']);
    assert.equal(resume0.status, 0, resume0.stderr);
    assert.match(resume0.stdout, /nothing halted/);
    const reco0 = w.run(['reconcile', '--by', 'bot']);
    assert.equal(reco0.status, 0, reco0.stderr);
    assert.match(reco0.stdout, /nothing to clear/);
    const unlock0 = w.run(['unlock', '--by', 'bot']);
    assert.equal(unlock0.status, 0, unlock0.stderr);
    assert.match(unlock0.stdout, /no lock present/);
  });

  test(
    'a person at the terminal retypes the word; the wrong word refuses',
    { skip: !HAS_PTY && 'python3 with pty is not installed' },
    () => {
      const w = world();
      halt({ ledgerPath: w.lp, by: 'maintainer', reason: 'stop' });

      const wrong = atTerminal(['resume', '--by', 'maintainer'], 'yes', {
        env: w.env,
        cwd: w.base,
      });
      assert.equal(wrong.status, 2, wrong.out);
      assert.match(wrong.out, /HUMAN_CONFIRMATION_REQUIRED: the answer was not resume/);

      const resumed = atTerminal(['resume', '--by', 'maintainer'], 'resume', {
        env: w.env,
        cwd: w.base,
      });
      assert.equal(resumed.status, 0, resumed.out);
      assert.ok(resumed.asked, 'resume asked before acting');
      assert.match(resumed.out, /resumed all spending by maintainer/);

      markReconciliationRequired({ ledgerPath: w.lp, reason: 'books diverged' });
      const cleared = atTerminal(['reconcile', '--by', 'maintainer'], 'reconcile', {
        env: w.env,
        cwd: w.base,
      });
      assert.equal(cleared.status, 0, cleared.out);
      assert.match(cleared.out, /reconciliation cleared by maintainer/);

      mkdirSync(`${w.lp}.lock`);
      const unlocked = atTerminal(['unlock', '--by', 'maintainer'], 'unlock', {
        env: w.env,
        cwd: w.base,
      });
      assert.equal(unlocked.status, 0, unlocked.out);
      assert.equal(existsSync(`${w.lp}.lock`), false, 'the lock is gone');
    },
  );
});
