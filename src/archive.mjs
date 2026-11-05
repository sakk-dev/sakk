// SPDX-License-Identifier: Apache-2.0
//
// The ledger's cold trail (F-105, specs/ledger "The hot/cold split"). Settled
// entries are sealed into append-only, hash-chained segments so the live
// `ledger.json` stays small and a call costs the same whatever the history.
// The gate's go/no-go reads the hot file's atomic `archive` summary, bound
// to the head segment: each sealed segment carries the running totals through
// it, under its hash, and reserve checks the summary against that one head
// (F-193). Cold is otherwise the audit record: a lost or altered older
// segment is caught by `sakk ledger verify`, never read as freed cap.
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

/**
 * The sealed hash of a segment: its seq, the previous segment's hash, its
 * entries and, from F-193 on, the running totals through it. A segment sealed
 * before F-193 has no `total` and hashes as it always did.
 */
export function segmentHash(seq, prev, entries, total) {
  return sha(
    JSON.stringify(total === undefined ? { seq, prev, entries } : { seq, prev, entries, total }),
  );
}

/** A segment's running total is exactly {settledCount, settledUsd}, both finite and non-negative. */
const validTotal = (t) =>
  t !== null &&
  typeof t === 'object' &&
  !Array.isArray(t) &&
  Object.keys(t).sort().join(',') === 'settledCount,settledUsd' &&
  Number.isInteger(t.settledCount) &&
  t.settledCount >= 0 &&
  typeof t.settledUsd === 'number' &&
  Number.isFinite(t.settledUsd) &&
  t.settledUsd >= 0;

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
    (seg.total !== undefined && !validTotal(seg.total)) ||
    seg.hash !== segmentHash(seq, seg.prev, seg.entries, seg.total)
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
  const expectedIndex = new Map(); // shard -> { callId: seq }, to check the index too
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
      const s = shardOf(e.callId);
      if (!expectedIndex.has(s)) expectedIndex.set(s, {});
      expectedIndex.get(s)[e.callId] = seq;
    }
    settledCount += seg.entries.length;
    // sum per segment then add, exactly as maybeSeal accumulates archive.settledUsd,
    // so float addition's non-associativity never makes an intact chain mismatch (F-105 review)
    settledUsd += seg.entries.reduce((s, e) => s + e.actualUsd, 0);
    // a segment's running total must be what the chain sums to through it (F-193)
    if (
      seg.total !== undefined &&
      (seg.total.settledCount !== settledCount ||
        !(Math.abs(seg.total.settledUsd - settledUsd) <= 1e-9))
    )
      throw new ArchiveError(
        'LEDGER_ARCHIVE_BROKEN',
        `cold segment ${seq}'s running total does not match the chain`,
        { seq },
      );
    prev = seg.hash;
  }
  if (prev !== archive.tip)
    throw new ArchiveError('LEDGER_ARCHIVE_BROKEN', 'the chain tip does not match the summary', {});
  if (settledCount !== archive.settledCount)
    throw new ArchiveError('LEDGER_ARCHIVE_BROKEN', 'the sealed count does not match the summary', {
      counted: settledCount,
      summary: archive.settledCount,
    });
  // written so a NaN (an entry with no amount) fails rather than passes
  if (!(Math.abs(settledUsd - archive.settledUsd) <= 1e-9))
    throw new ArchiveError('LEDGER_ARCHIVE_BROKEN', 'the sealed total does not match the summary', {
      counted: settledUsd,
      summary: archive.settledUsd,
    });
  // the index is the ONLY cross-history duplicate guard; a lost or wrong shard
  // would silently re-admit a sealed call-id (double-spend), so verify checks
  // every sealed call-id is in its shard pointing at its segment (F-105 review HIGH)
  for (const [s, want] of expectedIndex) {
    const p = join(idxDir(ledgerPath), `${s}.json`);
    let have = {};
    if (existsSync(p)) {
      try {
        have = JSON.parse(readFileSync(p, 'utf8'));
      } catch (e) {
        throw new ArchiveError('LEDGER_ARCHIVE_BROKEN', `index shard ${s} is unreadable`, {
          why: e.code ?? String(e.message).slice(0, 80),
        });
      }
    }
    for (const [callId, seq] of Object.entries(want))
      if (have[callId] !== seq)
        throw new ArchiveError(
          'LEDGER_ARCHIVE_BROKEN',
          `the index is missing or wrong for a sealed call-id in shard ${s} — run sakk ledger reindex`,
          { shard: s },
        );
  }
  return { segments: archive.segments, settledCount, settledUsd };
}

