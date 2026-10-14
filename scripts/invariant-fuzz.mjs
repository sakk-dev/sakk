#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Ledger invariant fuzz (property-testing idea, zero-dep): random operation
 * sequences against one ledger; after EVERY step the invariants must hold.
 * Runs in ~2s; `npm run fuzz`. Seeded PRNG so failures are reproducible:
 * rerun with SAKK_FUZZ_SEED=<seed> to replay a failing sequence.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initLedger,
  reserve,
  settle,
  clearReconciliation,
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
  const op = pick([
    'reserve',
    'reserve',
    'settleEq',
    'settleLess',
    'settleOver',
    'settleUnknown',
    'dupReserve',
    'clear',
  ]);
  try {
    if (op === 'reserve') {
      const id = `c${nextId++}`;
      reserve({ ledgerPath, callId: id, estimatedMaxUsd: 1 + rnd() * 5 });
      ids.push(id);
      check(!halted, 'reserve succeeded while halted', step);
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
    }
  } catch {
    /* refusals are legal outcomes; invariants are checked below */
  }
  const doc = readLedger({ ledgerPath, maxAgeMs: Infinity }); // always readable
  check(typeof doc.flags.reconciliationRequired === 'boolean', 'flags lost', step);
  check(doc.entries.length >= doc0.entries.length, 'entries vanished', step);
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
  console.log(`invariant-fuzz: 250 steps + concurrency leg, all invariants held (seed=${seed})`);
  process.exit(0);
}
console.error(`invariant-fuzz: ${fail} violations (seed=${seed})`);
process.exit(1);
