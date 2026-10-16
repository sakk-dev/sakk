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
  halt,
  resume,
  LedgerError,
} from '../src/ledger.mjs';
import { loadPolicy } from '../src/policy.mjs';
import { startMcpServer } from '../src/mcp.mjs';

/**
 * sakk CLI — the smallest useful surface over the ledger.
 *
 *   sakk init --cap <usd> [--ledger <path>] [--by <name>]
 *   sakk status [--ledger <path>] [--json]
 *   sakk reconcile --by <name> [--ledger <path>]
 *   sakk halt|resume --by <name> [--agent <id>] [--ledger <path>]
 *
 * Path resolution: --ledger flag > SAKK_LEDGER_PATH > ./sakk-ledger.json
 * (the CLI's one explicit convenience default — always printed, never
 * guessed silently; the library itself keeps no default at all).
 *
 * Exit codes: 0 ok · 1 ledger error (every refusal code on stderr) ·
 * 2 usage error · 3 status: reconciliation required (gate your CI on it) ·
 * 4 status: globally halted. 4 wins over 3 when both hold; the text and
 * --json output show both conditions.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  // A missing value must not swallow the next flag (review finding F3):
  // `--ledger --json` used to create a ledger file literally named --json.
  if (v === undefined || v.startsWith('--')) {
    console.error(`--${n} requires a value`);
    process.exit(2);
  }
  return v;
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
  sakk halt --by <name> [--reason <t>] [--agent <id>]     kill switch: refuse all new spending (signed)
  sakk resume --by <name> [--agent <id>]                  lift a halt (signed)
  sakk mcp --ledger <path> [--policy <path>]              MCP stdio server: reserve/settle/status as tools

Ledger path: --ledger > $SAKK_LEDGER_PATH > ./sakk-ledger.json
Exit codes: 0 ok · 1 ledger error · 2 usage error · 3 reconciliation required (status) · 4 halted (status; wins over 3, both shown)
max_reservable_usd of 0 means nothing fits under the cap (reserve requires a positive amount)
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
    // Review finding E6: remaining is cap-committed, but the cap is a WALL —
    // reserving exactly remaining always refuses. This is the largest
    // amount a reserve() will actually accept.
    max_reservable_usd: Math.max(0, t.capUsd - t.committedUsd - 1e-6),
    entries: byStatus,
    reconciliation_required: reco,
    reconciliation_reason: doc.flags?.reason ?? null,
    halted: doc.halt?.global ?? null,
    halted_agents: doc.halt?.agents ?? {},
    updated_at: doc.updatedAt,
  };
  if (flag('json')) {
    console.log(JSON.stringify(out, null, 1));
  } else {
    // Human display only — JSON keeps raw numbers. 6 decimals, trailing
    // zeros trimmed, so the 1e-6 reserve guard never prints a float tail.
    const usd = (n) =>
      `$${Number(n)
        .toFixed(6)
        .replace(/(\.\d*?)0+$/, '$1')
        .replace(/\.$/, '')}`;
    console.log(`ledger      ${p}`);
    console.log(`cap         ${usd(t.capUsd)}`);
    console.log(`settled     ${usd(t.settledUsd)}`);
    console.log(`outstanding ${usd(t.outstandingUsd)}`);
    console.log(
      `committed   ${usd(t.committedUsd)}  (remaining ${usd(out.remaining_usd)}, max reservable ${usd(out.max_reservable_usd)})`,
    );
    console.log(
      `entries     ${doc.entries.length} (reserved ${byStatus.RESERVED}, settled ${byStatus.SETTLED}, reconciliation ${byStatus.RECONCILIATION_REQUIRED})`,
    );
    console.log(`updated     ${doc.updatedAt}`);
    if (out.halted)
      console.log(
        `⛔ HALTED by ${out.halted.by} at ${out.halted.at}${out.halted.reason ? ` — ${out.halted.reason}` : ''} (all new spending refused)`,
      );
    for (const [id, r] of Object.entries(out.halted_agents))
      console.log(`⛔ agent ${id} halted by ${r.by} at ${r.at}${r.reason ? ` — ${r.reason}` : ''}`);
    if (reco) console.log(`⚠ RECONCILIATION REQUIRED: ${out.reconciliation_reason}`);
  }
  process.exit(out.halted ? 4 : reco ? 3 : 0);
} else if (cmd === 'reconcile') {
  const by = val('by');
  if (typeof by !== 'string' || by === '') {
    console.error('reconcile requires --by <name> — clearing the books takes a signature');
    process.exit(2);
  }
  const p = ledgerPath();
  // Stranger-test finding: claiming "cleared" on a ledger that required no
  // clearing misreports an action that never happened. Say so instead.
  let doc;
  try {
    doc = readLedger({ ledgerPath: p });
  } catch (e) {
    fail(e);
  }
  if (doc.flags?.reconciliationRequired !== true) {
    console.log(`nothing to clear: no reconciliation required on ${p}`);
    process.exit(0);
  }
  try {
    clearReconciliation({ ledgerPath: p, by });
  } catch (e) {
    fail(e);
  }
  console.log(`reconciliation cleared by ${by}: ${p}`);
} else if (cmd === 'halt' || cmd === 'resume') {
  const by = val('by');
  if (typeof by !== 'string' || by === '') {
    console.error(`${cmd} requires --by <name> — stopping and restarting spend takes a signature`);
    process.exit(2);
  }
  const p = ledgerPath();
  const agentId = val('agent');
  if (agentId === '') {
    // An empty id must not silently widen to "all spending" in either direction.
    console.error(`AGENT_ID_INVALID: --agent needs a non-empty id (exact, case-sensitive)`);
    process.exit(2);
  }
  // A runaway storm is exactly when the lock is contended: retry rather
  // than let a kill switch lose a race (specs/kill-switch row 5).
  let r;
  for (let attempt = 1; ; attempt++) {
    try {
      r =
        cmd === 'halt'
          ? halt({ ledgerPath: p, by, reason: val('reason') ?? '', agentId })
          : resume({ ledgerPath: p, by, agentId });
      break;
    } catch (e) {
      if (e instanceof LedgerError && e.code === 'LEDGER_LOCK_UNAVAILABLE' && attempt < 15)
        continue;
      fail(e);
    }
  }
  const scope = agentId !== undefined ? `agent ${JSON.stringify(agentId)}` : 'all spending';
  if (cmd === 'halt')
    console.log(
      r.alreadyHalted
        ? `already halted (${scope}) by ${r.halt.by} at ${r.halt.at} — original record kept`
        : `HALTED ${scope} by ${by}: every new reservation now refuses. Refusals are logged to sakk-alerts.jsonl beside the ledger.`,
    );
  else
    console.log(
      r.wasHalted
        ? `resumed ${scope} by ${by} (was halted by ${r.lifted.by})`
        : `nothing halted (${scope})`,
    );
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
} else if (cmd === 'mcp') {
  // The MCP gate takes NO default ledger path: an MCP server's cwd is
  // whatever the agent host chose, and a gate quietly booking into a
  // guessed file is not a gate (specs/mcp-server/ fail-closed table).
  const p = val('ledger') ?? (process.env.SAKK_LEDGER_PATH || undefined);
  if (typeof p !== 'string' || p === '') {
    console.error(
      'MCP_LEDGER_PATH_REQUIRED: the MCP gate needs an explicit ledger (--ledger or SAKK_LEDGER_PATH)',
    );
    process.exit(2);
  }
  // Review F8: SAKK_POLICY_PATH set-but-empty is a configured policy that
  // cannot load — refusing beats silently running without a gate.
  const envPolicy = 'SAKK_POLICY_PATH' in process.env ? process.env.SAKK_POLICY_PATH : undefined;
  const policyPath = val('policy') ?? envPolicy;
  let loaded = null;
  if (policyPath !== undefined) {
    try {
      loaded = loadPolicy({ policyPath });
    } catch (e) {
      console.error(String(e.message));
      process.exit(2);
    }
  }
  startMcpServer({
    ledgerPath: p,
    loaded,
    decisionLogPath: `${resolve(p)}.decisions.jsonl`,
    input: process.stdin,
    output: process.stdout,
    version: pkg.version,
  });
} else if (cmd === '--version' || cmd === '-v') {
  console.log(pkg.version);
} else {
  console.log(USAGE);
  process.exit(cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2);
}
