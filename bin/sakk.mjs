#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  initLedger,
  readLedger,
  totalsOf,
  ledgerStatus,
  clearReconciliation,
  forceUnlock,
  halt,
  resume,
  LedgerError,
  DEFAULT_MAX_AGE_MS,
} from '../src/ledger.mjs';
import { loadPolicy } from '../src/policy.mjs';
import { startMcpServer } from '../src/mcp.mjs';
import { display, scanPaths, scanStaged, ScanError } from '../src/secret-scan.mjs';
import {
  evaluate,
  normalize,
  runHook,
  readConfig,
  writeConfig,
  sakkHome,
  resolveLedgerPath,
} from '../src/hook.mjs';
import { loadPrices } from '../src/prices.mjs';
import {
  daySpend,
  updateIndex,
  systemZone,
  dayOf,
  claudeLogDir,
  SpendError,
} from '../src/spend.mjs';
import { doctor, install, uninstall } from '../src/guard-install.mjs';
import { readSegment, reindex, segmentsOnDisk, verifyChain } from '../src/archive.mjs';
import { startConsole } from '../src/console.mjs';

/**
 * sakk CLI — the smallest useful surface over the ledger.
 *
 *   sakk init --cap <usd> [--ledger <path>] [--by <name>]
 *   sakk status [--ledger <path>] [--json]
 *   sakk reconcile --by <name> [--ledger <path>]
 *   sakk halt|resume --by <name> [--agent <id>] [--ledger <path>]
 *
 * Path resolution (resolveLedgerPath, shared with the hook): --ledger flag >
 * the absolute path `sakk init` recorded in ~/.sakk/config.json >
 * SAKK_LEDGER_PATH > ~/.sakk/sakk-ledger.json (the CLI's one explicit
 * default, inside the guard's protected zone since D11/F-177 — always
 * printed, never guessed silently; a leftover ./sakk-ledger.json refuses
 * with LEDGER_PATH_LEGACY; the library itself keeps no default at all).
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

/** The ledger by the hook's own rule (resolveLedgerPath), so a halt lands where the hook reads. */
function ledgerFrom(fallback) {
  const flagged = val('ledger');
  let config = {};
  if (flagged === undefined)
    try {
      config = readConfig(sakkHome());
    } catch (e) {
      console.error(String(e.message));
      process.exit(1);
    }
  const r = resolveLedgerPath({ flag: flagged, config, fallback });
  const envPath = process.env.SAKK_LEDGER_PATH;
  if (r.from === 'config' && envPath && resolve(envPath) !== r.path)
    console.error(
      `note: using ${r.path} from ${join(sakkHome(), 'config.json')}; SAKK_LEDGER_PATH (${envPath}) is not used — pass --ledger to choose another`,
    );
  return r;
}

function ledgerPath() {
  // The default ledger lives under SAKK_HOME (D11, F-177): a ledger in the
  // project cwd is a file the agent may write, so one agent could lift a
  // halt on another by editing it. Under ~/.sakk it sits in the guard's
  // protected zone (protect-guard-state denies the write).
  const r = ledgerFrom(join(sakkHome(), 'sakk-ledger.json'));
  // set-but-empty is a mistake, not "use the current directory" (ledger review N2)
  if (r.from === 'env-empty') {
    console.error('LEDGER_PATH_REQUIRED: SAKK_LEDGER_PATH is set but empty');
    process.exit(2);
  }
  // Migration (three-tables spec, specs/spend/v2-line-c-three-tables.md): a
  // ledger at the pre-v2 default must not be silently abandoned OR silently
  // kept authoritative — refuse and let a person choose.
  if (
    r.from === 'default' &&
    resolve('sakk-ledger.json') !== r.path &&
    existsSync(resolve('sakk-ledger.json'))
  ) {
    console.error(
      `LEDGER_PATH_LEGACY: ./sakk-ledger.json exists here, but the default ledger now lives at ${r.path} — pass --ledger ./sakk-ledger.json to keep using this file, or move it to ${r.path}; nothing was read or changed`,
    );
    process.exit(2);
  }
  return r.path;
}
/** A name, not whitespace: self-declared and never verified (ledger review N1; F-70; F-126). */
const named = (by) => typeof by === 'string' && by.trim() !== '';

/**
 * A change that loosens a control the agent is bound by (lifting or raising
 * the cap, removing the guard) goes ahead only once a person retypes `word`
 * at this terminal. A run with no terminal — an agent's tool call, a script —
 * refuses, and nothing changes (F-171). This is not proof of a person: a
 * process that makes its own pseudo-terminal can answer; the hook asks before
 * the commands that do that (docs/GUARD.md).
 */
async function confirmByPerson(change, word) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    console.error(
      `HUMAN_CONFIRMATION_REQUIRED: ${change} — a person confirms this at a terminal, and this run has none; nothing changed`,
    );
    process.exit(2);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((done) => {
    rl.on('close', () => done(null));
    rl.on('SIGINT', () => rl.close());
    rl.question(
      `${change}.\nAn agent must not make this change, so a person confirms it here. Type ${word} to go ahead: `,
      done,
    );
  });
  rl.close();
  if (answer?.trim() !== word) {
    console.error(`HUMAN_CONFIRMATION_REQUIRED: the answer was not ${word}; nothing changed`);
    process.exit(2);
  }
}

