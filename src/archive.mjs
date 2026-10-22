// SPDX-License-Identifier: AGPL-3.0-only
//
// The ledger's cold trail (F-105, specs/ledger "The hot/cold split"). Settled
// entries are sealed into append-only, hash-chained segments so the live
// `ledger.json` stays small and a call costs the same whatever the history.
// The gate's go/no-go never reads cold — it reads the hot file's atomic
// `archive` summary. Cold is the audit record: a lost or altered segment is
// caught (the chain + the per-call tip check), never read as freed cap.
//
// All callers hold the ledger's mkdir lock, so there is never a concurrent
// sealer; this module does no locking of its own.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './append.mjs';

/**
 * Settled entries kept in the hot file before the oldest are sealed. A
 * perf-tuning knob (SAKK_SEAL_AT) with a 1000 default: lowering it seals more
 * often, raising it keeps more hot (still bounded by MAX_INFLIGHT). Not a
 * safety limit — the cap and the chain do not depend on its value.
 */
export const SEAL_AT =
  Number(process.env.SAKK_SEAL_AT) > 0 ? Number(process.env.SAKK_SEAL_AT) : 1000;
/**
 * Most reservations outstanding (RESERVED or awaiting reconciliation) at once
 * (F-105, owner 2026-10-22). A hard constant, not env-tunable: it is the one
 * thing that bounds the hot file, so it must not be loosened at run time.
 */
export const MAX_INFLIGHT = 10_000;

export class ArchiveError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.code = code;
    this.details = details;
  }
}

export const coldDir = (ledgerPath) => `${ledgerPath}.cold`;
export const idxDir = (ledgerPath) => `${ledgerPath}.idx`;
const segName = (seq) => `${String(seq).padStart(6, '0')}.json`;
const segPath = (ledgerPath, seq) => join(coldDir(ledgerPath), segName(seq));
const sha = (s) => createHash('sha256').update(s).digest('hex');
// 3 hex = 4096 shards, so a shard holds about (sealed call-ids / 4096): a
// call-id lookup stays small across the realistic range (hundreds of
// thousands to low millions of calls). Deeper sharding is the knob if a
// deployment ever seals far more than that.
const SHARD_HEX = 3;
const shardOf = (callId) => sha(callId).slice(0, SHARD_HEX);
const shardPath = (ledgerPath, callId) => join(idxDir(ledgerPath), `${shardOf(callId)}.json`);

/** The sealed hash of a segment: its seq, the previous segment's hash, and its entries. */
export function segmentHash(seq, prev, entries) {
  return sha(JSON.stringify({ seq, prev, entries }));
}

/** The empty summary a v1/v2 ledger (no cold trail yet) reads as. */
export const emptyArchive = () => ({ segments: 0, settledCount: 0, settledUsd: 0, tip: '' });

/** An archive summary has exactly the right shape and non-negative counts; a tip iff there are segments. */
export function validateArchive(archive, ledgerPath) {
  const bad = (why) => {
    throw new ArchiveError('LEDGER_ARCHIVE_BROKEN', why, { ledgerPath });
  };
  if (archive === null || typeof archive !== 'object' || Array.isArray(archive))
    bad('archive is not an object');
  const keys = Object.keys(archive).sort().join(',');
  if (keys !== 'segments,settledCount,settledUsd,tip') bad('archive has the wrong keys');
  if (!Number.isInteger(archive.segments) || archive.segments < 0) bad('archive.segments invalid');
  if (!Number.isInteger(archive.settledCount) || archive.settledCount < 0)
    bad('archive.settledCount invalid');
  if (
    typeof archive.settledUsd !== 'number' ||
    !Number.isFinite(archive.settledUsd) ||
    archive.settledUsd < 0
  )
    bad('archive.settledUsd invalid');
  if (typeof archive.tip !== 'string') bad('archive.tip invalid');
  if (archive.segments === 0 && archive.tip !== '') bad('no segments but a tip');
  if (archive.segments > 0 && archive.tip === '') bad('segments but no tip');
}

/** Read and hash-check one segment; throws LEDGER_ARCHIVE_BROKEN if missing or altered. */
export function readSegment(ledgerPath, seq) {
  let seg;
  try {
    seg = JSON.parse(readFileSync(segPath(ledgerPath, seq), 'utf8'));
  } catch (e) {
    throw new ArchiveError(
      'LEDGER_ARCHIVE_BROKEN',
      `cold segment ${seq} is missing or unreadable`,
      {
        seq,
        why: e.code ?? String(e.message).slice(0, 80),
      },
    );
  }
  if (
    seg === null ||
    typeof seg !== 'object' ||
    seg.seq !== seq ||
    typeof seg.prev !== 'string' ||
    !Array.isArray(seg.entries) ||
    seg.hash !== segmentHash(seq, seg.prev, seg.entries)
  )
    throw new ArchiveError('LEDGER_ARCHIVE_BROKEN', `cold segment ${seq} fails its hash`, { seq });
  return seg;
}

