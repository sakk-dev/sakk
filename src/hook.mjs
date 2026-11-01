// SPDX-License-Identifier: Apache-2.0
//
// The guard hook (specs/guard/spec.md): every tool call an agent makes passes
// through here before it runs.
//
//   1. normalize   the agent's payload → one Event
//   2. classify    the Event → actions with canonical scopes (src/classify.mjs)
//   3. check       halt → spend cap (M2) → guard rules (policy kernel)
//   4. answer      allow (silent) | deny | ask, in the agent's own format
//   5. log         one decision line per action, hash-pinned to the policy
//
// Any error is a deny with a code (decision 2, 2026-10-21): the hook answers
// itself and never relies on the agent's handling of a crash. When the rules
// themselves cannot be read, the failure is isolated (RC-09 review,
// 2026-10-22): a broken project policy gives way to the last one that loaded,
// and with nothing to fall back to the hook still lets the agent read the
// project — every other call is denied with what to fix.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, loadPolicy, logDecision } from './policy.mjs';
import { appendNoFollow, writeFileAtomic } from './append.mjs';
import { loadPrices } from './prices.mjs';
import { capCheck as spendCap } from './spend.mjs';
import { scanText } from './secret-scan.mjs';

/**
 * Every string the payload carries — keys and values, at any depth — joined
 * for one scan. The rule is structural (F-202): a field is scanned because it
 * is there, never because its tool or field name is on a list, so an MCP
 * argument, an unknown tool's input, a path or a pattern is covered like a
 * Write's content. An explicit worklist (no recursion) keeps hostile nesting
 * from overflowing the stack; the work is bounded by MAX_PAYLOAD, since the
 * payload was parsed from at most that many bytes.
 */
function payloadText(p) {
  const parts = [];
  const todo = [p];
  while (todo.length) {
    const v = todo.pop();
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) for (const x of v) todo.push(x);
    else if (v !== null && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) todo.push(k, x);
  }
  return parts.join('\n');
}

/**
 * The guard's step 3 (specs/secret-guard): a call whose payload carries a
 * literal secret anywhere — write content, command or patch text, an MCP or
 * unknown tool's arguments, a path, any field (F-202) — is denied. Returns
 * the first finding { rule, fingerprint } (never the value), or null. A scan
 * error is surfaced as a HookError, so it fails closed. The named surfaces
 * remain as a floor for hand-built events that carry no scanText.
 */
export function secretHit(ev) {
  for (const surface of [ev.scanText, ev.content, ev.command, ev.patch]) {
    if (typeof surface !== 'string' || surface === '') continue;
    let r;
    try {
      r = scanText(surface);
    } catch (e) {
      throw new HookError('HOOK_SECRET_SCAN_FAILED', e.message);
    }
    if (r.findings.length)
      return { rule: r.findings[0].rule, fingerprint: r.findings[0].fingerprint };
  }
  return null;
}
import { readLedger } from './ledger.mjs';
import { patchActions, shellActions, toDecisions } from './classify.mjs';

export const AGENTS = Object.freeze(['claude-code', 'cursor', 'codex']);
export const MAX_PAYLOAD = 1024 * 1024;
// sakk doctor's own probe: logged like any decision (contract row 6), but under
// its own name, so the console never counts it as something an agent tried (F-229)
export const DOCTOR_BY = 'sakk-doctor';
export const DOCTOR_COMMAND = 'git push --force origin main';
const isDoctorProbe = (ev, env) =>
  env.SAKK_DOCTOR === '1' &&
  ev.kind === 'shell' &&
  ev.command === DOCTOR_COMMAND &&
  ev.sessionId === 'doctor' &&
  (ev.agent === 'cursor'
    ? ev.cursorEvent === 'beforeShellExecution' && ev.callId === 'doctor'
    : ev.tool === 'Bash' && ev.callId === 'doctor-fire');
export const DEADLINE_MS = 2000;
export const SHIPPED_POLICY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'policies',
  'guard-default.json',
);

