# Ledger money core — three tables + contract

The original product: reserve before a paid call, settle after, refuse
everything pathological. Written after the fact (finding F-86: the money
paths had no three-tables spec — `test/core-specs.test.mjs` was satisfied by
the kill-switch spec, which covers only the halt). Every guard names the
test that holds it; `test/core-specs.test.mjs` checks the names resolve. The
halt and resume paths are specified in `specs/kill-switch/spec.md`.

## Table 1 — danger surface

| Surface      | Danger                                                                                      | Guard (mechanism + test)                                                                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cap          | A reservation that reaches or crosses the cap is granted                                    | `>= cap − ε` refuses · `test/ledger.test.mjs::exactly at the cap: refused (the cap is a wall, not a target)` (drill MUT-X)                                                                                                                                                                       |
| Concurrency  | Two processes overspend or lose a booked reservation                                        | mkdir lock around read-modify-write · `test/ledger.test.mjs::8 concurrent processes cannot jointly overspend, and every grant is booked` (drill MUT-Z)                                                                                                                                           |
| Identity     | One ledger reached by two paths forks the books                                             | canonical directory, link-free file (`LEDGER_PATH_NOT_CANONICAL`) · `test/ledger.test.mjs::F-85: a ledger reached through a symlinked or hard-linked FILE refuses`                                                                                                                               |
| Duplicates   | A repeated callId runs the paid action twice                                                | `DUPLICATE_CALL_ID` whatever the status · `test/ledger.test.mjs::duplicate callId`                                                                                                                                                                                                               |
| Shape        | A hand-edited book frees cap (negative entry, string cap)                                   | closed schema, typed entries · `test/ledger.test.mjs::a RESERVED entry with a negative estimate (it would free cap)`                                                                                                                                                                             |
| Freshness    | A stale ledger is spent from, or made fresh by a write that confirms nothing                | 7-day bound; settle/halt/resume keep `updatedAt` · `test/ledger.test.mjs::review S1: settling an old reservation does not make a stale ledger fresh`                                                                                                                                             |
| Unknown cost | A failed call with unknowable cost is booked as a number                                    | entry and flag enter reconciliation; a person clears it · `test/ledger.test.mjs::MCP review N8: an entry awaiting reconciliation can be settled by a person, not through the agent channel`                                                                                                      |
| Lock debris  | A crashed holder's lock is broken while its owner may be alive                              | only a dead same-host pid is broken · `test/ledger.test.mjs::owned by a live process we may not signal (EPERM, pid 1)`                                                                                                                                                                           |
| Files        | Alerts or decisions are written through a planted symlink                                   | `appendNoFollow` · `test/ledger.test.mjs::review S4: the alert file is never written through a planted symlink`                                                                                                                                                                                  |
| Cold trail   | A sealed segment is altered or lost, or the summary's shape is wrong                        | shape check on every read + hash-chain `sakk ledger verify` (an older segment's loss fails the audit; the head is checked by reserve, below) · `test/ledger-archive.test.mjs::verify catches a flipped byte, a broken link and a wrong tip`                                                      |
| Summary      | An edited hot summary frees cap, or a lost or rolled-back head goes unnoticed               | each segment's hash covers its running total; reserve and the seal check the summary against the head segment (`LEDGER_ARCHIVE_BROKEN`) · `test/ledger-archive.test.mjs::an edited summary is refused by reserve: the head segment binds the totals (F-193)`                                     |
| In-flight    | Reservations pile up unsettled and grow the hot file without bound                          | `MAX_INFLIGHT` (10,000) outstanding then `LEDGER_FULL`; settling still works · `test/ledger-archive.test.mjs::settling past the seal threshold always seals, never leaves hot unbounded`                                                                                                         |
| Seal crash   | A crash mid-seal loses a settled entry, forks the books or locks reserve                    | segment→index→hot order, hot authoritative, redoable prefix that reserve and `verify` accept and the next settle redoes · `test/ledger-archive.test.mjs::a seal that crashed before its hot commit stays usable: reserve, verify and a redo at any amount (F-193 review)`                        |
| Rollback     | A summary rolled back over real segments frees cap, or a later seal overwrites them         | the redoable prefix must match hot entry for entry; a seal refuses when a later segment exists (`LEDGER_ARCHIVE_BROKEN`) · `test/ledger-archive.test.mjs::a summary rolled back over a real segment is refused, and no seal overwrites that segment (F-193 review)`                              |
| Stray files  | A segment file past the summary, or a cold trail left by an earlier ledger, passes as sound | `verify` requires the files to be exactly 1..segments (one more only as the redoable prefix); `sakk init` refuses beside a leftover trail · `test/ledger-archive.test.mjs::verify reports a stray segment file past the summary; the files are exactly 1..segments`                              |
| Index loss   | The call-id index is lost or wrong, re-admitting a sealed call-id (a double-spend)          | reserve refuses when segments are sealed but the whole index is gone; `verify` checks every sealed call-id is in its shard; `sakk ledger reindex` rebuilds it from cold · `test/ledger-archive.test.mjs::verify catches a lost index, and reserve refuses rather than re-admit a sealed call-id` |

