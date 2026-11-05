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
 * reserve and by the seal under the ledger lock, after adoptLeftover. Reads
 * one segment, the head, whatever the history, and checks:
 * - the head exists, passes its hash, and is the summary's tip;
 * - the summary's totals equal the head's running total (hash-covered);
 * - no segment N+1 or N+2 past the summary exists. A crashed seal's leftover
 *   is adopted before this runs, so one still there means the summary was
 *   rolled back or dropped. A stray file further out costs a folder listing
 *   per call to find, so it is left to `sakk ledger verify`.
 * A head sealed before F-193 has no running total: the chain is walked once
 * per call until the next seal writes one. Throws LEDGER_ARCHIVE_BROKEN.
 *
 * Limit: the hash is unkeyed and the trail is a local file, so a writer who
 * rewrites the summary, deletes the newer segments and their index entries,
 * or rehashes the trail is not caught here. Keeping the agent from writing the
 * ledger at all is the guard's job (it denies writes into ~/.sakk).
 */
export function checkHead(ledgerPath, archive) {
  validateArchive(archive, ledgerPath);
  const bad = (why) => {
    throw new ArchiveError('LEDGER_ARCHIVE_BROKEN', `${why} — run sakk ledger verify`, {
      ledgerPath,
    });
  };
  for (const past of [archive.segments + 1, archive.segments + 2])
    if (existsSync(segPath(ledgerPath, past)))
      bad(`cold segment ${past} exists past the summary — the summary was rolled back`);
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
      // a string amount would concatenate, and "0" + "0.5" - 0.5 is 0: type-check first
      if (
        seg.entries.some((e) => typeof e?.actualUsd !== 'number' || !Number.isFinite(e.actualUsd))
      )
        bad(`cold segment ${seq} holds an entry with no valid amount`);
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
 * The segment a seal that crashed before its hot commit left past the summary
 * (F-193 review). It is adopted as written, never sealed again: a segment
 * number on disk is never rewritten, so no later edit of the hot file can
 * change what segment N+1 says. Returns null when there is none, else
 * { archive, entries }: the summary through it and its entries.
 *
 * Throws LEDGER_ARCHIVE_BROKEN unless it is a clean continuation of the
 * summary: it links to the tip, no segment past it is on disk, every entry
 * is a settled call with a unique id and a valid amount, its running total
 * is the summary plus its entries, and every entry still in hot holds the
 * same reservation, and the same amount if it settled there.
 */
export function leftoverSegment(ledgerPath, archive, hotEntries) {
  validateArchive(archive, ledgerPath);
  const next = archive.segments + 1;
  if (!existsSync(segPath(ledgerPath, next))) return null;
  const bad = (why) => {
    throw new ArchiveError(
      'LEDGER_ARCHIVE_BROKEN',
      `cold segment ${next} exists past the summary — ${why} — run sakk ledger verify`,
      { ledgerPath, seq: next },
    );
  };
  const seg = readSegment(ledgerPath, next);
  if (seg.prev !== archive.tip) bad('it does not link to the summary tip');
  // rare path (only after a crash): one folder listing
  if (seqsOnDisk(ledgerPath).some((s) => s > next)) bad('the summary was rolled back');
  const hot = new Map(hotEntries.map((e) => [e?.callId, e]));
  const ids = new Set();
  let usd = 0;
  for (const e of seg.entries) {
    if (
      e === null ||
      typeof e !== 'object' ||
      typeof e.callId !== 'string' ||
      e.callId === '' ||
      ids.has(e.callId) ||
      e.status !== 'SETTLED' ||
      typeof e.actualUsd !== 'number' ||
      !Number.isFinite(e.actualUsd) ||
      e.actualUsd < 0
    )
      bad('it holds an entry that is not a settled call');
    ids.add(e.callId);
    const h = hot.get(e.callId);
    // the crash left hot as it was before that settle, so it holds every
    // entry the seal took: one missing means hot was rolled back
    if (
      h === undefined ||
      h.estimatedMaxUsd !== e.estimatedMaxUsd ||
      (h.status === 'SETTLED' && h.actualUsd !== e.actualUsd)
    )
      bad(`its entry ${e.callId} does not match the hot file`);
    usd += e.actualUsd;
  }
  const total = {
    settledCount: archive.settledCount + seg.entries.length,
    settledUsd: archive.settledUsd + usd,
  };
  // written so a NaN fails rather than passes
  if (
    seg.total !== undefined &&
    (seg.total.settledCount !== total.settledCount ||
      !(Math.abs(seg.total.settledUsd - total.settledUsd) <= 1e-9))
  )
    bad('its running total is not the summary plus its entries');
  return {
    archive: { segments: next, ...(seg.total ?? total), tip: seg.hash },
    entries: seg.entries,
  };
}

/**
 * The cold segment files on disk are exactly 1..segments. A gap, a missing
 * segment or one past the summary is LEDGER_ARCHIVE_BROKEN (verify adopts a
 * crashed seal's leftover into the summary it checks first). Lists the cold
 * folder once; used by `sakk ledger verify`, off the gate path.
 */
export function checkSegmentFiles(ledgerPath, archive) {
  validateArchive(archive, ledgerPath);
  const seqs = seqsOnDisk(ledgerPath);
  if (seqs.length !== archive.segments || !seqs.every((s, i) => s === i + 1))
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
 * then the shards, then the caller commits the hot file. A crash before that
 * commit leaves the segment past the summary, and the next reserve or settle
 * adopts it as written (leftoverSegment). `total` is the running totals
 * through this segment, which binds the summary (F-193); omitted, the segment
 * is the pre-F-193 shape. Returns { seq, hash }.
 */
export function sealSegment(ledgerPath, prevSegments, prevTip, entries, total) {
  mkdirSync(coldDir(ledgerPath), { recursive: true });
  const seq = prevSegments + 1;
  // a segment number on disk is never written again: rewriting seq, or seq
  // under a trail that goes past it, would replace history (F-193 review);
  // checkHead refuses that first, this holds it for any other caller
  for (const taken of [seq, seq + 1])
    if (existsSync(segPath(ledgerPath, taken)))
      throw new ArchiveError(
        'LEDGER_ARCHIVE_BROKEN',
        `cold segment ${taken} already exists — refusing to rewrite segment ${seq}`,
        { ledgerPath },
      );
  const hash = segmentHash(seq, prevTip, entries, total);
  writeFileAtomic(
    segPath(ledgerPath, seq),
    `${JSON.stringify(total === undefined ? { seq, prev: prevTip, entries, hash } : { seq, prev: prevTip, entries, total, hash })}\n`,
  );
  indexSegment(ledgerPath, seq, entries);
  return { seq, hash };
}

/**
 * Record a segment's call-ids in the index: each shard they fall in is merged
 * and rewritten. Idempotent, so adopting a crashed seal's leftover can redo
 * it whether or not the crash came before the shards were written.
 */
export function indexSegment(ledgerPath, seq, entries) {
  mkdirSync(idxDir(ledgerPath), { recursive: true });
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