export class HookError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const noGit = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

/** Sakk's own state: config, decision log, spend index. */
export const sakkHome = (env = process.env) =>
  resolve(env.SAKK_HOME || join(env.HOME || homedir(), '.sakk'));

export function readConfig(home) {
  const p = join(home, 'config.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new HookError('HOOK_CONFIG_UNREADABLE', `${p}: ${e.message}`);
  }
}

/**
 * Write Sakk's config atomically — only a person's CLI commands call this
 * (sakk init, cap set/off); the agent is denied writing ~/.sakk by the guard,
 * so it cannot set its own cap. Merges onto the current config so one key's change
 * never drops another (the log folder a cap was set with, say).
 */
export function writeConfig(home, patch) {
  const current = readConfig(home);
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  mkdirSync(home, { recursive: true });
  writeFileAtomic(join(home, 'config.json'), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Where the ledger is — one rule for every command and the hook, so a halt
 * the CLI writes lands where the hook reads (F-172): --ledger, else the
 * absolute path `sakk init` recorded in config.json, else SAKK_LEDGER_PATH,
 * else the caller's fallback (the CLI's SAKK_HOME/sakk-ledger.json; the hook
 * and the console have none). The config outranks the environment because it is the
 * one source the CLI and the hook are both sure to see. `from` names the
 * source; a set-but-empty SAKK_LEDGER_PATH resolves to no path, from 'env-empty'.
 */
export function resolveLedgerPath({ flag, config = {}, env = process.env, fallback } = {}) {
  if (flag !== undefined) return { path: resolve(flag), from: 'flag' };
  if (typeof config.ledgerPath === 'string' && config.ledgerPath !== '')
    return { path: resolve(config.ledgerPath), from: 'config' };
  if (env.SAKK_LEDGER_PATH === '') return { path: null, from: 'env-empty' };
  if (env.SAKK_LEDGER_PATH !== undefined)
    return { path: resolve(env.SAKK_LEDGER_PATH), from: 'env' };
  if (fallback !== undefined) return { path: resolve(fallback), from: 'default' };
  return { path: null, from: null };
}

/** The git top level of `cwd`, or null outside a repository. */
export function repoRootOf(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: noGit(),
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

const text = (v, what) => {
  if (typeof v !== 'string' || v === '')
    throw new HookError('HOOK_PAYLOAD_INVALID', `${what} is missing or not text`);
  return v;
};
const opt = (v) => (typeof v === 'string' && v !== '' ? v : undefined);

/** One Event from each agent's payload (spec "Event"). Unknown shapes refuse. */
export function normalize(agent, p) {
  if (p === null || typeof p !== 'object' || Array.isArray(p))
    throw new HookError('HOOK_PAYLOAD_INVALID', 'the payload is not a JSON object');
  const cwd =
    opt(p.cwd) ?? (Array.isArray(p.workspace_roots) ? opt(p.workspace_roots[0]) : undefined);
  if (!cwd || !isAbsolute(cwd))
    throw new HookError('HOOK_PAYLOAD_INVALID', 'the payload names no absolute cwd');
  const ev = { agent, cwd, paths: [], kind: 'other' };
  ev.scanText = payloadText(p); // every string the payload carries is scanned, whatever the tool (F-202)
  if (agent === 'claude-code' || agent === 'codex') {
    ev.tool = text(p.tool_name, 'tool_name');
    ev.callId = opt(p.tool_use_id);
    ev.sessionId = opt(p.session_id);
    const ti = p.tool_input;
    if (ti === null || typeof ti !== 'object' || Array.isArray(ti))
      throw new HookError('HOOK_PAYLOAD_INVALID', 'tool_input is missing or not an object');
    if (['Bash', 'PowerShell', 'Monitor'].includes(ev.tool)) {
      ev.kind = 'shell';
      ev.command = text(ti.command, 'tool_input.command');
    } else if (ev.tool === 'apply_patch') {
      ev.kind = 'patch';
      ev.patch = text(ti.command ?? ti.patch ?? ti.input, 'tool_input.command');
    } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(ev.tool)) {
      ev.kind = 'write';
      ev.paths = [text(ti.file_path ?? ti.notebook_path, 'tool_input.file_path')];
      ev.content = writeContent(ti); // the new bytes, for the secret scan (M3)
    } else if (ev.tool === 'Read') {
      ev.kind = 'read';
      ev.paths = [text(ti.file_path, 'tool_input.file_path')];
    } else if (ev.tool === 'Grep' || ev.tool === 'Glob') {
      ev.kind = 'read';
      if (opt(ti.path)) ev.paths = [ti.path];
    } else if (ev.tool.startsWith('mcp__')) {
      ev.kind = 'mcp';
      ev.mcp = ev.tool.slice(5).replace('__', '.');
    }
    return ev;
  }
  if (agent === 'cursor') {
    const event = text(p.hook_event_name, 'hook_event_name');
    ev.cursorEvent = event;
    ev.callId = opt(p.tool_use_id) ?? opt(p.generation_id);
    ev.sessionId = opt(p.conversation_id);
    if (event === 'beforeShellExecution') {
      ev.tool = 'Shell';
      ev.kind = 'shell';
      ev.command = text(p.command, 'command');
    } else if (event === 'beforeReadFile') {
      ev.tool = 'Read';
      ev.kind = 'read';
      ev.paths = [text(p.file_path, 'file_path')];
    } else if (event === 'beforeMCPExecution') {
      ev.tool = 'MCP';
      ev.kind = 'mcp';
      ev.mcp = `${opt(p.mcp_server_name) ?? 'unknown'}.${opt(p.tool_name) ?? 'unknown'}`;
    } else if (event === 'preToolUse') {
      ev.tool = text(p.tool_name, 'tool_name');
      const ti = p.tool_input !== null && typeof p.tool_input === 'object' ? p.tool_input : {};
      // the Write/Delete input shape is not documented: every known path key, or refuse
      const path = () => text(ti.file_path ?? ti.path ?? ti.target_file, 'tool_input.file_path');
      if (ev.tool === 'Shell') {
        ev.kind = 'shell';
        ev.command = text(ti.command, 'tool_input.command');
      } else if (ev.tool === 'Read') {
        ev.kind = 'read';
        ev.paths = [path()];
      } else if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(ev.tool)) {
        ev.kind = 'write';
        ev.paths = [
          text(
            ti.file_path ?? ti.notebook_path ?? ti.path ?? ti.target_file,
            'tool_input.file_path',
          ),
        ];
        ev.content = writeContent(ti); // every write surface is scanned, not just Write (F-160)
      } else if (ev.tool === 'Delete') {
        ev.kind = 'delete';
        ev.paths = [path()];
      } else if (ev.tool.startsWith('MCP:')) {
        ev.kind = 'mcp';
        ev.mcp = ev.tool.slice(4);
      }
    } else throw new HookError('HOOK_PAYLOAD_INVALID', `unknown Cursor hook event ${event}`);
    return ev;
  }
  throw new HookError('HOOK_USAGE', `unknown agent ${agent}`);
}

