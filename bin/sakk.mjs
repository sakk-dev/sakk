#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initLedger,
  readLedger,
  totalsOf,
  clearReconciliation,
  forceUnlock,
  LedgerError,
} from '../src/ledger.mjs';

/**
 * sakk CLI — the smallest useful surface over the ledger.
 *
 *   sakk init --cap <usd> [--ledger <path>] [--by <name>]
 *   sakk status [--ledger <path>] [--json]
 *   sakk reconcile --by <name> [--ledger <path>]
 *
 * Path resolution: --ledger flag > SAKK_LEDGER_PATH > ./sakk-ledger.json
 * (the CLI's one explicit convenience default — always printed, never
 * guessed silently; the library itself keeps no default at all).
 *
 * Exit codes: 0 ok · 1 ledger error (every refusal code on stderr) ·
 * 2 usage error · 3 status: reconciliation required (gate your CI on it).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};

function ledgerPath() {
  return resolve(val('ledger') ?? process.env.SAKK_LEDGER_PATH ?? 'sakk-ledger.json');
}

const USAGE = `sakk ${pkg.version} — fail-closed spend ledger for AI agents

Usage:
  sakk init --cap <usd> [--ledger <path>] [--by <name>]   create a ledger (refuses to overwrite)
  sakk status [--ledger <path>] [--json]                  totals, entries, reconciliation state
  sakk reconcile --by <name> [--ledger <path>]            clear the reconciliation flag (signed)
  sakk unlock --by <name> [--ledger <path>]               break a stuck lock by hand (signed)

Ledger path: --ledger > $SAKK_LEDGER_PATH > ./sakk-ledger.json
Exit codes: 0 ok · 1 ledger error · 2 usage error · 3 reconciliation required (status)
`;

function fail(e) {
  if (e instanceof LedgerError) {
    console.error(`${e.code}: ${e.message.slice(e.code.length + 2)}`);
    if (Object.keys(e.details ?? {}).length) console.error(JSON.stringify(e.details));
  } else {
    console.error(String(e?.message ?? e));
  }
  process.exit(1);
}

if (cmd === 'init') {
  const cap = Number(val('cap'));
  if (!Number.isFinite(cap) || cap <= 0) {
    console.error('init requires --cap <usd> (a positive number)');
    process.exit(2);
  }
  const p = ledgerPath();
  try {
    initLedger({ ledgerPath: p, capUsd: cap, initializedBy: val('by') ?? 'sakk-cli' });
  } catch (e) {
    fail(e);
  }
  console.log(`ledger created: ${p}`);
  console.log(`cap: $${cap} — reserve before you spawn; reaching the cap refuses.`);
} else if (cmd === 'status') {
  const p = ledgerPath();
  let doc;
  try {
    // Reading the books is not spending: status may inspect a stale ledger.
    doc = readLedger({ ledgerPath: p, maxAgeMs: Number.POSITIVE_INFINITY });
  } catch (e) {
    fail(e);
  }
  const t = totalsOf(doc);
  const byStatus = { RESERVED: 0, SETTLED: 0, RECONCILIATION_REQUIRED: 0 };
  for (const e of doc.entries) byStatus[e.status] += 1;
  const reco = doc.flags?.reconciliationRequired === true;
  const out = {
    ledger: p,
    cap_usd: t.capUsd,
    settled_usd: t.settledUsd,
    outstanding_usd: t.outstandingUsd,
    committed_usd: t.committedUsd,
    remaining_usd: Math.max(0, t.capUsd - t.committedUsd),
    entries: byStatus,
    reconciliation_required: reco,
    reconciliation_reason: doc.flags?.reason ?? null,
    updated_at: doc.updatedAt,
  };
  if (flag('json')) {
    console.log(JSON.stringify(out, null, 1));
  } else {
    console.log(`ledger      ${p}`);
    console.log(`cap         $${t.capUsd}`);
    console.log(`settled     $${t.settledUsd}`);
    console.log(`outstanding $${t.outstandingUsd}`);
    console.log(`committed   $${t.committedUsd}  (remaining $${out.remaining_usd})`);
    console.log(
      `entries     ${doc.entries.length} (reserved ${byStatus.RESERVED}, settled ${byStatus.SETTLED}, reconciliation ${byStatus.RECONCILIATION_REQUIRED})`,
    );
    console.log(`updated     ${doc.updatedAt}`);
    if (reco) console.log(`⚠ RECONCILIATION REQUIRED: ${out.reconciliation_reason}`);
  }
  process.exit(reco ? 3 : 0);
} else if (cmd === 'reconcile') {
  const by = val('by');
  if (typeof by !== 'string' || by === '') {
    console.error('reconcile requires --by <name> — clearing the books takes a signature');
    process.exit(2);
  }
  const p = ledgerPath();
  try {
    clearReconciliation({ ledgerPath: p, by });
  } catch (e) {
    fail(e);
  }
  console.log(`reconciliation cleared by ${by}: ${p}`);
} else if (cmd === 'unlock') {
  const by = val('by');
  if (typeof by !== 'string' || by === '') {
    console.error('unlock requires --by <name> — breaking a lock takes a signature');
    process.exit(2);
  }
  const p = ledgerPath();
  let r;
  try {
    r = forceUnlock({ ledgerPath: p, by });
  } catch (e) {
    fail(e);
  }
  console.log(r.removed ? `lock removed by ${by}: ${p}.lock` : `no lock present: ${p}.lock`);
} else if (cmd === '--version' || cmd === '-v') {
  console.log(pkg.version);
} else {
  console.log(USAGE);
  process.exit(cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2);
}