/**
 * The per-call binding of the summary to the cold trail (F-193), run by
 * reserve and by the seal under the ledger lock. Reads one segment, the head,
 * whatever the history, and checks:
 * - the head exists, passes its hash, and is the summary's tip;
 * - the summary's totals equal the head's running total (hash-covered);
 * - no segment past the summary exists, unless it is the redoable prefix a
 *   seal that crashed before its hot commit leaves (see isRedoablePrefix).
 *   Anything else there means the summary was rolled back or dropped.
 * A head sealed before F-193 has no running total: the chain is walked once
 * per call until the next seal writes one. Throws LEDGER_ARCHIVE_BROKEN.
 *
 * `pending` is the call-id a settle is committing right now: its hot entry is
 * still unsettled on disk, so an orphan from an earlier crashed settle of the
 * same call may hold a different amount, and the seal redoes it.
 *
 * Limit: the hash is unkeyed and the trail is a local file, so a writer who
 * rewrites the summary, deletes the newer segments and their index entries,
 * or rehashes the trail is not caught here. Keeping the agent from writing the
 * ledger at all is the guard's job (it denies writes into ~/.sakk).
 */
export function checkHead(ledgerPath, archive, hotEntries, { pending } = {}) {
  validateArchive(archive, ledgerPath);
  const bad = (why) => {
    throw new ArchiveError('LEDGER_ARCHIVE_BROKEN', `${why} — run sakk ledger verify`, {
      ledgerPath,
    });
  };
  const next = archive.segments + 1;
  if (existsSync(segPath(ledgerPath, next))) {
    const orphan = readSegment(ledgerPath, next);
    // a crash leaves at most one segment past the summary; a later one means
    // the summary was rolled back over real history (rare path: one listing)
    if (
      orphan.prev !== archive.tip ||
      seqsOnDisk(ledgerPath).some((s) => s > next) ||
      !isRedoablePrefix(archive, orphan, hotEntries, pending)
    )
      bad(`cold segment ${next} exists past the summary — the summary was rolled back`);
  }
  if (archive.segments === 0) {
    if (archive.settledCount !== 0 || archive.settledUsd !== 0)
      bad('the summary has sealed totals but no segments');
    return;
  }
  const head = readSegment(ledgerPath, archive.segments);
  if (head.hash !== archive.tip) bad('the summary tip is not the head segment');
  let total = head.total;
  if (total === undefined) {
    // legacy head: sum the whole chain (the same per-segment order as the seal)
    total = { settledCount: 0, settledUsd: 0 };
    let prev = '';
    for (let seq = 1; seq <= archive.segments; seq++) {
      const seg = seq === archive.segments ? head : readSegment(ledgerPath, seq);
      // written prev-first so the MUT-AG drill anchor (verifyChain's link check) stays unique
      if (prev !== seg.prev) bad(`cold segment ${seq} does not link to ${seq - 1}`);
      total.settledCount += seg.entries.length;
      total.settledUsd += seg.entries.reduce((s, e) => s + e.actualUsd, 0);
      prev = seg.hash;
    }
  }
  // written so a NaN (a legacy entry with no amount) fails rather than passes
  if (
    total.settledCount !== archive.settledCount ||
    !(Math.abs(total.settledUsd - archive.settledUsd) <= 1e-9)
  )
    bad('the summary totals do not match the head segment');
}

/**
 * Whether a segment past the summary is exactly what a seal that crashed
 * before its hot commit leaves behind, and so safe to redo: its running total
 * is the summary plus its own entries, and every entry is still in hot with
 * the same reservation — settled at the same amount, or, for at most one
 * entry (the settle that triggered the seal), not yet settled on disk. A
 * rolled-back summary with sealed calls copied back at a lower amount, or
 * copied back at all while later segments exist, is not (F-193 review).
 */
