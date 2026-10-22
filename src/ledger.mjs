// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 the Sakk authors. Commercial licensing available — see README.
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { appendNoFollow } from './append.mjs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Sakk ledger — the authoritative spend ledger for AI agent actions.
 *
 * ## The single source of cost truth
 *
 * Every potentially paid action (an LLM call, a paid API hit) must RESERVE
 * here before it runs, and SETTLE here after it finishes. Telemetry streams
 * are history, not truth: nothing else participates in the go/no-go decision.
 *
 * ## Fail-closed is this module's entire personality
 *
 * Ledger missing / unreadable / corrupted JSON / wrong schema / stale /
 * cost uncomputable / unresolved reconciliation — every one of these REFUSES
 * new paid calls with a structured error. Nothing is ever treated as "zero
 * spend so far". A fresh ledger can only be created through explicit
 * initialization: an ordinary read failure never auto-creates an empty
 * ledger, because "lost ledger equals free money" is exactly the back door
 * this module exists to close.
 *
 * ## Concurrency and idempotency
 *
 * Read-modify-write runs under a mkdir-based lock (the one correct
 * same-machine primitive), and writes go through temp+rename atomic
 * replacement: two concurrent agents cannot both pass the budget check and
 * jointly overspend. A duplicate callId is refused outright — deduplicated
 * billing with re-executed side effects is precisely how money leaks.
 *
 * ## Accounting rule
 *
 * settled actuals + outstanding reservations (at their estimated maximum,
 * including entries awaiting reconciliation) + this request's estimate
 * **>= capUsd ⇒ refuse**. Reaching the cap counts as exceeding it: the cap
 * is a line you must not touch, not an allowance to fill. Counting
 * outstanding reservations at their maximum is the price of being
 * overdraft-proof under concurrency; settlement releases the difference.
 */

export const LEDGER_SCHEMA = 'sakk-ledger.v1';
/**
 * v2 = v1 + a REQUIRED top-level `halt` record (specs/kill-switch). A ledger
 * becomes v2 the first time it is halted and stays v2: a binary that does
 * not know the kill switch refuses it by schema name instead of spending
 * through a halt it cannot see. Genesis ledgers stay v1 (no `halt` key).
 */
export const LEDGER_SCHEMA_V2 = 'sakk-ledger.v2';

const LEDGER_TOP_KEYS_V1 = [
  'schema',
  'initializedAt',
  'initializedBy',
  'capUsd',
  'flags',
  'entries',
  'updatedAt',
];
// `halt` is TOP-LEVEL on purpose: four code paths rewrite `flags`
// wholesale, so a halt stored there would be silently lifted by a settle.
const LEDGER_TOP_KEYS_V2 = [...LEDGER_TOP_KEYS_V1, 'halt'];
/** Freshness bound: older than this is refused (every write refreshes updatedAt). */
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * F-105 (C-04), first part: every stored input is bounded — 1,500
 * reservations with 4 KB call ids and 1e-300 estimates once grew a ledger to
 * 6 MB and each call to 58 ms. The second part, the books growing with use
 * (each call reads and rewrites the whole file), is the archive's job: no
 * entry cap, nothing dropped (owner's decision, 2026-10-22).
 */
export const LIMITS = Object.freeze({
  idChars: 256,
  nameChars: 256,
  reasonChars: 1024,
  tokensBytes: 4096,
  minEstimateUsd: 1e-6,
});
/**
 * A field that is stored: nullish is kept as null, a string is bounded by
 * length, anything else is refused by type (F-150: an array runId or an
 * object taskId skipped the old string-only check and was stored whole).
 */
function checkLength(field, value, max) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string')
    throw new LedgerError('INPUT_INVALID', `${field} must be a string when given`, {
      field,
      type: typeof value,
    });
  if (value.length > max)
    throw new LedgerError('INPUT_TOO_LONG', `${field} is longer than ${max} characters`, {
      field,
      length: value.length,
    });
}
/** A reason kept for a human: bounded by truncation, never refused (it may quote a long callId). */
const boundReason = (s) => {
  const t = String(s ?? 'unspecified');
  return t.length > LIMITS.reasonChars ? `${t.slice(0, LIMITS.reasonChars - 1)}…` : t;
};
const LOCK_WAIT_MS = 5;
const LOCK_TRIES = 400; // ~2s of spinning, then a structured error — never proceed lockless
/**
 * Conservative float guard on the cap comparison. USD amounts are IEEE
 * doubles; accumulated sums can drift a hair BELOW their true value
 * (10 × 0.1 = 0.9999999999999999), which would let a reservation fill the
 * cap exactly — and the cap is a wall, not a target. The epsilon widens the
 * refusal zone, never the allowance.
 */
const CAP_EPSILON_USD = 1e-9;

export class LedgerError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.code = code;
    this.details = details;
  }
}