## The hot/cold split (F-105, schema v3)

The books grew without bound: every call read and rewrote the whole
`ledger.json`, so per-call cost rose with history (2万 entries → 96 ms,
10万 → 539 ms; at ~40万 a call crosses the hook's 2 s deadline and every
call is refused). v3 keeps the live file small and bounded while losing no
entry and capping nothing.

- **Hot file** (`ledger.json`): the cap, flags, halt, the outstanding
  reservations, the settled entries not yet sealed, and an `archive`
  summary `{segments, settledCount, settledUsd, tip}`. The gate's decision
  uses this file's totals: `totalsOf` = `archive.settledUsd` + hot settled +
  hot outstanding, with the summary first checked against the head segment
  (below). Per-call cost is bounded by the hot size plus one segment,
  whatever the history.
- **Cold segments** (`ledger.json.cold/<seq>.json`): settled entries sealed
  in append-only segments of `SEAL_AT` each, hash-chained
  (`hash = sha256(seq, prev, entries, total)`, `prev` = the previous
  segment's hash, the first segment's `prev` = `""`; `total` =
  `{settledCount, settledUsd}` through this segment, F-193 — a segment
  sealed by 0.4.0 has no `total` and hashes without it). `archive.tip` is
  the last segment's hash. A segment is never rewritten once sealed.
- **Index** (`ledger.json.idx/<3-hex>.json`): `callId → seq`, sharded by
  the first three hex of `sha256(callId)` (4096 shards), so a call-id lookup
  reads one small shard (about sealed-call-ids / 4096). It keeps "a call-id
  is never reused" across all history without reading cold.
- **In-flight cap**: at most `MAX_INFLIGHT` (10,000) reservations may be
  outstanding (RESERVED or awaiting reconciliation) at once — the only thing
  that can grow the hot file. Reaching it refuses new reservations
  (`LEDGER_FULL`); settling what is open always works. Owner's decision
  2026-10-22. Nothing caps total history.

All mutations run under the one mkdir lock, so there is never a concurrent
sealer. A seal writes the segment (fsync+rename), then the index shards
(fsync+rename), then commits the hot file (fsync+rename); the hot file is
authoritative, so a crash before its commit leaves the sealed segment and
index entries as a harmless re-doable prefix (the entries are still in hot).
The next settle redoes the seal, at whatever amount the triggering call
books, and overwrites that prefix; a seal never writes over a segment when
a later one exists, and `sakk init` refuses beside a leftover cold trail or
index (`LEDGER_ALREADY_EXISTS`).

The gate reads **the hot file plus one cold segment, the head**, so a call
costs the same whatever the history. The archive summary is checked for
shape on every read (a corrupt or missing summary refuses, never reads as
zero settled), and reserve then binds it to the cold trail (F-193): the head
segment must exist, pass its hash and be the summary's `tip`, its running
total must equal the summary's totals, and no segment may exist past the
summary unless it is the redoable prefix a crashed seal leaves: the one
next segment, linked to the tip, with no segment after it, every entry
still in hot at the same amounts (settled, except the one call whose settle
triggered the seal) and a total that adds up. A segment copied back over a
rolled-back summary fails this, so it cannot free cap. Any other state
refuses `LEDGER_ARCHIVE_BROKEN` and names `sakk ledger verify`. The seal
runs the same check before it extends the trail, so an edited summary is
never sealed into a new, self-consistent head. A head sealed by 0.4.0
carries no total: reserve walks the chain once per call until the next seal
writes one.

