// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 the Sakk authors. Commercial licensing available — see README.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

function acquireLock(ledgerPath) {
  const lock = `${ledgerPath}.lock`;
  mkdirSync(dirname(ledgerPath), { recursive: true });
  for (let i = 0; i < LOCK_TRIES; i += 1) {
    try {
      mkdirSync(lock);
      return lock;
    } catch {
      sleepMs(LOCK_WAIT_MS);
    }
  }
  throw new LedgerError(
    'LEDGER_LOCK_UNAVAILABLE',
    'Timed out acquiring the ledger lock — refusing to judge the budget without mutual exclusion',
    { ledgerPath },
  );
}

function releaseLock(lock) {
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
  const tmp = `${ledgerPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 1)}\n`);
  renameSync(tmp, ledgerPath);
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
    if (doc.flags?.reconciliationRequired === true)
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
    if (t.committedUsd + estimatedMaxUsd >= doc.capUsd) {
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
    if (e.status === 'SETTLED') return { ok: true, duplicate: true, callId };
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
