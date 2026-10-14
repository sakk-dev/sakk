// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 the Sakk authors. Commercial licensing available — see README.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

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
/** Freshness bound: older than this is refused (every write refreshes updatedAt). */
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
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

function alertsPathFor(ledgerPath) {
  return join(dirname(ledgerPath), 'sakk-alerts.jsonl');
}

/** Structured alert trail: every budget anomaly leaves one greppable line on disk (best effort, never throws). */
function emitAlert(ledgerPath, alert) {
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(
      alertsPathFor(ledgerPath),
      `${JSON.stringify({ at: new Date().toISOString(), ...alert })}\n`,
      { flag: 'a' },
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
  if (typeof by !== 'string' || by === '')
    throw new LedgerError('UNLOCK_BY_REQUIRED', 'Breaking a lock by hand requires a name');
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
  mkdirSync(dirname(ledgerPath), { recursive: true });
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
  if (!existsSync(ledgerPath))
    throw new LedgerError(
      'LEDGER_MISSING',
      'The authoritative ledger does not exist — paid calls are refused (create one with explicit init)',
      { ledgerPath },
    );
  let raw;
  try {
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
  if (doc === null || typeof doc !== 'object' || doc.schema !== LEDGER_SCHEMA)
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

function writeLedger(ledgerPath, doc) {
  doc.updatedAt = new Date().toISOString();
  // Unpredictable name + O_EXCL ('wx'): a pre-planted symlink at a guessable
  // tmp path would otherwise let openSync('w') write THROUGH it onto any
  // file the caller can touch (audit finding F15, PoC-confirmed). 'wx'
  // refuses to open an existing path — symlinks included — and the random
  // suffix makes planting one impossible in the first place.
  const tmp = `${ledgerPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  // fsync before rename: the gate's decision must survive power loss — a
  // reservation that vanishes after the paid call launched is the one
  // corruption this module cannot tolerate.
  const fd = openSync(tmp, 'wx');
  try {
    writeSync(fd, `${JSON.stringify(doc, null, 1)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, ledgerPath);
  } catch (e) {
    rmSync(tmp, { force: true }); // never leave a half-written tmp behind
    throw e;
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
  if (typeof callId !== 'string' || callId === '')
    throw new LedgerError('CALL_ID_REQUIRED', 'Every potentially paid call needs a unique callId');
  if (!isFiniteNonNeg(estimatedMaxUsd) || estimatedMaxUsd <= 0)
    throw new LedgerError('ESTIMATE_INVALID', 'estimatedMaxUsd must be a positive number', {
      callId,
    });
  const lock = acquireLock(ledgerPath);
  try {
    const doc = readLedger({ ledgerPath, maxAgeMs, now });
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
}) {
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
    if (failedUnknownCost === true) {
      e.status = 'RECONCILIATION_REQUIRED';
      doc.flags = {
        reconciliationRequired: true,
        reason: `call ${callId} failed with unknowable actual cost`,
      };
      emitAlert(ledgerPath, { kind: 'RECONCILIATION_REQUIRED', callId });
      writeLedger(ledgerPath, doc);
      return { ok: true, reconciliationRequired: true, callId };
    }
    if (!isFiniteNonNeg(actualUsd))
      throw new LedgerError(
        'SETTLE_INVALID',
        'actualUsd must be a non-negative number (if unknowable, use failedUnknownCost)',
        { callId },
      );
    e.status = 'SETTLED';
    e.actualUsd = actualUsd;
    e.tokens = tokens;
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
        reason: `call ${callId} settled ${actualUsd} against a ${e.estimatedMaxUsd} reservation`,
      };
    }
    writeLedger(ledgerPath, doc);
    return { ok: true, duplicate: false, callId };
  } finally {
    releaseLock(lock);
  }
}

/** For out-of-band accounting failures: completed work stands, but the flag + alert block all further paid calls. */
export function markReconciliationRequired({ ledgerPath = defaultLedgerPath(), reason }) {
  const lock = acquireLock(ledgerPath);
  try {
    const doc = readLedger({ ledgerPath, maxAgeMs: Number.POSITIVE_INFINITY });
    doc.flags = { reconciliationRequired: true, reason: String(reason ?? 'unspecified') };
    emitAlert(ledgerPath, { kind: 'RECONCILIATION_REQUIRED', reason: doc.flags.reason });
    writeLedger(ledgerPath, doc);
    return { ok: true };
  } finally {
    releaseLock(lock);
  }
}

/** Explicit, signed clearance after a human squares the books. Entries are never deleted — history is evidence. */
export function clearReconciliation({ ledgerPath = defaultLedgerPath(), by }) {
  if (typeof by !== 'string' || by === '')
    throw new LedgerError('RECONCILE_BY_REQUIRED', 'Clearing the flag requires a name');
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