/**
 * The new bytes a write would put on disk, for the secret scan (M3): Write's
 * content, Edit's new_string, MultiEdit's edits joined, NotebookEdit's
 * new_source. Best-effort and string-only — a shape we do not know scans as
 * empty (no secret found), never throws; the guard still judges the path.
 */
function writeContent(ti) {
  const parts = [];
  for (const k of ['content', 'new_string', 'new_str', 'new_source', 'contents']) {
    const v = ti[k];
    if (typeof v === 'string') parts.push(v);
  }
  if (Array.isArray(ti.edits))
    for (const e of ti.edits) {
      const v = e?.new_string ?? e?.new_str;
      if (typeof v === 'string') parts.push(v);
    }
  return parts.join('\n');
}

const MCP_NAME = /[^A-Za-z0-9_.-]/g;

/** The Event's actions with canonical scopes. Unknown tools are shell.run (spec input table). */
export function actionsOf(ev, { repoRoot, sakkHome: home, homeDir }) {
  let raw;
  if (ev.kind === 'shell')
    raw = shellActions(ev.command, ev.cwd, {
      home: homeDir,
      sakkHome: home,
      repoRoot: repoRoot ?? ev.cwd,
    });
  else if (ev.kind === 'patch') raw = patchActions(ev.patch, ev.cwd);
  else if (ev.paths.length) {
    const action =
      ev.kind === 'delete' ? 'file.delete' : ev.kind === 'write' ? 'file.write' : 'file.read';
    raw = ev.paths.map((p) => ({ action, path: resolve(ev.cwd, p) }));
  } else if (ev.kind === 'mcp') raw = [{ action: `mcp.${ev.mcp.replace(MCP_NAME, '_')}` }];
  else if (ev.kind === 'read')
    raw = []; // a search with no path reads the working folder
  else raw = [{ action: 'shell.run' }];
  return toDecisions(raw, { repoRoot: repoRoot ?? ev.cwd, sakkHome: home, homeDir });
}