/**
 * Walk the whole chain: every segment reads, every prev links, and the
 * recomputed counts and total equal the summary. Returns the recomputed
 * totals. Used by `sakk ledger verify`.
 */
export function verifyChain(ledgerPath, archive) {
  validateArchive(archive, ledgerPath);
  let prev = '';
  let settledCount = 0;
  let settledUsd = 0;
  for (let seq = 1; seq <= archive.segments; seq++) {
    const seg = readSegment(ledgerPath, seq);
    if (seg.prev !== prev)
      throw new ArchiveError(
        'LEDGER_ARCHIVE_BROKEN',
        `cold segment ${seq} does not link to ${seq - 1}`,
        { seq },
      );
    for (const e of seg.entries) {
      if (
        e?.status !== 'SETTLED' ||
        typeof e.actualUsd !== 'number' ||
        !Number.isFinite(e.actualUsd)
      )
        throw new ArchiveError(
          'LEDGER_ARCHIVE_BROKEN',
          `cold segment ${seq} has a non-settled entry`,
          { seq },
        );
      settledCount += 1;
      settledUsd += e.actualUsd;
    }
    prev = seg.hash;
  }
  if (prev !== archive.tip)
    throw new ArchiveError('LEDGER_ARCHIVE_BROKEN', 'the chain tip does not match the summary', {});
  if (settledCount !== archive.settledCount)
    throw new ArchiveError('LEDGER_ARCHIVE_BROKEN', 'the sealed count does not match the summary', {
      counted: settledCount,
      summary: archive.settledCount,
    });
  if (Math.abs(settledUsd - archive.settledUsd) > 1e-9)
    throw new ArchiveError('LEDGER_ARCHIVE_BROKEN', 'the sealed total does not match the summary', {
      counted: settledUsd,
      summary: archive.settledUsd,
    });
  return { segments: archive.segments, settledCount, settledUsd };
}

/** The segment a call-id was sealed into, or null if it was never sealed. One small shard read. */
export function indexLookup(ledgerPath, callId) {
  const p = shardPath(ledgerPath, callId);
  if (!existsSync(p)) return null;
  let shard;
  try {
    shard = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new ArchiveError('LEDGER_ARCHIVE_BROKEN', `the index shard for ${callId} is unreadable`, {
      why: e.code ?? String(e.message).slice(0, 80),
    });
  }
  return Object.hasOwn(shard, callId) ? shard[callId] : null;
}

/** Every settled entry of the segment a call-id is in — for a re-settle idempotency check. */
export function archivedEntry(ledgerPath, callId) {
  const seq = indexLookup(ledgerPath, callId);
  if (seq === null) return null;
  const seg = readSegment(ledgerPath, seq);
  return seg.entries.find((e) => e.callId === callId) ?? null;
}

/**
 * Seal `entries` (all SETTLED) as the next segment and record their call-ids
 * in the index, in the crash-safe order the spec sets: the segment first,
 * then the shards, then the caller commits the hot file. The hot file is
 * authoritative, so a crash before its commit leaves this as a redoable
 * prefix (the entries are still in hot). Returns { seq, hash }.
 */
export function sealSegment(ledgerPath, prevSegments, prevTip, entries) {
  mkdirSync(coldDir(ledgerPath), { recursive: true });
  mkdirSync(idxDir(ledgerPath), { recursive: true });
  const seq = prevSegments + 1;
  const hash = segmentHash(seq, prevTip, entries);
  writeFileAtomic(
    segPath(ledgerPath, seq),
    `${JSON.stringify({ seq, prev: prevTip, entries, hash })}\n`,
  );
  // group the call-ids by shard, merge into each shard, write it
  const byShard = new Map();
  for (const e of entries) {
    const s = shardOf(e.callId);
    if (!byShard.has(s)) byShard.set(s, []);
    byShard.get(s).push(e.callId);
  }
  for (const [s, ids] of byShard) {
    const p = join(idxDir(ledgerPath), `${s}.json`);
    let shard = {};
    if (existsSync(p)) {
      try {
        shard = JSON.parse(readFileSync(p, 'utf8'));
      } catch (e) {
        throw new ArchiveError('LEDGER_ARCHIVE_BROKEN', `the index shard ${s} is unreadable`, {
          why: e.code ?? String(e.message).slice(0, 80),
        });
      }
    }
    for (const id of ids) shard[id] = seq;
    writeFileAtomic(p, `${JSON.stringify(shard)}\n`);
  }
  return { seq, hash };
}

/** How many cold segment files are actually on disk (for verify / export). */
export function segmentsOnDisk(ledgerPath) {
  const d = coldDir(ledgerPath);
  if (!existsSync(d)) return 0;
  return readdirSync(d).filter((f) => /^\d{6}\.json$/.test(f)).length;
}
