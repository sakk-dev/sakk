#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/*
 * Ledger invariant fuzz (property-testing idea, zero-dep): random operation
 * sequences against one ledger; after EVERY step the invariants must hold.
 * Runs in ~2s; `npm run fuzz`. Seeded PRNG so failures are reproducible:
 * rerun with SAKK_FUZZ_SEED=<seed> to replay a failing sequence.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initLedger,
  reserve,
  settle,
  clearReconciliation,
  halt,
  resume,
  readLedger,
  totalsOf,
} from '../src/ledger.mjs';

const seed = Number(process.env.SAKK_FUZZ_SEED ?? Date.now());
let state = seed >>> 0 || 1;
const rnd = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

const dir = mkdtempSync(join(tmpdir(), 'sakk-fuzz-'));
const ledgerPath = join(dir, 'ledger.json');
const CAP = 50;
initLedger({ ledgerPath, capUsd: CAP });

let nextId = 0;
const ids = [];
let overrunSeen = false;
let killProbes = 0; // reserve attempts made while a halt covered the caller
let fail = 0;
const check = (cond, msg, step) => {
  if (!cond) {
    fail += 1;
    console.error(`INVARIANT VIOLATED @${step} (seed=${seed}): ${msg}`);
  }
};

for (let step = 0; step < 250; step += 1) {
  const doc0 = readLedger({ ledgerPath, maxAgeMs: Infinity });
  const halted =
    doc0.flags.reconciliationRequired === true ||
    doc0.entries.some((e) => e.status === 'RECONCILIATION_REQUIRED');
  // kill switch (specs/kill-switch): global halt, and per-agent halts
  const killed = Boolean(doc0.halt?.global);
  const killedAgents = new Set(Object.keys(doc0.halt?.agents ?? {}));
  const op = pick([
    'reserve',
    'reserve',
    'settleEq',
    'settleLess',
    'settleOver',
    'settleUnknown',
    'dupReserve',
    'clear',
    'halt',
    'haltAgent',
    'resume',
    'resumeAgent',
  ]);
  // Prototype names are in the pool on purpose (review B1): as object keys
  // they read as "halted" off the prototype, or vanish on write.
  const agent = pick(['a1', 'a2', '__proto__', 'constructor', 'toString']);
  try {
    if (op === 'reserve') {
      // anonymous callers too: a global halt must stop them (verify N1)
      const who = rnd() < 0.25 ? pick([undefined, null]) : agent;
      const agentHalted = typeof who === 'string' && killedAgents.has(who);
      if (killed || agentHalted) killProbes += 1;
      const id = `c${nextId++}`;
      reserve({ ledgerPath, callId: id, estimatedMaxUsd: 1 + rnd() * 5, agentId: who });
      ids.push(id);
      check(!halted, 'reserve succeeded while halted', step);
      check(!killed, `reserve succeeded while the kill switch was on (agent ${who})`, step);
      check(!agentHalted, `reserve succeeded for halted agent ${who}`, step);
    } else if (op === 'dupReserve' && ids.length) {
      reserve({ ledgerPath, callId: pick(ids), estimatedMaxUsd: 1 });
      check(false, 'duplicate callId was accepted', step);
    } else if (op.startsWith('settle') && ids.length) {
      const id = pick(ids);
      const e = doc0.entries.find((x) => x.callId === id);
      if (op === 'settleUnknown') settle({ ledgerPath, callId: id, failedUnknownCost: true });
      else {
        const amt =
          op === 'settleOver' ? e.estimatedMaxUsd * (2 + rnd() * 3) : e.estimatedMaxUsd * rnd();
        settle({ ledgerPath, callId: id, actualUsd: amt });
        // AR-3: an over-settle of a RECONCILIATION_REQUIRED entry is an overrun too
        if (op === 'settleOver' && e && e.status !== 'SETTLED') overrunSeen = true;
      }
    } else if (op === 'clear') {
      clearReconciliation({ ledgerPath, by: 'fuzz' });
    } else if (op === 'halt') halt({ ledgerPath, by: 'fuzz' });
    else if (op === 'haltAgent') halt({ ledgerPath, by: 'fuzz', agentId: agent });
    else if (op === 'resume') resume({ ledgerPath, by: 'fuzz' });
    else if (op === 'resumeAgent') resume({ ledgerPath, by: 'fuzz', agentId: agent });
  } catch {
    /* refusals are legal outcomes; invariants are checked below */
  }
  const doc = readLedger({ ledgerPath, maxAgeMs: Infinity }); // always readable
  check(typeof doc.flags.reconciliationRequired === 'boolean', 'flags lost', step);
  check(doc.entries.length >= doc0.entries.length, 'entries vanished', step);
  // only resume may lift a halt — no money path may (specs/kill-switch row 3)
  if (killed && op !== 'resume')
    check(Boolean(doc.halt?.global), `global halt lost by ${op}`, step);
  for (const a of killedAgents)
    if (!(op === 'resumeAgent' && a === agent))
      check(
        Boolean(doc.halt) && Object.hasOwn(doc.halt.agents, a),
        `agent halt ${a} lost by ${op}`,
        step,
      );
  if (op === 'haltAgent') {
    // the halt must be ON DISK as an own key, not just in memory
    const raw = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    check(Object.hasOwn(raw.halt?.agents ?? {}, agent), `haltAgent ${agent} not on disk`, step);
  }
  // a halted ledger is v2 and never drops back to v1 (review B2)
  if (doc0.schema === 'sakk-ledger.v2')
    check(doc.schema === 'sakk-ledger.v2', `schema downgraded by ${op}`, step);
  check((doc.schema === 'sakk-ledger.v2') === 'halt' in doc, 'halt record vs schema', step);
  const t = totalsOf(doc);
  if (!overrunSeen)
    check(
      t.committedUsd < CAP + 1e-9,
      `committed ${t.committedUsd} breached cap without an overrun event`,
      step,
    );
}

// Concurrency leg: four workers hammer reserves; grants must equal book entries.
const wf = join(dir, 'w.mjs');
writeFileSync(
  wf,
  `import { reserve } from ${JSON.stringify(new URL('../src/ledger.mjs', import.meta.url).pathname)};
let ok = 0;
for (let i = 0; i < 30; i++) { try { reserve({ ledgerPath: process.argv[2], callId: process.argv[3] + ':' + i, estimatedMaxUsd: 0.01 }); ok++; } catch {} }
console.log(ok);`,
);
const lp2 = join(dir, 'l2.json');
initLedger({ ledgerPath: lp2, capUsd: 10 });
const procs = ['a', 'b', 'c', 'd'].map((k) =>
  spawnSync(process.execPath, [wf, lp2, k], { encoding: 'utf8' }),
);
const granted = procs.reduce((a, p) => a + Number(p.stdout.trim() || 0), 0);
const booked = readLedger({ ledgerPath: lp2, maxAgeMs: Infinity }).entries.length;
check(granted === booked, `concurrency: granted ${granted} != booked ${booked}`, 'conc');

if (fail === 0) {
  // R-16: a probe that never meets the attack proves nothing
  if (killProbes === 0) {
    console.error(
      `invariant-fuzz: kill switch never probed under this seed (seed=${seed}) — vacuous run`,
    );
    process.exit(1);
  }
  console.log(
    `invariant-fuzz: 250 steps + concurrency leg, all invariants held · ${killProbes} reserve attempts under a halt, all refused (seed=${seed})`,
  );
  process.exit(0);
}
console.error(`invariant-fuzz: ${fail} violations (seed=${seed})`);
process.exit(1);