/** The halt that applies to this agent, from the ledger configured in Sakk's config. */
export function haltFor(agent, ledgerPath) {
  if (!ledgerPath) return { known: false, halt: null };
  let doc;
  try {
    doc = readLedger({ ledgerPath, maxAgeMs: Number.POSITIVE_INFINITY });
  } catch (e) {
    throw new HookError('HOOK_LEDGER_UNREADABLE', `${ledgerPath}: ${e.code ?? e.message}`);
  }
  const h = doc.halt;
  if (!h) return { known: true, halt: null };
  if (h.global) return { known: true, halt: { scope: 'global', ...h.global } };
  const a = h.agents && Object.hasOwn(h.agents, agent) ? h.agents[agent] : undefined;
  return { known: true, halt: a ? { scope: 'agent', ...a } : null };
}

const RANK = { allow: 0, require_approval: 1, deny: 2 };

/** The hash decisions carry while no policy could be read (it names this mode, not a file). */
export const RULES_UNKNOWN_HASH = createHash('sha256')
  .update('sakk-rules-unknown.v1')
  .digest('hex');
const sha = (x) => createHash('sha256').update(x).digest('hex');

/** Where the last project policy that loaded is kept: Sakk's own state, which agents cannot write. */
export function goodPolicyPaths(home, repoRoot) {
  const key = sha(realpathOr(repoRoot)).slice(0, 32);
  const dir = join(home, 'policy-good');
  return { dir, policy: join(dir, `${key}.json`), meta: join(dir, `${key}.meta.json`) };
}
const realpathOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Best effort: an alert Sakk could not write is not a reason to refuse the call it is about. */
function alert(home, record) {
  try {
    mkdirSync(home, { recursive: true });
    appendNoFollow(
      join(home, 'alerts.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
    );
  } catch {
    // the decision log still records the call; `sakk doctor` checks this folder is writable
  }
}

function keepGood(home, repoRoot, policyPath, policyHash) {
  const at = goodPolicyPaths(home, repoRoot);
  try {
    const meta = JSON.parse(readFileSync(at.meta, 'utf8'));
    if (meta.policyHash === policyHash) return;
  } catch {
    // no copy yet, or an unreadable one: write it
  }
  try {
    mkdirSync(at.dir, { recursive: true });
    const tmp = (f) => `${f}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    const raw = readFileSync(policyPath);
    if (sha(raw) !== policyHash) return; // changed since it loaded: keep the copy we have
    const t1 = tmp(at.policy);
    writeFileSync(t1, raw, { flag: 'wx' });
    renameSync(t1, at.policy);
    const t2 = tmp(at.meta);
    writeFileSync(
      t2,
      JSON.stringify({ source: policyPath, policyHash, savedAt: new Date().toISOString() }),
      { flag: 'wx' },
    );
    renameSync(t2, at.meta);
  } catch (e) {
    alert(home, { kind: 'POLICY_GOOD_UNSAVED', policyPath, why: e.code ?? e.message });
  }
}

const policyError = (e) =>
  new HookError(
    e.code === 'POLICY_UNREADABLE'
      ? 'HOOK_POLICY_UNREADABLE'
      : (e.code ?? 'HOOK_POLICY_UNREADABLE'),
    e.message,
  );

/**
 * The policy that judges this call: the project's, or the shipped one when
 * the project has none. A project policy that does not load gives way to the
 * last one that did (kept by keepGood); with no copy, or a copy that does not
 * load either, the rules are unknown and only reading the project goes on.
 */
export function choosePolicy({ repoRoot, home, keep }) {
  const local = repoRoot ? join(repoRoot, '.sakk', 'policy.json') : null;
  if (!(local && existsSync(local))) {
    try {
      return { loaded: loadPolicy({ policyPath: SHIPPED_POLICY }), policyPath: SHIPPED_POLICY };
    } catch (e) {
      return { unknown: policyError(e), policyPath: SHIPPED_POLICY };
    }
  }
  try {
    const loaded = loadPolicy({ policyPath: local });
    if (keep) keepGood(home, repoRoot, local, loaded.policyHash);
    return { loaded, policyPath: local };
  } catch (e) {
    const broken = policyError(e);
    const at = goodPolicyPaths(home, repoRoot);
    try {
      const meta = JSON.parse(readFileSync(at.meta, 'utf8'));
      const loaded = loadPolicy({ policyPath: at.policy });
      if (loaded.policyHash !== meta.policyHash) throw new Error('the kept copy changed');
      return { loaded, policyPath: at.policy, fallback: { broken, local, savedAt: meta.savedAt } };
    } catch {
      return { unknown: broken, policyPath: local };
    }
  }
}

/**
 * Decide one Event. Returns { verdict, reason, decisions, policyPath, policyHash }.
 * `log` false is `sakk try`: the same path, nothing written.
 */
export function evaluate(
  ev,
  { env = process.env, log = true, now = Date.now, capCheck = null } = {},
) {
  const started = now();
  const overdue = () => {
    if (now() - started > DEADLINE_MS)
      throw new HookError('HOOK_DEADLINE', `no answer within ${DEADLINE_MS} ms`);
  };
  const home = sakkHome(env);
  const repoRoot = repoRootOf(ev.cwd);
  // the rules: config (the ledger it names), then the policy; what cannot be
  // read is isolated to "rules unknown" instead of refusing every call
  let unknown = null;
  let config = {};
  try {
    config = readConfig(home);
  } catch (e) {
    unknown = e;
  }
  const chosen = choosePolicy({ repoRoot, home, keep: log });
  unknown ??= chosen.unknown ?? null;
  const { policyPath, fallback } = chosen;
  const loaded = chosen.loaded ?? { policy: null, policyHash: RULES_UNKNOWN_HASH };
  if (fallback && log)
    alert(home, {
      kind: 'POLICY_FALLBACK',
      broken: fallback.local,
      why: fallback.broken.message,
      using: policyPath,
      savedAt: fallback.savedAt,
    });
  overdue();
  const actions = actionsOf(ev, { repoRoot, sakkHome: home, homeDir: env.HOME || homedir() });
  const callId = ev.callId ?? `${ev.agent}-${started}`;
  const decisions = [];
  // 1. halt: a stop outranks every rule; reading the repository stays open
  let known = false;
  let halt = null;
  if (unknown === null)
    try {
      ({ known, halt } = haltFor(ev.agent, resolveLedgerPath({ config, env }).path));
    } catch (e) {
      unknown = e;
    }
  const readsProject = (a) => a.action === 'file.read' && a.scope && !a.scope.startsWith('~');
  // 2. the spend cap (M2) applies to every call once reached. A cap that
  // cannot be checked (unpriced or unreadable spend) is itself a deny, never a
  // pass (spec "Cap": fail closed). Skipped when the rules are already unknown.
  let cap = null;
  if (unknown === null)
    try {
      if (capCheck) cap = capCheck({ home, config, env });
      else if (config.capUsd !== undefined && config.capUsd !== null)
        cap = spendCap({ home, config, table: loadPrices({ home }).table, env, now: now() });
    } catch (e) {
      unknown = e; // a cap that cannot be read refuses every call but the project read
    }
  // 3. the secret guard (specs/secret-guard): a write whose content, or a
  // command/patch whose text, contains a literal secret is denied — scanned
  // once for the whole call. A scan error fails closed via unknown.
  let secret = null;
  if (unknown === null)
    try {
      secret = secretHit(ev);
    } catch (e) {
      unknown = e;
    }
  const secretWhy =
    secret &&
    `a secret (${secret.rule}, fingerprint ${secret.fingerprint}) is in this ${ev.kind === 'shell' ? 'command' : 'content'}; the value is never logged. Remove it or use a reference a person approves. ${DISPUTE}`;
  for (const a of actions) {
    const context = {
      agent: ev.agent,
      action: a.action,
      callId,
      estimatedUsd: 0,
      ...(a.scope ? { scope: a.scope } : {}),
    };
    let d;
    if (unknown !== null)
      d = readsProject(a)
        ? { verdict: 'allow', ruleId: 'rules-unknown', policyHash: loaded.policyHash, context }
        : {
            verdict: 'deny',
            ruleId: 'rules-unknown',
            policyHash: loaded.policyHash,
            context,
            why: `the guard cannot read its rules (${unknown.code ?? 'HOOK_FAILED'}: ${String(unknown.message ?? unknown).replace(/^[A-Z_]+: /, '')}). Reading the project still works; a person fixes the file named above and the next call is judged normally`,
          };
    else if (halt && !readsProject(a))
      d = {
        verdict: 'deny',
        ruleId: 'halt',
        policyHash: loaded.policyHash,
        context,
        why: `halted (${halt.scope}) by ${halt.by} at ${halt.at}${halt.reason ? ` — ${halt.reason}` : ''}; a person resumes with: sakk resume --by <name>${halt.scope === 'agent' ? ` --agent ${ev.agent}` : ''}`,
      };
    else if (cap?.deny)
      d = {
        verdict: 'deny',
        ruleId: 'spend-cap',
        policyHash: loaded.policyHash,
        context,
        why: cap.reason,
      };
    else if (secret)
      d = {
        verdict: 'deny',
        ruleId: 'secret',
        policyHash: loaded.policyHash,
        context,
        why: secretWhy,
      };
    else {
      try {
        d = decide({ policy: loaded.policy, policyHash: loaded.policyHash, context });
      } catch (e) {
        throw new HookError('HOOK_CONTEXT_INVALID', e.message);
      }
    }
    decisions.push(d);
  }
  // "A secret is always a deny" is a call-level floor, not a per-action rule: a
  // comment-only or bare `NAME=<secret>` command tokenizes to zero actions, so
  // the loop above emits nothing and the call would default to allow (F-160).
  if (secretWhy && decisions.length === 0)
    decisions.push({
      verdict: 'deny',
      ruleId: 'secret',
      policyHash: loaded.policyHash,
      context: { agent: ev.agent, action: ev.kind, callId, estimatedUsd: 0 },
      why: secretWhy,
    });
  overdue();
  if (log) {
    const decisionLogPath = join(home, 'decisions.jsonl');
    try {
      mkdirSync(home, { recursive: true });
    } catch (e) {
      throw new HookError('DECISION_UNLOGGABLE', `${home}: ${e.code ?? e.message}`);
    }
    const by = isDoctorProbe(ev, env) ? DOCTOR_BY : ev.agent;
    for (const d of decisions) {
      // the log line keeps decide()'s shape, which is public API: the reason text stays out
      const decision = Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'why'));
      try {
        logDecision({ decisionLogPath, decision, by });
      } catch (e) {
        throw new HookError('DECISION_UNLOGGABLE', e.message);
      }
    }
  }
  const worst = decisions.reduce((w, d) => (RANK[d.verdict] > RANK[w.verdict] ? d : w), {
    verdict: 'allow',
  });
  return {
    verdict: worst.verdict,
    reason: worst.verdict === 'allow' ? '' : reasonOf(worst, policyPath, fallback),
    decisions,
    policyPath,
    policyHash: loaded.policyHash,
    fallback: fallback
      ? { broken: fallback.local, why: fallback.broken.message, savedAt: fallback.savedAt }
      : null,
    rulesUnknown: unknown ? (unknown.code ?? 'HOOK_FAILED') : null,
    haltKnown: known,
  };
}

const DISPUTE = 'If this is wrong, tell the person you work for and stop; do not route around it.';

function reasonOf(d, policyPath, fallback) {
  const what = `${d.context.action}${d.context.scope ? ` ${d.context.scope}` : ''}`;
  if (['halt', 'spend-cap', 'rules-unknown', 'secret'].includes(d.ruleId))
    return `Sakk: ${what} refused — ${d.why}. ${DISPUTE}`;
  if (fallback)
    return `${reasonOf(d, policyPath)} The project policy ${fallback.local} is not in effect (${fallback.broken.message}); Sakk is using the last policy that loaded, kept ${fallback.savedAt}.`;
  const rule = d.ruleId ?? 'the default';
  return d.verdict === 'deny'
    ? `Sakk: ${what} is denied by rule ${rule} (${policyPath}). A person changes the policy; ${DISPUTE}`
    : `Sakk: ${what} needs a person's approval (rule ${rule}, ${policyPath}).`;
}

/** The answer in each agent's own format (spec "Answer per agent"). */
export function answer(ev, verdict, reason) {
  if (ev.agent === 'cursor') {
    if (verdict === 'allow') return JSON.stringify({ permission: 'allow' });
    // ask is enforced only before shell and MCP execution; elsewhere it would let the call run
    const ask =
      verdict === 'require_approval' &&
      ['beforeShellExecution', 'beforeMCPExecution'].includes(ev.cursorEvent);
    return JSON.stringify({
      permission: ask ? 'ask' : 'deny',
      user_message: reason,
      agent_message: reason,
    });
  }
  if (verdict === 'allow') return ''; // silent: Sakk only restricts; the agent's own permissions still apply
  // Codex runs the call on "ask" (decision 3, 2026-10-21): a deny there
  const decision = verdict === 'deny' || ev.agent === 'codex' ? 'deny' : 'ask';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
}

/** The whole hook: raw stdin text in, stdout text out. Never throws. */
export function runHook(agent, raw, opts = {}) {
  let ev = { agent, cursorEvent: undefined };
  try {
    if (!AGENTS.includes(agent))
      throw new HookError('HOOK_USAGE', `--agent must be one of ${AGENTS.join(', ')}`);
    if (typeof raw !== 'string' || raw.length > MAX_PAYLOAD)
      throw new HookError(
        'HOOK_INPUT_TOO_LARGE',
        `the payload is larger than ${MAX_PAYLOAD} bytes`,
      );
    let p;
    try {
      p = JSON.parse(raw);
    } catch {
      throw new HookError('HOOK_PAYLOAD_INVALID', 'the payload is not JSON');
    }
    ev = normalize(agent, p);
    const r = evaluate(ev, opts);
    return answer(ev, r.verdict, r.reason);
  } catch (e) {
    const code = e?.code ?? 'HOOK_FAILED';
    return answer(
      ev,
      'deny',
      `Sakk: refused — ${code}: ${String(e?.message ?? e).replace(/^[A-Z_]+: /, '')}. The guard could not decide, so it denies.`,
    );
  }
}
