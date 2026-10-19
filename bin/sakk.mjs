#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  DEFAULT_MAX_AGE_MS,
} from '../src/ledger.mjs';
import { loadPolicy } from '../src/policy.mjs';
import { startMcpServer } from '../src/mcp.mjs';
import { display, scanPaths, scanStaged, ScanError } from '../src/secret-scan.mjs';

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
  // set-but-empty is a mistake, not "use the current directory" (ledger review N2)
  if (val('ledger') === undefined && process.env.SAKK_LEDGER_PATH === '') {
    console.error('LEDGER_PATH_REQUIRED: SAKK_LEDGER_PATH is set but empty');
    process.exit(2);
  }
  return resolve(val('ledger') ?? process.env.SAKK_LEDGER_PATH ?? 'sakk-ledger.json');
}
/** A name, not whitespace: self-declared and never verified (ledger review N1; F-70; F-126). */
const named = (by) => typeof by === 'string' && by.trim() !== '';

const USAGE = `sakk ${pkg.version} — fail-closed spend ledger for AI agents

Usage:
  sakk init --cap <usd> [--ledger <path>] [--by <name>]   create a ledger (refuses to overwrite)
  sakk status [--ledger <path>] [--json]                  totals, entries, reconciliation state
  sakk reconcile --by <name> [--ledger <path>]            clear the reconciliation flag (named)
  sakk unlock --by <name> [--ledger <path>]               break a stuck lock by hand (named)
  sakk halt --by <name> [--reason <t>] [--agent <id>]     kill switch: refuse all new spending (named)
  sakk resume --by <name> [--agent <id>]                  lift a halt (named)
  sakk mcp --ledger <path> [--policy <path>]              MCP stdio server: reserve/settle/status as tools
  sakk scan <paths...> | --staged | --install-hook        find secrets (fingerprints only; exit 1 on findings)

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
  scan: { values: [], bools: ['staged', 'install-hook'], positional: true },
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
  try {
    if (val('by') !== undefined && !named(val('by'))) {
      console.error('init --by needs a name');
      process.exit(2);
    }
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
  // the same two sources reserve() refuses on (review S2: status read one)
  const reco =
    doc.flags?.reconciliationRequired === true ||
    doc.entries.some((x) => x.status === 'RECONCILIATION_REQUIRED');
  const stale = Date.now() - Date.parse(doc.updatedAt) > DEFAULT_MAX_AGE_MS;
  const blocked = Boolean(doc.halt?.global) || reco || stale;
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
    // review S2: a figure that does not work when acted on is wrong — when
    // every reserve refuses, nothing is reservable
    max_reservable_usd: blocked ? 0 : Math.max(0, t.capUsd - t.committedUsd - 1e-6),
    entries: byStatus,
    reconciliation_required: reco,
    reconciliation_reason: doc.flags?.reason ?? null,
    halted: doc.halt?.global ?? null,
    halted_agents: doc.halt?.agents ?? {},
    updated_at: doc.updatedAt,
    stale,
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
  if (!named(by)) {
    console.error('unlock requires --by <name> — breaking a lock takes a name');
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
} else if (cmd === '--version' || cmd === '-v') {
  console.log(pkg.version);
} else {
  console.log(USAGE);
  process.exit(cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2);
}