// Human display only — JSON keeps raw numbers. 6 decimals, trailing zeros
// trimmed, so the 1e-6 reserve guard never prints a float tail.
const usd = (n) =>
  `$${Number(n)
    .toFixed(6)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '')}`;

const USAGE = `sakk ${pkg.version} — fail-closed spend ledger for AI agents

Usage:
  sakk init --cap <usd> [--ledger <path>] [--by <name>]   create a ledger (refuses to overwrite)
  sakk status [--ledger <path>] [--json]                  totals, entries, reconciliation state
  sakk reconcile --by <name> [--ledger <path>]            clear the reconciliation flag (named)
  sakk unlock --by <name> [--ledger <path>]               break a stuck lock by hand (named)
  sakk halt --by <name> [--reason <t>] [--agent <id>]     kill switch: refuse all new spending (named)
  sakk resume --by <name> [--agent <id>]                  lift a halt (named)
  sakk mcp --ledger <path> [--policy <path>]              MCP stdio server: reserve/settle/status as tools
  sakk ledger verify [--ledger <path>]                    walk the cold trail's chain and index (exit 1 if broken)
  sakk ledger export [--out <file>] [--ledger <path>]     rebuild one flat ledger from cold + hot
  sakk ledger reindex [--ledger <path>]                   rebuild the call-id index from the cold trail
  sakk scan <paths...> | --staged | --install-hook        find secrets (fingerprints only; exit 1 on findings)

The agent guard:
  sakk guard install|uninstall <agent> [--user]          add or remove the hook (claude-code | cursor | codex; removing asks you to confirm)
  sakk try "<command>" [--read <path>] [--json]           how the guard would judge a command (nothing runs)
  sakk doctor [--json]                                    check the guard really fires where you work
  sakk hook --agent <agent>                               the hook itself: payload on stdin (installed for you)
  sakk ui [--port N] [--allow-halt] [--ledger <path>]     a local, read-only console on 127.0.0.1 (token in the URL)

Spend and the daily cap (from Claude Code's local logs; an estimate, not the invoice):
  sakk cap set <usd> [--zone <IANA>]                      a daily cap the hook enforces at the next call (raising it asks you to confirm)
  sakk cap off                                            lift the cap (asks you to confirm)
  sakk spend [--day <YYYY-MM-DD>] [--json]                today's spend by model, and what could not be priced
  sakk prices [--json]                                    the price table in use and its source

Ledger path: --ledger > the one init recorded in ~/.sakk/config.json (the hook reads it too) > $SAKK_LEDGER_PATH > ~/.sakk/sakk-ledger.json
  (a leftover ./sakk-ledger.json refuses with LEDGER_PATH_LEGACY until you pass --ledger or move it)
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

// Every flag each command accepts. Anything else refuses (exit 2) instead of
// being ignored: `sakk resume --by op --agent=bot` used to lift the GLOBAL
// halt because the `=` form was not recognised (verify pass S1).
const COMMANDS = {
  init: { values: ['cap', 'ledger', 'by'], bools: [] },
  status: { values: ['ledger'], bools: ['json'] },
  reconcile: { values: ['by', 'ledger'], bools: [] },
  unlock: { values: ['by', 'ledger'], bools: [] },
  halt: { values: ['by', 'reason', 'agent', 'ledger'], bools: [] },
  resume: { values: ['by', 'agent', 'ledger'], bools: [] },
  mcp: { values: ['ledger', 'policy'], bools: [] },
  ledger: { values: ['ledger', 'out'], bools: [], positional: true },
  scan: { values: [], bools: ['staged', 'install-hook'], positional: true },
  hook: { values: ['agent'], bools: [] },
  try: { values: ['read'], bools: ['json'], positional: true },
  guard: { values: [], bools: ['user'], positional: true },
  doctor: { values: [], bools: ['json'] },
  ui: { values: ['port', 'ledger'], bools: ['allow-halt'] },
  cap: { values: ['zone'], bools: [], positional: true },
  spend: { values: ['day'], bools: ['json'] },
  prices: { values: [], bools: ['json'] },
};
if (Object.hasOwn(COMMANDS, cmd)) {
  const spec = COMMANDS[cmd];
  const seen = new Set();
  const usage = (code, msg) => {
    console.error(`${code}: ${msg} — see sakk --help`);
    process.exit(2);
  };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (/^--[^=]+=/.test(a)) usage('USAGE_EQUALS_FORM', `write "${a.replace('=', ' ')}"`);
    if (!a.startsWith('--')) {
      if (!spec.positional) usage('USAGE_UNKNOWN_ARGUMENT', `"${a}" is not an argument of ${cmd}`);
      continue;
    }
    const name = a.slice(2);
    if (!spec.values.includes(name) && !spec.bools.includes(name))
      usage('USAGE_UNKNOWN_ARGUMENT', `${a} is not a flag of ${cmd}`);
    if (seen.has(name)) usage('USAGE_REPEATED_FLAG', `${a} given more than once`);
    seen.add(name);
    if (spec.values.includes(name)) i += 1; // val() refuses a missing value
  }
}

if (cmd === 'init') {
  const capArg = val('cap');
  // plain decimals only: Number() also accepts 0x10, 1e3 and ' 5' (review N12)
  const cap = /^\d+(\.\d+)?$/.test(capArg ?? '') ? Number(capArg) : NaN;
  if (!Number.isFinite(cap) || cap <= 0) {
    console.error('init requires --cap <usd> (a positive number)');
    process.exit(2);
  }
  const p = ledgerPath();
  if (val('by') !== undefined && !named(val('by'))) {
    console.error('init --by needs a name');
    process.exit(2);
  }
  let refused = null;
  try {
    initLedger({ ledgerPath: p, capUsd: cap, initializedBy: val('by') ?? 'sakk-cli' });
  } catch (e) {
    if (!(e instanceof LedgerError && e.code === 'LEDGER_ALREADY_EXISTS')) fail(e);
    refused = e;
  }
  if (!refused) console.log(`ledger created: ${p}`);
  // Record the ledger for the hook so `sakk halt` reaches it (F-172). Re-running
  // init wires an existing ledger too, and never replaces a different recorded one.
  const home = sakkHome();
  let recorded;
  try {
    if (refused) readLedger({ ledgerPath: p, maxAgeMs: Number.POSITIVE_INFINITY });
    recorded = readConfig(home).ledgerPath;
  } catch (e) {
    console.error(`the hook is not wired to ${p}: ${String(e.message)}`);
    if (refused) fail(refused);
    process.exit(1);
  }
  const configFile = join(home, 'config.json');
  if (typeof recorded !== 'string' || recorded === '') {
    writeConfig(home, { ledgerPath: p });
    console.log(`hook wired: a halt on this ledger now stops the guarded agent (${configFile})`);
  } else if (resolve(recorded) !== p)
    console.error(
      `note: the hook still reads halts from ${recorded} (${configFile}); this ledger is not wired — change ledgerPath there to switch`,
    );
  if (refused) fail(refused);
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
  // one function with the console's ledger page, so the two cannot drift
  const out = ledgerStatus({ ledgerPath: p, doc });
  const t = totalsOf(doc);
  const byStatus = out.entries;
  const reco = out.reconciliation_required;
  const stale = out.stale;
  if (flag('json')) {
    console.log(JSON.stringify(out, null, 1));
  } else {
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
    // names and reasons are operator input: escaped like file names, so a
    // hostile `--by` cannot write terminal control sequences (review nit)
    if (out.halted)
      console.log(
        `⛔ HALTED by ${display(out.halted.by)} at ${out.halted.at}${out.halted.reason ? ` — ${display(out.halted.reason)}` : ''} (all new spending refused)`,
      );
    for (const [id, r] of Object.entries(out.halted_agents))
      console.log(
        `⛔ agent ${display(id)} halted by ${display(r.by)} at ${r.at}${r.reason ? ` — ${display(r.reason)}` : ''}`,
      );
    // the reason embeds agent-chosen callIds: escaped like every other name (S7)
    if (reco)
      console.log(
        `⚠ RECONCILIATION REQUIRED: ${display(String(out.reconciliation_reason ?? 'an entry awaits reconciliation'))}`,
      );
    if (stale)
      console.log(
        `⚠ STALE: the books were last confirmed ${doc.updatedAt} (more than 7 days ago) — every reserve refuses until a person checks them and runs \`sakk reconcile --by <name>\``,
      );
  }
  // 3 = a person must act before spending resumes (reconciliation or stale)
  process.exit(out.halted ? 4 : reco || stale ? 3 : 0);
} else if (cmd === 'reconcile') {
  const by = val('by');
  if (!named(by)) {
    console.error('reconcile requires --by <name> — clearing the books takes a name');
    process.exit(2);
  }
  const p = ledgerPath();
  // Stranger-test finding: claiming "cleared" on a ledger that required no
  // clearing misreports an action that never happened. Say so instead.
  // Read like the operation reads (review S3): a stale ledger is exactly
  // what a named reconcile is for.
  let doc;
  try {
    doc = readLedger({ ledgerPath: p, maxAgeMs: Number.POSITIVE_INFINITY });
  } catch (e) {
    fail(e);
  }
  const stale = Date.now() - Date.parse(doc.updatedAt) > DEFAULT_MAX_AGE_MS;
  if (doc.flags?.reconciliationRequired !== true && !stale) {
    console.log(`nothing to clear: no reconciliation required on ${p}`);
    process.exit(0);
  }
  // Clearing the books loosens a control the agent is bound by, so a person
  // confirms it at this terminal; the hook denies the command from an agent
  // (F-177, D11). The no-op path above never asks.
  await confirmByPerson(`This clears the books (reconciliation) on ${p}`, 'reconcile');
  try {
    clearReconciliation({ ledgerPath: p, by });
  } catch (e) {
    fail(e);
  }
  console.log(
    `${stale && doc.flags?.reconciliationRequired !== true ? 'stale books confirmed' : 'reconciliation cleared'} by ${display(by)}: ${p}`,
  );
} else if (cmd === 'halt' || cmd === 'resume') {
  const by = val('by');
  if (typeof by !== 'string' || by === '') {
    console.error(`${cmd} requires --by <name> — stopping and restarting spend takes a name`);
    process.exit(2);
  }
  const p = ledgerPath();
  const agentId = val('agent');
  if (agentId === '') {
    // An empty id must not silently widen to "all spending" in either direction.
    console.error(`AGENT_ID_INVALID: --agent needs a non-empty id (exact, case-sensitive)`);
    process.exit(2);
  }
  const scopeText = agentId !== undefined ? `agent ${JSON.stringify(agentId)}` : 'all spending';
  if (cmd === 'resume') {
    // Read first: lifting nothing asks no one (the guard-uninstall precedent).
    // Lifting a halt loosens the control that binds the agent, so a person
    // confirms it; the hook denies the command from an agent (F-177, D11).
    let h;
    try {
      h = readLedger({ ledgerPath: p, maxAgeMs: Number.POSITIVE_INFINITY }).halt;
    } catch (e) {
      fail(e);
    }
    const haltedNow =
      agentId !== undefined
        ? Boolean(h?.agents && Object.hasOwn(h.agents, agentId))
        : Boolean(h?.global);
    if (!haltedNow) {
      // Answer here, without calling resume(): entering the write path now
      // would lift a halt that landed after the unlocked read above, with no
      // confirmation (F-209). reconcile and unlock exit their no-op the same
      // way, before their confirmation and their write.
      console.log(`nothing halted (${scopeText})`);
      process.exit(0);
    }
    await confirmByPerson(`This lifts the halt on ${scopeText} (${p})`, 'resume');
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
  const scope = scopeText;
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
  if (!named(by)) {
    console.error('unlock requires --by <name> — breaking a lock takes a name');
    process.exit(2);
  }
  const p = ledgerPath();
  // No lock, nothing to break, no one asked (the guard-uninstall precedent).
  // Breaking a live lock loosens the serialization every write relies on, so
  // a person confirms it; the hook denies the command from an agent (F-177).
  if (!existsSync(`${p}.lock`)) {
    console.log(`no lock present: ${p}.lock`);
    process.exit(0);
  }
  await confirmByPerson(`This breaks the lock on ${p}`, 'unlock');
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
  const raw = val('ledger') ?? (process.env.SAKK_LEDGER_PATH || undefined);
  // resolved once, here: the host's cwd must not decide where the books are
  // on every call (MCP review N4)
  const p = typeof raw === 'string' && raw !== '' ? resolve(raw) : raw;
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
} else if (cmd === 'scan') {
  // process.exitCode, never process.exit: an early exit truncates piped
  // output (the summary line could be lost behind a slow reader).
  const report = (r) => {
    for (const f of r.findings) console.log(`${f.path}:${f.line}  ${f.rule}  fp=${f.fingerprint}`);
    const skips = Object.entries(r.skipped ?? {})
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    console.log(
      `scanned ${r.scanned} file(s): ${r.findings.length} finding(s), ${r.exempted} exempted (TEST_ONLY_FAKE_SECRET_DO_NOT_USE marker)${skips ? `; skipped ${skips}` : ''}`,
    );
    if (r.unreadable.length > 0) {
      // A scan that could not look everywhere it was told to is not clean.
      console.error(
        `SCAN_UNREADABLE: ${r.unreadable.length} path(s) could not be read: ${r.unreadable.slice(0, 5).join(', ')}`,
      );
      process.exitCode = 2;
    } else process.exitCode = r.findings.length === 0 ? 0 : 1;
  };
  const usage = (msg) => {
    console.error(`SCAN_USAGE: ${msg}`);
    process.exitCode = 2;
  };
  const paths = argv.slice(1).filter((a) => !a.startsWith('--'));
  if (flag('install-hook') && (paths.length > 0 || flag('staged'))) {
    usage('--install-hook takes no paths and no --staged');
  } else if (flag('install-hook')) {
    let hooksDir;
    try {
      hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (e) {
      console.error(
        e.code === 'ENOENT'
          ? 'SCAN_GIT_MISSING: git is not on PATH'
          : 'SCAN_NOT_A_REPO: run --install-hook inside a git repository',
      );
      process.exit(2);
    }
    // pre-merge-commit too: a merge commit never runs pre-commit (review S2)
    const hooks = ['pre-commit', 'pre-merge-commit'].map((h) => join(hooksDir, h));
    // Review S-1: never `npx sakk` at commit time — the hook runs THIS
    // installation by absolute path. An installation inside the npx cache
    // is temporary: once the cache is cleaned every commit would fail.
    const self = realpathSync(fileURLToPath(import.meta.url));
    // npm exec / npx, bunx and pnpm dlx unpack into caches that get cleaned
    if (
      /[\\/]_npx[\\/][0-9a-f]{6,}[\\/]node_modules[\\/]|[\\/]bunx-\d+-|[\\/]pnpm[\\/]dlx[\\/]/.test(
        self,
      )
    ) {
      console.error(
        'SCAN_HOOK_EPHEMERAL: this sakk runs from the temporary npx cache — install it first (npm install --save-dev sakk, or npm install -g sakk), then run the installed `sakk scan --install-hook`',
      );
      process.exit(2);
    }
    const q = (x) => `'${x.replace(/'/g, `'\\''`)}'`;
    // node upgrades (Homebrew Cellar, nvm) move the realpath this pins: say
    // so in sakk's words instead of a bare shell error (review S6)
    const guard = `[ -x ${q(process.execPath)} ] && [ -f ${q(self)} ] || { echo 'sakk: SCAN_HOOK_STALE: the node or sakk this hook runs is gone (node upgraded? sakk moved?) - re-run: sakk scan --install-hook' >&2; exit 1; }`;
    const line = `${q(process.execPath)} ${q(self)} scan --staged || exit 1`;
    const body = `#!/bin/sh\n# installed by sakk scan --install-hook (re-run it if node or sakk moves)\n${guard}\n${line}\n`;
    const exists = (p) => {
      try {
        lstatSync(p); // a dangling symlink exists too
        return true;
      } catch {
        return false;
      }
    };
    const taken = hooks.find(exists);
    if (taken) {
      console.error(
        `SCAN_HOOK_EXISTS: ${taken} already exists — nothing installed; add these lines to your pre-commit and pre-merge-commit hooks instead:\n  ${guard}\n  ${line}`,
      );
      process.exit(2);
    }
    const written = [];
    try {
      for (const hook of hooks) {
        // 'wx' = O_EXCL: refuses ANY existing entry, a dangling symlink
        // included, so an existing hook is never overwritten or written through.
        writeFileSync(hook, body, { flag: 'wx', mode: 0o755 });
        written.push(hook);
        chmodSync(hook, 0o755); // the create mode is masked by umask; git ignores a non-executable hook
      }
    } catch (e) {
      for (const w of written) rmSync(w, { force: true }); // both or neither
      if (e.code === 'EEXIST') {
        console.error(`SCAN_HOOK_EXISTS: a hook appeared while installing — nothing installed`);
        process.exit(2);
      }
      if (e.code === 'ENOENT') {
        console.error(`SCAN_HOOK_DIR_MISSING: ${hooksDir} does not exist (check core.hooksPath)`);
        process.exit(2);
      }
      console.error(
        `SCAN_HOOK_UNWRITABLE: ${hooksDir} hooks could not be written (${e.code ?? e.message})`,
      );
      process.exit(2);
    }
    console.log(
      `pre-commit and pre-merge-commit hooks installed in ${hooksDir} — commits and merge commits containing recognized secrets will be refused. Not covered by any git hook: fast-forward merges, rebases, cherry-picks, --no-verify. Run \`sakk scan .\` in CI as well.`,
    );
  } else if (flag('staged') && paths.length > 0) {
    usage('--staged scans the index and takes no paths — run the two scans separately');
  } else if (!flag('staged') && paths.length === 0) {
    usage('scan requires paths, --staged, or --install-hook');
  } else {
    try {
      report(flag('staged') ? scanStaged() : scanPaths(paths));
    } catch (e) {
      // git's own stderr can carry paths: escaped and redacted like any name (review N5)
      console.error(
        e instanceof ScanError ? e.message : `SCAN_FAILED: ${display(String(e.code ?? e.message))}`,
      );
      process.exitCode = 2;
    }
  }
} else if (cmd === 'hook') {
  // never a crash, never a prompt: whatever happens, the agent gets an answer
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    /* an unreadable stdin is an empty payload: runHook denies it */
  }
  const out = runHook(val('agent'), raw);
  if (out) process.stdout.write(out);
} else if (cmd === 'try') {
  const words = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--read');
  const read = val('read');
  if ((words.length === 0) === (read === undefined)) {
    console.error(
      'TRY_USAGE: give one command in quotes, or --read <path> — e.g. sakk try "git push --force"',
    );
    process.exit(2);
  }
  const payload = {
    hook_event_name: 'PreToolUse',
    cwd: process.cwd(),
    session_id: 'sakk-try',
    tool_use_id: `try-${Date.now()}`,
    ...(read === undefined
      ? { tool_name: 'Bash', tool_input: { command: words.join(' ') } }
      : { tool_name: 'Read', tool_input: { file_path: resolve(read) } }),
  };
  let r;
  try {
    r = evaluate(normalize('claude-code', payload), { log: false });
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
  if (flag('json')) {
    console.log(
      JSON.stringify(
        {
          verdict: r.verdict,
          reason: r.reason,
          policy: r.policyPath,
          policyHash: r.policyHash,
          decisions: r.decisions.map((d) => ({
            action: d.context.action,
            scope: d.context.scope ?? null,
            verdict: d.verdict,
            rule: d.ruleId,
          })),
        },
        null,
        1,
      ),
    );
  } else {
    for (const d of r.decisions)
      console.log(
        `${d.verdict.padEnd(16)} ${d.context.action}${d.context.scope ? ` ${display(d.context.scope)}` : ''}  (rule ${d.ruleId ?? 'default'})`,
      );
    console.log(
      `→ ${r.verdict === 'require_approval' ? 'ask you first' : r.verdict}${r.reason ? `\n${r.reason}` : ''}`,
    );
    console.log(`policy ${r.policyPath} (sha256 ${r.policyHash.slice(0, 12)}…)`);
  }
} else if (cmd === 'guard') {
  const [action, agent] = argv.slice(1).filter((a) => !a.startsWith('--'));
  if (
    !['install', 'uninstall'].includes(action) ||
    !['claude-code', 'cursor', 'codex'].includes(agent)
  ) {
    console.error('GUARD_USAGE: sakk guard install|uninstall claude-code|cursor|codex [--user]');
    process.exit(2);
  }
  let r;
  try {
    if (action === 'uninstall') {
      const plan = uninstall(agent, { user: flag('user'), dryRun: true });
      if (plan.changed) await confirmByPerson(`This removes the guard from ${plan.path}`, agent);
    }
    r = (action === 'install' ? install : uninstall)(agent, { user: flag('user') });
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
  if (!r.changed) console.log(`${agent}: nothing to change in ${r.path}`);
  else
    console.log(
      `${agent}: ${action === 'install' ? 'guard added to' : 'guard removed from'} ${r.path}${r.backup ? ` (previous file kept at ${r.backup})` : ''}${r.onFailure ? '; a hook that fails to run blocks the call (onFailure: block)' : ''}`,
    );
  // A degraded, fail-open install is a success WITH A WARNING, never a quiet
  // success with a shorter line. On a Claude Code too old for onFailure
  // (< 2.1.295) the guard cannot fail closed, so say so to the operator
  // explicitly rather than leave the lost guarantee to be inferred from an
  // absent clause (F-174).
  if (action === 'install' && agent === 'claude-code' && !r.onFailure)
    console.log(
      '! claude-code: this Claude Code is too old for onFailure (needs 2.1.295+), so the guard is installed FAIL-OPEN — if the hook ever fails to start, the tool call proceeds UNGUARDED. Upgrade Claude Code and reinstall for a fail-closed guard; sakk doctor flags this.',
    );
  if (action === 'install') console.log('next: sakk doctor — it checks the hook really fires');
} else if (cmd === 'doctor') {
  const checks = doctor();
  if (flag('json')) console.log(JSON.stringify(checks, null, 1));
  else
    for (const c of checks)
      console.log(`${c.ok ? (c.warn ? '!' : '✓') : '✗'} ${c.name} — ${c.detail}`);
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
} else if (cmd === 'ledger') {
  const sub = argv[1];
  if (sub !== 'verify' && sub !== 'export' && sub !== 'reindex') {
    console.error(
      'USAGE_UNKNOWN_ARGUMENT: sakk ledger verify | export [--out <file>] | reindex [--ledger <path>] — see sakk --help',
    );
    process.exit(2);
  }
  const p = ledgerPath();
  let doc;
  try {
    doc = readLedger({ ledgerPath: p, maxAgeMs: Number.POSITIVE_INFINITY });
  } catch (e) {
    fail(e);
  }
  const archive = doc.archive ?? { segments: 0, settledCount: 0, settledUsd: 0, tip: '' };
  if (sub === 'verify') {
    // walk the whole cold chain; a broken or lost segment exits non-zero so CI can gate on it
    try {
      const got = verifyChain(p, archive);
      const onDisk = segmentsOnDisk(p);
      // fewer segments than the summary claims is a lost segment (broken); more
      // is a harmless crash orphan (a seal wrote a segment, then the hot commit
      // did not land, so the summary never counted it) — the chain is still sound
      if (onDisk < got.segments) {
        console.error(
          `LEDGER_ARCHIVE_BROKEN: ${onDisk} cold segment file(s) on disk, summary says ${got.segments}`,
        );
        process.exit(1);
      }
      console.log(
        `ledger verify: sound — ${got.segments} segment(s), ${got.settledCount} sealed call(s), ${usd(got.settledUsd)} sealed; chain tip matches`,
      );
      process.exit(0);
    } catch (e) {
      console.error(
        `${e.code ?? 'LEDGER_ARCHIVE_BROKEN'}: ${String(e.message).replace(/^[A-Z_]+: /, '')}`,
      );
      process.exit(1);
    }
  } else if (sub === 'export') {
    // rebuild one flat ledger from cold + hot: the whole history as it would
    // read before the hot/cold split, for audit or portability
    let entries = [];
    try {
      for (let seq = 1; seq <= archive.segments; seq++)
        entries.push(...readSegment(p, seq).entries);
    } catch (e) {
      console.error(
        `${e.code ?? 'LEDGER_ARCHIVE_BROKEN'}: ${String(e.message).replace(/^[A-Z_]+: /, '')}`,
      );
      process.exit(1);
    }
    entries.push(...doc.entries);
    const flat = {
      schema: doc.halt ? 'sakk-ledger.v2' : 'sakk-ledger.v1',
      initializedAt: doc.initializedAt,
      initializedBy: doc.initializedBy,
      capUsd: doc.capUsd,
      flags: doc.flags,
      entries,
      updatedAt: doc.updatedAt,
      ...(doc.halt ? { halt: doc.halt } : {}),
    };
    const out = `${JSON.stringify(flat, null, 1)}\n`;
    const dest = val('out');
    if (dest) {
      // wx: never overwrite an existing file or write through a planted symlink.
      // Wrap it in the typed CLI error form, not a raw Node stack (F-105 review).
      try {
        writeFileSync(resolve(dest), out, { flag: 'wx' });
      } catch (e) {
        console.error(
          `LEDGER_EXPORT_FAILED: cannot write ${resolve(dest)}: ${e.code ?? e.message}`,
        );
        process.exit(1);
      }
      console.log(
        `ledger export: ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} written to ${resolve(dest)}`,
      );
    } else process.stdout.write(out);
    process.exit(0);
  } else if (sub === 'reindex') {
    // rebuild the call-id index from the cold trail, for recovery after an index loss
    try {
      const n = reindex(p, archive);
      console.log(
        `ledger reindex: rebuilt ${n} index shard(s) from ${archive.segments} segment(s)`,
      );
      process.exit(0);
    } catch (e) {
      console.error(
        `${e.code ?? 'LEDGER_ARCHIVE_BROKEN'}: ${String(e.message).replace(/^[A-Z_]+: /, '')}`,
      );
      process.exit(1);
    }
  }
} else if (cmd === 'cap') {
  // set or lift the daily spend cap the hook enforces. A person runs this: the
  // hook denies the agent `sakk cap` like any write to ~/.sakk, and lifting or
  // raising a cap, or moving its day, asks a person at the terminal (F-171).
  const sub = argv[1];
  const home = sakkHome();
  if (sub !== 'off' && sub !== 'set') {
    console.error('CAP_USAGE: sakk cap set <usd> [--zone <IANA>] | sakk cap off');
    process.exit(2);
  }
  let cap;
  let zone;
  if (sub === 'set') {
    const amt = argv[2];
    cap = /^\d+(\.\d+)?$/.test(amt ?? '') ? Number(amt) : NaN;
    if (!Number.isFinite(cap) || cap <= 0) {
      console.error('CAP_USAGE: sakk cap set <usd> — a positive number (e.g. sakk cap set 5)');
      process.exit(2);
    }
    zone = val('zone');
    if (zone !== undefined) {
      try {
        new Intl.DateTimeFormat('en-CA', { timeZone: zone });
      } catch {
        console.error(`CAP_ZONE_INVALID: ${zone} is not an IANA time zone (e.g. Asia/Dubai)`);
        process.exit(2);
      }
    }
  }
  // a pre-existing malformed/symlinked config.json makes writeConfig's merge
  // read throw; report it as a typed error, not an uncaught stack (spend/cap review)
  try {
    const was = readConfig(home);
    if (typeof was.capUsd === 'number') {
      const day = (z) => z ?? was.timeZone ?? systemZone();
      if (sub === 'off') await confirmByPerson(`This lifts the daily cap of $${was.capUsd}`, 'off');
      else if (cap > was.capUsd)
        await confirmByPerson(`This raises the daily cap from $${was.capUsd} to $${cap}`, argv[2]);
      else if (day(zone) !== day(undefined))
        await confirmByPerson(
          `This moves the cap's day from ${day(undefined)} to ${zone}, which can start a new day early`,
          zone,
        );
    }
    if (sub === 'off') {
      writeConfig(home, { capUsd: undefined });
      console.log(
        `cap off: ${join(home, 'config.json')} — no daily cap; spend no longer gates paid calls`,
      );
    } else {
      writeConfig(home, { capUsd: cap, ...(zone !== undefined ? { timeZone: zone } : {}) });
      console.log(
        `cap set: $${cap}/day${zone ? ` (${zone})` : ''} in ${join(home, 'config.json')} — the hook denies paid calls once today's spend from local logs reaches it`,
      );
    }
  } catch (e) {
    fail(e);
  }
} else if (cmd === 'spend') {
  const home = sakkHome();
  const dayArg = val('day');
  if (dayArg !== undefined) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayArg);
    const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    // reject an impossible date (2026-13-40, 2026-02-30): the parts must round-trip
    const real =
      d &&
      d.getUTCFullYear() === +m[1] &&
      d.getUTCMonth() === +m[2] - 1 &&
      d.getUTCDate() === +m[3];
    if (!real) {
      console.error('SPEND_USAGE: --day must be a real calendar date, YYYY-MM-DD');
      process.exit(2);
    }
  }
  let config;
  try {
    config = readConfig(home);
  } catch (e) {
    fail(e);
  }
  const { table } = loadPrices({ home });
  const zone = config.timeZone || systemZone();
  const day = dayArg ?? dayOf(Date.now(), zone);
  const logDir = config.claudeLogDir || claudeLogDir(process.env);
  let indexNote = '';
  try {
    // an explicit historical --day scans all files (their mtime is old); today
    // only needs files touched in the last 36 h (spend/cap review: no false $0)
    const idx = updateIndex({
      home,
      logDir,
      zone,
      since: dayArg !== undefined ? 0 : Date.now() - 36 * 3600 * 1000,
    });
    // a folder that cannot be listed is uncounted spend, not $0: a seemingly
    // credible low figure must not be reported (F-204, UAT S-REL-002)
    if (idx.unlistable.length) {
      console.error(
        `SPEND_LOGS_UNLISTABLE: ${idx.unlistable.length} path(s) under ${logDir} could not be read, so spend cannot be counted — fix the permissions and run sakk spend again:`,
      );
      for (const u of idx.unlistable) console.error(`  ${display(u.path)} (${u.code})`);
      process.exit(1);
    }
  } catch (e) {
    if (!(e instanceof SpendError)) throw e;
    indexNote = ` (index not refreshed: ${e.code})`;
  }
  const s = daySpend({ home, day, table });
  const unpriced = Object.keys(s.unpriced);
  const out = {
    day,
    zone,
    cap_usd: config.capUsd ?? null,
    spend_usd: s.usd,
    calls: s.calls,
    future: s.future,
    backdated: s.backdated,
    by_model: s.byModel,
    unpriced: s.unpriced,
    unreadable: s.unreadable,
    source: 'from local logs',
  };
  if (flag('json')) console.log(JSON.stringify(out, null, 1));
  else {
    console.log(
      `spend ${day} (${zone}, from local logs): ${usd(s.usd)}${config.capUsd !== undefined ? ` of ${usd(config.capUsd)} cap` : ' (no cap set)'}${indexNote}`,
    );
    for (const [m, c] of Object.entries(s.byModel)) console.log(`  ${display(m)}  ${usd(c)}`);
    if (unpriced.length)
      console.log(
        `  unpriced: ${unpriced.map(display).join(', ')} — add it to ${join(home, 'prices.json')}`,
      );
    if (s.future)
      console.log(`  ${s.future} call(s) dated in the future — counted on the day observed`);
    if (s.backdated)
      console.log(
        `  ${s.backdated} call(s) first seen today claiming an earlier day — counted today`,
      );
    if (s.unreadable) console.log(`  ${s.unreadable} log line(s) unreadable today`);
  }
} else if (cmd === 'prices') {
  const home = sakkHome();
  let loaded;
  try {
    loaded = loadPrices({ home });
  } catch (e) {
    console.error(
      `${e.code ?? 'PRICES_UNREADABLE'}: ${String(e.message).replace(/^[A-Z_]+: /, '')}`,
    );
    process.exit(1);
  }
  const models = Object.entries(loaded.table.models ?? loaded.table);
  if (flag('json'))
    console.log(
      JSON.stringify(
        {
          source: loaded.path,
          approximate: Boolean(loaded.table.approximate),
          models: Object.fromEntries(models),
        },
        null,
        1,
      ),
    );
  else {
    console.log(
      `prices: ${models.length} model(s) from ${loaded.path}${loaded.table.approximate ? ' (approximate)' : ''}`,
    );
    for (const [id, m] of models) console.log(`  ${display(id)}  in ${m.input} / out ${m.output}`);
  }
} else if (cmd === 'ui') {
  const portArg = val('port');
  let port = 0;
  if (portArg !== undefined) {
    if (!/^\d+$/.test(portArg) || Number(portArg) > 65535) {
      console.error('UI_PORT_INVALID: --port must be a number 1024-65535 (0 = a free port)');
      process.exit(2);
    }
    port = Number(portArg);
    if (port > 0 && port < 1024) {
      console.error(
        'UI_PORT_PRIVILEGED: choose a port 1024 or higher; privileged ports are refused',
      );
      process.exit(2);
    }
  }
  // the hook's own rule, with no ./sakk-ledger.json guess: the stop button
  // halts exactly the ledger the hook reads (F-172)
  const lp = val('ledger') === '' ? null : ledgerFrom(undefined).path;
  const allowHalt = flag('allow-halt');
  startConsole({ port, allowHalt, cwd: process.cwd(), ledgerPath: lp }).then(
    (c) => {
      console.log(
        `Sakk console: ${c.url}  (read-only${allowHalt ? '; stop enabled' : ''}; Ctrl+C to stop)`,
      );
      process.on('SIGINT', () => c.close().then(() => process.exit(0)));
    },
    (e) => {
      if (e && e.code === 'EADDRINUSE') {
        console.error(`UI_PORT_IN_USE: port ${port} is already in use — choose another --port`);
        process.exit(2);
      }
      const uiCode = 'UI_FAILED';
      console.error(`${uiCode}: ${String(e?.message ?? e)}`);
      process.exit(1);
    },
  );
} else if (cmd === '--version' || cmd === '-v') {
  console.log(pkg.version);
} else {
  console.log(USAGE);
  process.exit(cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2);
}