/** Resolve the ledger path from SAKK_LEDGER_PATH; there is no silent default. */
export function defaultLedgerPath() {
  if (process.env.SAKK_LEDGER_PATH) return process.env.SAKK_LEDGER_PATH;
  throw new LedgerError(
    'LEDGER_PATH_REQUIRED',
    'No ledger path given and SAKK_LEDGER_PATH is not set — refusing to guess where the money ledger lives',
  );
}

/**
 * One ledger, one path (F-85). The lock and temp names derive from the path
 * string, and the atomic rename replaces whatever NAME it is given: through
 * a symlinked directory two spellings got two locks; through a symlinked or
 * hard-linked file the first write replaced the link with a new file and the
 * books forked (two $6 reservations under a $10 cap). The directory is
 * resolved; a ledger file that is a link refuses.
 */
function canonicalLedgerPath(ledgerPath) {
  if (typeof ledgerPath !== 'string' || ledgerPath === '') return ledgerPath;
  let dir;
  try {
    dir = realpathSync(dirname(ledgerPath));
  } catch {
    return ledgerPath; // a missing directory is reported by the operation itself
  }
  const p = join(dir, basename(ledgerPath));
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return p;
  }
  if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1))
    throw new LedgerError(
      'LEDGER_PATH_NOT_CANONICAL',
      `the ledger file is ${st.isSymbolicLink() ? 'a symbolic link' : 'hard-linked'} — use the one real path; a write would replace the link and fork the books`,
      { ledgerPath },
    );
  return p;
}

function alertsPathFor(ledgerPath) {
  return join(dirname(ledgerPath), 'sakk-alerts.jsonl');
}

/** Structured alert trail: every budget anomaly leaves one greppable line on disk (best effort, never throws). */
function emitAlert(ledgerPath, alert) {
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendNoFollow(
      alertsPathFor(ledgerPath),
      `${JSON.stringify({ at: new Date().toISOString(), ...alert })}\n`,
    );
  } catch {
    /* an alert write failure must not cascade */
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Break a lock whose recorded owner is a dead process on THIS host.
 *
 * Protocol (post-review v2 — the rename-based v1 had a TOCTOU, finding
 * AR-1): breakers serialize on a breaker mutex (`.breaklock`), and the
 * staleness judgement and the removal happen inside that mutex. A fresh
 * legitimate holder is therefore always visible in owner.json before
 * removal, and no second breaker can act on a stale judgement. A breaker
 * that crashes while holding the mutex disables auto-breaking entirely
 * (fail closed) until `sakk unlock` clears both directories.
 *
 * Conservative on every unknown: cross-host owner, live (or
 * permission-denied) pid, unreadable metadata, or a busy breaker mutex all
 * return false and fall through to the timeout refusal.
 */
function breakIfStale(ledgerPath, lock) {
  const breaklock = `${lock}.breaklock`;
  try {
    mkdirSync(breaklock); // one breaker at a time — losers keep spinning
  } catch {
    return false;
  }
  try {
    const o = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
    if (o.host !== hostname() || !Number.isInteger(o.pid)) return false;
    try {
      process.kill(o.pid, 0); // throws ESRCH when no such process
      return false; // alive — the lock is legitimate
    } catch (e) {
      if (e.code !== 'ESRCH') return false; // EPERM etc.: assume alive
    }
    // Judged dead UNDER the breaker mutex: no other breaker can intervene,
    // and a fresh holder would have shown up in owner.json above.
    rmSync(lock, { recursive: true, force: true });
    emitAlert(ledgerPath, { kind: 'STALE_LOCK_BROKEN', deadPid: o.pid, lockedAt: o.at ?? null });
    return true;
  } catch {
    return false; // unreadable metadata: never break what we cannot judge
  } finally {
    rmSync(breaklock, { recursive: true, force: true });
  }
}

/** Human override for a lock that automatic staleness detection will not touch. Requires a name; leaves an alert. */
export function forceUnlock({ ledgerPath = defaultLedgerPath(), by }) {
  ledgerPath = canonicalLedgerPath(ledgerPath);
  if (typeof by !== 'string' || by.trim() === '')
    throw new LedgerError('UNLOCK_BY_REQUIRED', 'Breaking a lock by hand requires a name');
  checkLength('by', by, LIMITS.nameChars);
  const lock = `${ledgerPath}.lock`;
  rmSync(`${lock}.breaklock`, { recursive: true, force: true }); // a crashed breaker parks here
  if (!existsSync(lock)) return { ok: true, removed: false };
  rmSync(lock, { recursive: true, force: true });
  emitAlert(ledgerPath, { kind: 'LOCK_FORCED_OPEN', by });
  return { ok: true, removed: true };
}

// Process-local registry of locks WE hold: release authority by
// construction, with no file read whose error path could be abused (AR-6).
const HELD_LOCKS = new Set();

function acquireLock(ledgerPath) {
  const lock = `${ledgerPath}.lock`;
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
  } catch (e) {
    // a typed refusal, not a raw fs error that crashes the caller (MCP review S1)
    throw new LedgerError(
      'LEDGER_WRITE_FAILED',
      `the ledger directory cannot be created (${e.code ?? e.message})`,
      { ledgerPath },
    );
  }
  for (let i = 0; i < LOCK_TRIES; i += 1) {
    try {
      mkdirSync(lock);
    } catch {
      if (breakIfStale(ledgerPath, lock)) continue; // dead owner cleared — retake at once
      sleepMs(LOCK_WAIT_MS);
      continue;
    }
    try {
      // Owner metadata makes crashed holders detectable (see breakIfStale).
      writeFileSync(
        join(lock, 'owner.json'),
        JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }),
      );
    } catch {
      /* a lock without metadata still mutually excludes; it just needs a human to break */
    }
    HELD_LOCKS.add(lock);
    return lock;
  }
  throw new LedgerError(
    'LEDGER_LOCK_UNAVAILABLE',
    'Timed out acquiring the ledger lock — a live holder, or a crashed one needing `sakk unlock`',
    { ledgerPath },
  );
}