Limit: the hash is unkeyed and the trail is a local file. A writer who
rewrites the head segment (recomputing its hash) and the summary to match
passes reserve; `sakk ledger verify` still catches it, because it re-sums
every segment and checks each running total against the chain. Keeping the
agent from writing the ledger at all is the guard's job (it denies writes
into `~/.sakk`).

Older segments are audited by `sakk ledger verify`, which walks the whole
hash chain on demand; losing one of them does not change the gate's total,
it fails the audit. `sakk ledger export` rebuilds one flat ledger from
cold + hot.

## Table 2 — failure modes

- Refusals carry a code: `BUDGET_EXCEEDED`, `DUPLICATE_CALL_ID`, `ESTIMATE_INVALID`, `INPUT_TOO_LONG`, `INPUT_INVALID`, `CALL_ID_REQUIRED`, `LEDGER_MISSING`, `LEDGER_UNREADABLE`, `LEDGER_MALFORMED`, `LEDGER_SCHEMA_INVALID`, `LEDGER_STALE`, `LEDGER_COST_UNCOMPUTABLE`, `LEDGER_LOCK_UNAVAILABLE`, `LEDGER_WRITE_FAILED`, `LEDGER_PATH_NOT_CANONICAL`, `LEDGER_FULL`, `LEDGER_ARCHIVE_BROKEN`, `RECONCILIATION_REQUIRED`, `RECONCILIATION_ENTRIES_OPEN`, `SETTLE_UNKNOWN_CALL`, `SETTLE_INVALID`, `SETTLE_MISMATCH`, `SETTLE_RECONCILIATION_HUMAN_ONLY`.
- The go/no-go uses the hot file's atomic summary, checked against the head segment's hash-covered running total (one segment read, so the call stays flat); a mismatch, a lost or rolled-back head, or a removed summary refuses `LEDGER_ARCHIVE_BROKEN` (F-193). A read checks the summary's shape (a corrupt or missing summary refuses); `sakk ledger verify` walks the whole chain and the index on demand. What verify detects: accidental corruption (a flipped byte that was not re-hashed), a lost or truncated segment, and a lost or wrong index entry. What it does NOT detect: a writer who rewrites a sealed amount, recomputes that segment's and every later segment's running total and sha256, relinks every later `prev`/`hash`, and edits `archive.tip` and the summary totals — the chain hash is unkeyed and its tip lives in the writable hot file, so this is the same trust model as a hand-edited hot summary (a local file its owner can rewrite), not tamper-evidence against that owner. Signed/append-only out-of-band anchoring is a later milestone.
- `sakk status` exits 3 while a person must act (reconciliation by flag or entry, or stale), 4 while globally halted.
- Not covered by design: cross-host sharing of one ledger directory (the dead-owner check compares hostnames); a crash inside the lock's create/release window leaves a lock only `sakk unlock` clears (fail-closed); macOS fsync does not flush the drive cache; downgrading to 0.4.0 once a segment carries a running total (0.4.0 does not hash it, so its `verify` and `export` fail).

## Table 3 — audit questions

- What was reserved, settled and still outstanding, against which cap? (`sakk status --json`)
- Did anything try to spend after a refusal, a halt or a stale bound? (`sakk-alerts.jsonl`)
- Who cleared a reconciliation or confirmed stale books, and when? (`flags.lastReconciledBy`)
- Is the whole settled history free of accidental corruption or loss, and does the index cover it? (`sakk ledger verify` walks the hash chain and the index; it is not tamper-evidence against a writer who can recompute the unkeyed hashes) and can it be read as one flat book? (`sakk ledger export`)

## Contract

No reservation is granted at or past the cap, under any interleaving of
processes, through any spelling of the ledger's path; every grant is booked;
a ledger the code cannot fully read or that nobody confirmed for 7 days
refuses spending until a named person acts. Settled history is sealed into
an append-only hash-chained cold trail so the live file stays bounded and a
call costs the same whatever the history; no settled entry is dropped, and a
lost or altered segment is caught rather than read as free cap.