function isRedoablePrefix(archive, orphan, hotEntries, pending) {
  const hot = new Map(hotEntries.map((e) => [e.callId, e]));
  let unsettled = 0;
  let usd = 0;
  for (const e of orphan.entries) {
    const h = hot.get(e?.callId);
    if (h === undefined || h.estimatedMaxUsd !== e.estimatedMaxUsd) return false;
    const triggering =
      h.callId === pending || h.status === 'RESERVED' || h.status === 'RECONCILIATION_REQUIRED';
    if (triggering) {
      if (++unsettled > 1) return false;
    } else if (h.status !== 'SETTLED' || h.actualUsd !== e.actualUsd) return false;
    usd += e.actualUsd;
  }
  if (orphan.total === undefined) return true;
  return (
    orphan.total.settledCount === archive.settledCount + orphan.entries.length &&
    Math.abs(orphan.total.settledUsd - (archive.settledUsd + usd)) <= 1e-9
  );
}

/**
 * The cold segment files on disk are exactly 1..segments, or 1..segments+1
 * when a crashed seal left one redoable segment. A gap, a missing segment or
 * one further past the summary is LEDGER_ARCHIVE_BROKEN. Lists the cold
 * folder once; used by `sakk ledger verify`, off the gate path.
 */
export function checkSegmentFiles(ledgerPath, archive) {
  validateArchive(archive, ledgerPath);
  const seqs = seqsOnDisk(ledgerPath);
  const exact = (n) => seqs.length === n && seqs.every((s, i) => s === i + 1);
  if (!exact(archive.segments) && !exact(archive.segments + 1))
    throw new ArchiveError(
      'LEDGER_ARCHIVE_BROKEN',
      `the cold segment files on disk are not 1..${archive.segments} (found ${seqs.length}, highest ${seqs.at(-1) ?? 0})`,
      { ledgerPath },
    );
  return seqs.length;
}

/** Rebuild the whole index from the cold trail (sakk ledger reindex): recovery after an index loss. */
export function reindex(ledgerPath, archive) {
  validateArchive(archive, ledgerPath);
  const shards = new Map();
  for (let seq = 1; seq <= archive.segments; seq++)
    for (const e of readSegment(ledgerPath, seq).entries) {
      const s = shardOf(e.callId);
      if (!shards.has(s)) shards.set(s, {});
      shards.get(s)[e.callId] = seq;
    }
  mkdirSync(idxDir(ledgerPath), { recursive: true });
  for (const [s, map] of shards)
    writeFileAtomic(join(idxDir(ledgerPath), `${s}.json`), `${JSON.stringify(map)}\n`);
  return shards.size;
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
 * prefix (the entries are still in hot). `total` is the running totals
 * through this segment, which binds the summary (F-193); omitted, the segment
 * is the pre-F-193 shape. Returns { seq, hash }.
 */
export function sealSegment(ledgerPath, prevSegments, prevTip, entries, total) {
  mkdirSync(coldDir(ledgerPath), { recursive: true });
  mkdirSync(idxDir(ledgerPath), { recursive: true });
  const seq = prevSegments + 1;
  // writing seq over a trail that already goes past it would overwrite real
  // history; checkHead refuses that first, this holds it for any other caller
  if (existsSync(segPath(ledgerPath, seq + 1)))
    throw new ArchiveError(
      'LEDGER_ARCHIVE_BROKEN',
      `cold segment ${seq + 1} already exists — refusing to rewrite segment ${seq}`,
      { ledgerPath },
    );
  const hash = segmentHash(seq, prevTip, entries, total);
  writeFileAtomic(
    segPath(ledgerPath, seq),
    `${JSON.stringify(total === undefined ? { seq, prev: prevTip, entries, hash } : { seq, prev: prevTip, entries, total, hash })}\n`,
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
  return seqsOnDisk(ledgerPath).length;
}

/** The seq numbers of the segment files on disk, ascending. Lists the cold folder once. */
function seqsOnDisk(ledgerPath) {
  const d = coldDir(ledgerPath);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => /^\d{6,}\.json$/.test(f))
    .map((f) => Number(f.slice(0, -'.json'.length)))
    .sort((a, b) => a - b);
}