function releaseLock(lock) {
  // Release authority = the process-local registry (we added it when we
  // acquired). Anything else — including unreadable metadata — refuses:
  // the error path of an ownership check must never reopen the door the
  // check closes (review finding AR-6).
  if (!HELD_LOCKS.has(lock)) {
    emitAlert(lock.replace(/\.lock$/, ''), { kind: 'LOCK_RELEASE_MISMATCH' });
    return;
  }
  HELD_LOCKS.delete(lock);
  rmSync(lock, { recursive: true, force: true });
}

const isFiniteNonNeg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const VALID_STATUS = new Set(['RESERVED', 'SETTLED', 'RECONCILIATION_REQUIRED']);

/**
 * Read and validate the ledger. All fail-closed criteria live in this one
 * function; every violation throws a structured error that callers must not
 * soften.
 */
export function readLedger({
  ledgerPath = defaultLedgerPath(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
} = {}) {
  ledgerPath = canonicalLedgerPath(ledgerPath);
  if (!existsSync(ledgerPath))
    throw new LedgerError(
      'LEDGER_MISSING',
      'The authoritative ledger does not exist — paid calls are refused (create one with explicit init)',
      { ledgerPath },
    );
  let raw;
  try {
    // a fifo at the ledger path blocked reserve forever with the lock held
    // (ledger review N3): regular files only
    if (!lstatSync(ledgerPath).isFile())
      throw new LedgerError('LEDGER_UNREADABLE', 'the ledger path is not a regular file', {
        ledgerPath,
      });
    raw = readFileSync(ledgerPath, 'utf8');
  } catch (e) {
    throw new LedgerError('LEDGER_UNREADABLE', 'Ledger cannot be read — paid calls are refused', {
      ledgerPath,
      why: String(e?.code ?? e?.message),
    });
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new LedgerError(
      'LEDGER_MALFORMED',
      'Ledger JSON is corrupted — paid calls are refused until a human reconciles',
      { ledgerPath },
    );
  }
  if (
    doc === null ||
    typeof doc !== 'object' ||
    (doc.schema !== LEDGER_SCHEMA && doc.schema !== LEDGER_SCHEMA_V2)
  )
    throw new LedgerError(
      'LEDGER_SCHEMA_INVALID',
      'Unknown ledger schema — paid calls are refused',
      {
        ledgerPath,
        schema: doc?.schema ?? null,
      },
    );
  if (
    !isFiniteNonNeg(doc.capUsd) ||
    !Array.isArray(doc.entries) ||
    typeof doc.updatedAt !== 'string'
  )
    throw new LedgerError('LEDGER_SCHEMA_INVALID', 'Required fields missing or ill-typed', {
      ledgerPath,
    });
  // flags is a TRUST field (review finding E2): the reconciliation halt
  // lives in it, so a ledger without it is not a valid ledger — otherwise
  // deleting one field would reopen spending without a signed clearance.
  if (
    doc.flags === null ||
    typeof doc.flags !== 'object' ||
    typeof doc.flags.reconciliationRequired !== 'boolean'
  )
    throw new LedgerError(
      'LEDGER_SCHEMA_INVALID',
      'flags.reconciliationRequired missing or ill-typed',
      {
        ledgerPath,
      },
    );
  const updatedAtMs = Date.parse(doc.updatedAt);
  if (!Number.isFinite(updatedAtMs))
    throw new LedgerError('LEDGER_SCHEMA_INVALID', 'updatedAt is not a timestamp', { ledgerPath });
  // Campaign finding C-1 (fault injection, 2026-10-16): v1 is a CLOSED
  // schema — a hashed, audited document has exactly one shape, and unknown
  // top-level keys (including an own '__proto__' key smuggled through
  // JSON.parse) are refused, not carried. Future fields mean a schema
  // version bump, never silent extras.
  // v2 REQUIRES the halt record: deleting it must not read as "not halted".
  if (doc.schema === LEDGER_SCHEMA_V2) validateHalt(doc.halt, ledgerPath);
  const topKeys = doc.schema === LEDGER_SCHEMA_V2 ? LEDGER_TOP_KEYS_V2 : LEDGER_TOP_KEYS_V1;
  for (const k of Object.keys(doc))
    if (!topKeys.includes(k))
      throw new LedgerError('LEDGER_SCHEMA_INVALID', `unknown top-level key "${k}"`, {
        ledgerPath,
        key: k,
      });
  if (now - updatedAtMs > maxAgeMs)
    throw new LedgerError(
      'LEDGER_STALE',
      'Ledger is older than the freshness bound — confirm it manually before reuse; stale books are not fresh books',
      { ledgerPath, ageMs: now - updatedAtMs, maxAgeMs },
    );
  for (const e of doc.entries) {
    if (
      typeof e?.callId !== 'string' ||
      !VALID_STATUS.has(e?.status) ||
      !isFiniteNonNeg(e?.estimatedMaxUsd) ||
      (e.status === 'SETTLED' && !isFiniteNonNeg(e?.actualUsd))
    )
      throw new LedgerError(
        'LEDGER_COST_UNCOMPUTABLE',
        'An entry has uncomputable cost — paid calls are refused until a human reconciles',
        { ledgerPath, callId: e?.callId ?? null },
      );
  }
  return doc;
}

/** Settled entries count at actuals; unsettled (including awaiting reconciliation) at their maximum — see header. */
const isHaltRecord = (r) =>
  r !== null &&
  typeof r === 'object' &&
  !Array.isArray(r) &&
  Object.keys(r).every((k) => ['by', 'at', 'reason'].includes(k)) &&
  typeof r.by === 'string' &&
  r.by.trim() !== '' &&
  typeof r.at === 'string' &&
  Number.isFinite(Date.parse(r.at)) &&
  typeof r.reason === 'string';

/** A malformed halt record must never read as "not halted" (spec row 6). */
function validateHalt(h, ledgerPath) {
  const bad = () => {
    throw new LedgerError('LEDGER_SCHEMA_INVALID', 'halt record malformed', { ledgerPath });
  };
  if (h === null || typeof h !== 'object' || Array.isArray(h)) bad();
  if (!Object.keys(h).every((k) => ['global', 'agents', 'lifts'].includes(k))) bad();
  if (!(h.global === null || isHaltRecord(h.global))) bad();
  if (h.agents === null || typeof h.agents !== 'object' || Array.isArray(h.agents)) bad();
  for (const [k, r] of Object.entries(h.agents)) if (k === '' || !isHaltRecord(r)) bad();
  if (!Array.isArray(h.lifts) || !h.lifts.every(isLiftRecord)) bad();
}

/** Who lifted which halt, kept in the books — the alert log is best-effort (review S2). */
const isLiftRecord = (r) =>
  r !== null &&
  typeof r === 'object' &&
  !Array.isArray(r) &&
  Object.keys(r).every((k) =>
    ['by', 'at', 'scope', 'agentId', 'haltedBy', 'haltedAt'].includes(k),
  ) &&
  typeof r.by === 'string' &&
  r.by.trim() !== '' &&
  typeof r.at === 'string' &&
  Number.isFinite(Date.parse(r.at)) &&
  ((r.scope === 'global' && r.agentId === null) ||
    (r.scope === 'agent' && typeof r.agentId === 'string' && r.agentId !== '')) &&
  typeof r.haltedBy === 'string' &&
  typeof r.haltedAt === 'string';

const emptyHalt = () => ({ global: null, agents: {}, lifts: [] });

/**
 * Agent ids are caller data used as object keys: only OWN keys count, and
 * writes define own properties. A plain `agents[id]` would read
 * `constructor`/`toString` off the prototype as "halted", and assigning
 * `agents['__proto__']` would swap the prototype instead of recording the
 * halt — reported as success, never written to disk.
 */
const agentHaltOf = (h, id) => (h && Object.hasOwn(h.agents, id) ? h.agents[id] : undefined);
const setAgentHalt = (h, id, record) =>
  Object.defineProperty(h.agents, id, {
    value: record,
    enumerable: true,
    writable: true,
    configurable: true,
  });

/**
 * reserve: undefined/null = anonymous; anything else must be a non-empty
 * string (a numeric id could never match a halt). halt/resume (`scope`):
 * only undefined means "everyone" — a null from a failed id lookup must
 * never widen a stop or a resume to all spending.
 */
function checkAgentId(agentId, { scope = false, stored = true } = {}) {
  if (agentId === undefined || (agentId === null && !scope)) return;
  if (typeof agentId !== 'string' || agentId === '')
    throw new LedgerError('AGENT_ID_INVALID', 'agentId must be a non-empty string when given', {
      agentId: typeof agentId === 'string' ? agentId : typeof agentId,
    });
  // only an id that will be stored is bounded; one that is looked up (resume) is
  // not, or a halt recorded before ids were bounded could never be lifted (F-150)
  if (stored) checkLength('agentId', agentId, LIMITS.idChars);
}

export function totalsOf(doc) {
  let settledUsd = 0;
  let outstandingUsd = 0;
  for (const e of doc.entries) {
    if (e.status === 'SETTLED') settledUsd += e.actualUsd;
    else outstandingUsd += e.estimatedMaxUsd;
  }
  return {
    settledUsd,
    outstandingUsd,
    committedUsd: settledUsd + outstandingUsd,
    capUsd: doc.capUsd,
  };
}

/**
 * The largest amount `reserve` would accept right now, reported by `status`
 * and the MCP totals. It is the headroom under the cap (less the epsilon the
 * cap check uses), but 0 whenever that headroom is below the estimate floor —
 * reporting a number the floor would refuse was a false promise (F-150).
 */
export function maxReservableUsd(totals) {
  const headroom = totals.capUsd - totals.committedUsd - 2 * CAP_EPSILON_USD;
  return headroom >= LIMITS.minEstimateUsd ? headroom : 0;
}

function writeLedger(ledgerPath, doc, { keepUpdatedAt = false } = {}) {
  // updatedAt means "the books were last confirmed": a halt or resume
  // confirms nothing, so it keeps the stamp — a stop must never reopen
  // spending on a stale ledger (kill-switch review S1)
  if (!keepUpdatedAt) doc.updatedAt = new Date().toISOString();
  // Unpredictable name + O_EXCL ('wx'): a pre-planted symlink at a guessable
  // tmp path would otherwise let openSync('w') write THROUGH it onto any
  // file the caller can touch (audit finding F15, PoC-confirmed). 'wx'
  // refuses to open an existing path — symlinks included — and the random
  // suffix makes planting one impossible in the first place.
  const tmp = `${ledgerPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  // fsync before rename: the gate's decision must survive power loss — a
  // reservation that vanishes after the paid call launched is the one
  // corruption this module cannot tolerate.
  // Campaign finding C-4 (ENOSPC probe): writeSync can SHORT-WRITE without
  // throwing, and an unchecked return meant a truncated temp file could be
  // fsynced and renamed into place — atomically installing broken books.
  // Every byte is now accounted for; zero forward progress refuses typed;
  // any failure cleans the temp and surfaces as LEDGER_WRITE_FAILED.
  try {
    const fd = openSync(tmp, 'wx');
    try {
      const buf = Buffer.from(`${JSON.stringify(doc, null, 1)}\n`);
      let written = 0;
      while (written < buf.length) {
        const w = writeSync(fd, buf, written, buf.length - written);
        if (!(w > 0))
          throw new LedgerError(
            'LEDGER_WRITE_FAILED',
            'write made no progress — refusing to install partial books',
            { ledgerPath, written, total: buf.length },
          );
        written += w;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, ledgerPath);
  } catch (e) {
    try {
      rmSync(tmp, { force: true }); // never leave a half-written tmp behind
    } catch {
      // best-effort by design (review L-1): a dying disk must not let the
      // cleanup REPLACE the original, typed error with an untyped one
    }
    if (e instanceof LedgerError) throw e;
    throw new LedgerError('LEDGER_WRITE_FAILED', `ledger write failed: ${e.code ?? e.message}`, {
      ledgerPath,
      cause: e.code ?? String(e.message).slice(0, 80),
    });
  }
  try {
    // Directory fsync makes the rename itself durable (best effort — not
    // every platform allows fsync on a directory fd).
    const dfd = openSync(dirname(ledgerPath), 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* never fatal */
  }
}

/**
 * Explicit initialization — the only way a ledger comes into existence.
 * Refuses to overwrite: replacing a real ledger is indistinguishable from
 * erasing the books.
 */
export function initLedger({
  ledgerPath = defaultLedgerPath(),
  capUsd,
  initializedBy = 'explicit-init',
}) {
  checkLength('initializedBy', initializedBy, LIMITS.nameChars);
  ledgerPath = canonicalLedgerPath(ledgerPath);
  if (!isFiniteNonNeg(capUsd) || capUsd <= 0)
    throw new LedgerError('LEDGER_INIT_INVALID', 'capUsd must be a positive number', { capUsd });
  const lock = acquireLock(ledgerPath);
  try {
    if (existsSync(ledgerPath))
      throw new LedgerError(
        'LEDGER_ALREADY_EXISTS',
        'Ledger already exists — init refuses to overwrite',
        {
          ledgerPath,
        },
      );
    writeLedger(ledgerPath, {
      schema: LEDGER_SCHEMA,
      initializedAt: new Date().toISOString(),
      initializedBy,
      capUsd,
      flags: { reconciliationRequired: false, reason: null },
      entries: [],
    });
    return { ok: true, ledgerPath };
  } finally {
    releaseLock(lock);
  }
}

/**
 * Reserve — the only lawful gate in front of a paid call.
 * Returns {ok:true} or throws a LedgerError (refusal is an exception, never a silent no).
 */
export function reserve({
  ledgerPath = defaultLedgerPath(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  runId,
  taskId,
  agentId,
  callId,
  estimatedMaxUsd,
  now = Date.now(),
}) {
  ledgerPath = canonicalLedgerPath(ledgerPath);
  if (typeof callId !== 'string' || callId === '')
    throw new LedgerError('CALL_ID_REQUIRED', 'Every potentially paid call needs a unique callId');
  checkLength('callId', callId, LIMITS.idChars);
  checkLength('runId', runId, LIMITS.idChars);
  checkLength('taskId', taskId, LIMITS.idChars);
  if (!isFiniteNonNeg(estimatedMaxUsd) || estimatedMaxUsd < LIMITS.minEstimateUsd)
    throw new LedgerError(
      'ESTIMATE_INVALID',
      `estimatedMaxUsd must be a number of at least ${LIMITS.minEstimateUsd}`,
      { callId },
    );
  checkAgentId(agentId);
  const lock = acquireLock(ledgerPath);
  try {
    const doc = readLedger({ ledgerPath, maxAgeMs, now });
    // Kill switch first: a deliberate stop outranks every other check. The
    // refusal is alerted so "did anything try to get through" is on record.
    if (doc.halt?.global) {
      emitAlert(ledgerPath, {
        kind: 'HALT_REFUSED',
        scope: 'global',
        callId,
        agentId: agentId ?? null,
      });
      throw new LedgerError('LEDGER_HALTED', `spending halted by ${doc.halt.global.by} — refused`, {
        callId,
        halt: doc.halt.global,
      });
    }
    const agentHalt = typeof agentId === 'string' ? agentHaltOf(doc.halt, agentId) : undefined;
    if (agentHalt) {
      emitAlert(ledgerPath, { kind: 'HALT_REFUSED', scope: 'agent', callId, agentId });
      throw new LedgerError(
        'AGENT_HALTED',
        `agent ${agentId} halted by ${agentHalt.by} — refused`,
        {
          callId,
          agentId,
          halt: agentHalt,
        },
      );
    }
    // Dual-source halt (review finding E2): the flag OR any entry still in
    // RECONCILIATION_REQUIRED blocks new spending — the halt must not hinge
    // on a single deletable field.
    if (
      doc.flags?.reconciliationRequired === true ||
      doc.entries.some((x) => x.status === 'RECONCILIATION_REQUIRED')
    )
      throw new LedgerError(
        'RECONCILIATION_REQUIRED',
        'Unresolved reconciliation — paid calls are refused until the books are squared',
        { ledgerPath, reason: doc.flags?.reason ?? null },
      );
    const existing = doc.entries.find((e) => e.callId === callId);
    if (existing !== undefined) {
      /*
       * Duplicate callIds are fail-closed, whatever the existing status.
       * The soft alternative ("idempotent ok, bill once") lets the caller
       * run the paid action a second time — deduplicated billing with
       * re-executed side effects is exactly the shape of a money leak.
       */
      throw new LedgerError(
        'DUPLICATE_CALL_ID',
        `callId already exists (status=${existing.status}) — a repeated call must not trigger the paid action again`,
        { callId, existingStatus: existing.status },
      );
    }
    const t = totalsOf(doc);
    if (t.committedUsd + estimatedMaxUsd >= doc.capUsd - CAP_EPSILON_USD) {
      emitAlert(ledgerPath, { kind: 'BUDGET_REFUSED', callId, estimatedMaxUsd, ...t });
      throw new LedgerError(
        'BUDGET_EXCEEDED',
        'settled + outstanding + this estimate reaches the cap — refused (the cap is a wall, not a target)',
        { callId, estimatedMaxUsd, ...t },
      );
    }
    doc.entries.push({
      callId,
      runId: runId ?? null,
      taskId: taskId ?? null,
      agentId: agentId ?? null,
      estimatedMaxUsd,
      createdAt: new Date().toISOString(),
      status: 'RESERVED',
    });
    writeLedger(ledgerPath, doc);
    return { ok: true, duplicate: false, callId };
  } finally {
    releaseLock(lock);
  }
}

/**
 * Settle. On success pass actualUsd (actuals replace the reservation,
 * releasing the difference). If the action failed and the real cost is
 * unknowable, pass failedUnknownCost:true — the entry enters
 * RECONCILIATION_REQUIRED and a global flag blocks all further paid calls.
 * Settling an already-settled callId is an idempotent no-op.
 */
export function settle({
  ledgerPath = defaultLedgerPath(),
  callId,
  actualUsd,
  tokens = null,
  failedUnknownCost = false,
  allowReconciling = true,
}) {
  ledgerPath = canonicalLedgerPath(ledgerPath);
  // the same id rule as reserve: a non-string id is refused, never searched
  // for and echoed back (F-82 — an echoed nested value crashed the MCP gate)
  if (typeof callId !== 'string' || callId === '')
    throw new LedgerError('CALL_ID_REQUIRED', 'Settling needs the callId the reservation used');
  // no length bound here (F-150): settle stores no new id, it looks one up, and a
  // reservation made before ids were bounded must still be settled, or its
  // estimate holds the cap for ever
  const lock = acquireLock(ledgerPath);
  try {
    const doc = readLedger({ ledgerPath, maxAgeMs: Number.POSITIVE_INFINITY });
    const e = doc.entries.find((x) => x.callId === callId);
    if (e === undefined)
      throw new LedgerError('SETTLE_UNKNOWN_CALL', 'Settling a callId that was never reserved', {
        callId,
      });
    if (e.status === 'SETTLED') {
      // Idempotent ONLY for the identical outcome. A different amount (or a
      // late failedUnknownCost) silently swallowed would mask an accounting
      // bug — the books do not bend.
      if (failedUnknownCost === true || (actualUsd !== undefined && actualUsd !== e.actualUsd)) {
        emitAlert(ledgerPath, {
          kind: 'SETTLE_MISMATCH',
          callId,
          recordedUsd: e.actualUsd,
          attemptedUsd: failedUnknownCost ? null : actualUsd,
        });
        throw new LedgerError(
          'SETTLE_MISMATCH',
          'Re-settling with a different outcome than recorded — refused',
          { callId, recordedUsd: e.actualUsd },
        );
      }
      return { ok: true, duplicate: true, callId };
    }
    // An entry awaiting reconciliation is resolved by a person; over MCP the
    // agent that caused it could otherwise settle it at $0 itself (MCP review N8)
    if (e.status === 'RECONCILIATION_REQUIRED' && !allowReconciling)
      throw new LedgerError(
        'SETTLE_RECONCILIATION_HUMAN_ONLY',
        'this entry awaits reconciliation by a person — it cannot be settled through this channel',
        { callId },
      );
    if (failedUnknownCost === true) {
      e.status = 'RECONCILIATION_REQUIRED';
      doc.flags = {
        reconciliationRequired: true,
        reason: boundReason(`call ${callId} failed with unknowable actual cost`),
      };
      emitAlert(ledgerPath, { kind: 'RECONCILIATION_REQUIRED', callId });
      writeLedger(ledgerPath, doc, { keepUpdatedAt: true });
      return { ok: true, reconciliationRequired: true, callId };
    }
    if (!isFiniteNonNeg(actualUsd))
      throw new LedgerError(
        'SETTLE_INVALID',
        'actualUsd must be a non-negative number (if unknowable, use failedUnknownCost)',
        { callId },
      );
    // tokens is telemetry the caller supplies; bound its stored size (F-150) and
    // keep only a plain object or null, never an attacker-sized blob
    if (tokens !== null && tokens !== undefined) {
      if (typeof tokens !== 'object' || Array.isArray(tokens))
        throw new LedgerError('INPUT_INVALID', 'tokens must be an object or null', { callId });
      if (JSON.stringify(tokens).length > LIMITS.tokensBytes)
        throw new LedgerError(
          'INPUT_TOO_LONG',
          `tokens is larger than ${LIMITS.tokensBytes} bytes`,
          {
            callId,
          },
        );
    }
    e.status = 'SETTLED';
    e.actualUsd = actualUsd;
    e.tokens = tokens ?? null;
    e.settledAt = new Date().toISOString();
    if (actualUsd > e.estimatedMaxUsd + 1e-9) {
      /*
       * Overrun (review finding E1): the actual cost exceeded the reserved
       * maximum — the one event that proves the pre-spend gate was pierced.
       * The money is spent, so it is RECORDED (refusing would only make the
       * books wrong), but it must never pass in silence: alert + global
       * reconciliation halt until a named human squares the books.
       */
      emitAlert(ledgerPath, {
        kind: 'BUDGET_OVERRUN',
        callId,
        reservedUsd: e.estimatedMaxUsd,
        actualUsd,
        capUsd: doc.capUsd,
      });
      doc.flags = {
        reconciliationRequired: true,
        reason: boundReason(
          `call ${callId} settled ${actualUsd} against a ${e.estimatedMaxUsd} reservation`,
        ),
      };
    }
    // a settle confirms nothing about the books: an agent settling an old
    // reservation must not make a stale ledger fresh (review S1, F-67 class)
    writeLedger(ledgerPath, doc, { keepUpdatedAt: true });
    return { ok: true, duplicate: false, callId };
  } finally {
    releaseLock(lock);
  }
}

/** For out-of-band accounting failures: completed work stands, but the flag + alert block all further paid calls. */
export function markReconciliationRequired({ ledgerPath = defaultLedgerPath(), reason }) {
  ledgerPath = canonicalLedgerPath(ledgerPath);
  const lock = acquireLock(ledgerPath);
  try {
    const doc = readLedger({ ledgerPath, maxAgeMs: Number.POSITIVE_INFINITY });
    doc.flags = { reconciliationRequired: true, reason: boundReason(reason) };
    emitAlert(ledgerPath, { kind: 'RECONCILIATION_REQUIRED', reason: doc.flags.reason });
    writeLedger(ledgerPath, doc);
    return { ok: true };
  } finally {
    releaseLock(lock);
  }
}

/**
 * Kill switch: stop spending on this ledger, globally or for one agent id
 * (exact, case-sensitive match on the id the agent reserves under).
 * Reads with infinite staleness and ignores reconciliation state — a stop
 * must never be blocked by the conditions it exists for. First halt wins:
 * halting an already-halted scope keeps the original record. The first
 * halt upgrades the ledger to v2 (see LEDGER_SCHEMA_V2).
 */
export function halt({ ledgerPath = defaultLedgerPath(), by, reason = '', agentId }) {
  ledgerPath = canonicalLedgerPath(ledgerPath);
  // blank names refused here, or the record would fail its own read check
  if (typeof by !== 'string' || by.trim() === '')
    throw new LedgerError('HALT_BY_REQUIRED', 'Halting requires a name');
  checkLength('by', by, LIMITS.nameChars);
  checkLength('reason', typeof reason === 'string' ? reason : String(reason), LIMITS.reasonChars);
  checkAgentId(agentId, { scope: true });
  const scoped = typeof agentId === 'string';
  const lock = acquireLock(ledgerPath);
  try {
    const doc = readLedger({ ledgerPath, maxAgeMs: Number.POSITIVE_INFINITY });
    const h = doc.halt ?? emptyHalt();
    const existing = scoped ? agentHaltOf(h, agentId) : h.global;
    if (existing) return { ok: true, alreadyHalted: true, halt: existing };
    const record = { by, at: new Date().toISOString(), reason: String(reason) };
    if (scoped) setAgentHalt(h, agentId, record);
    else h.global = record;
    doc.schema = LEDGER_SCHEMA_V2;
    doc.halt = h;
    writeLedger(ledgerPath, doc, { keepUpdatedAt: true });
    emitAlert(ledgerPath, {
      kind: 'HALT_SET',
      scope: scoped ? 'agent' : 'global',
      agentId: scoped ? agentId : null,
      ...record,
    });
    return { ok: true, alreadyHalted: false, halt: record };
  } finally {
    releaseLock(lock);
  }
}

/**
 * Lift a halt. Requires a name; reports honestly when nothing was halted.
 * The ledger stays v2, and `halt.lifts` keeps who lifted which halt and
 * when — in the books, not only in the best-effort alert log.
 */
export function resume({ ledgerPath = defaultLedgerPath(), by, agentId }) {
  ledgerPath = canonicalLedgerPath(ledgerPath);
  // blank names refused here, or the record would fail its own read check
  if (typeof by !== 'string' || by.trim() === '')
    throw new LedgerError('RESUME_BY_REQUIRED', 'Resuming requires a name');
  checkLength('by', by, LIMITS.nameChars);
  checkAgentId(agentId, { scope: true, stored: false });
  const scoped = typeof agentId === 'string';
  const lock = acquireLock(ledgerPath);
  try {
    const doc = readLedger({ ledgerPath, maxAgeMs: Number.POSITIVE_INFINITY });
    const h = doc.halt;
    const existing = scoped ? agentHaltOf(h, agentId) : h?.global;
    if (!existing) return { ok: true, wasHalted: false };
    if (scoped) delete h.agents[agentId];
    else h.global = null;
    const lift = {
      by,
      at: new Date().toISOString(),
      scope: scoped ? 'agent' : 'global',
      agentId: scoped ? agentId : null,
      haltedBy: existing.by,
      haltedAt: existing.at,
    };
    h.lifts.push(lift);
    writeLedger(ledgerPath, doc, { keepUpdatedAt: true });
    emitAlert(ledgerPath, {
      kind: 'HALT_CLEARED',
      scope: lift.scope,
      agentId: lift.agentId,
      by,
      at: lift.at,
      haltedBy: existing.by,
    });
    return { ok: true, wasHalted: true, lifted: existing };
  } finally {
    releaseLock(lock);
  }
}

/** Explicit, signed clearance after a human squares the books. Entries are never deleted — history is evidence. */
export function clearReconciliation({ ledgerPath = defaultLedgerPath(), by }) {
  ledgerPath = canonicalLedgerPath(ledgerPath);
  if (typeof by !== 'string' || by.trim() === '')
    throw new LedgerError('RECONCILE_BY_REQUIRED', 'Clearing the flag requires a name');
  checkLength('by', by, LIMITS.nameChars);
  const lock = acquireLock(ledgerPath);
  try {
    const doc = readLedger({ ledgerPath, maxAgeMs: Number.POSITIVE_INFINITY });
    // Squaring the books means resolving the entries, not just signing the
    // flag away (pairs with the dual-source halt, finding E2): every
    // RECONCILIATION_REQUIRED entry must be settled first.
    const open = doc.entries.filter((x) => x.status === 'RECONCILIATION_REQUIRED');
    if (open.length > 0)
      throw new LedgerError(
        'RECONCILIATION_ENTRIES_OPEN',
        'Settle every RECONCILIATION_REQUIRED entry before clearing the flag',
        { callIds: open.map((x) => x.callId) },
      );
    doc.flags = {
      reconciliationRequired: false,
      reason: null,
      lastReconciledBy: by,
      lastReconciledAt: new Date().toISOString(),
    };
    writeLedger(ledgerPath, doc);
    return { ok: true };
  } finally {
    releaseLock(lock);
  }
}
