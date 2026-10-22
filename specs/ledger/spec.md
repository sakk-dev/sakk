# Ledger money core — three tables + contract

The original product: reserve before a paid call, settle after, refuse
everything pathological. Written after the fact (finding F-86: the money
paths had no three-tables spec — `test/core-specs.test.mjs` was satisfied by
the kill-switch spec, which covers only the halt). Every guard names the
test that holds it; `test/core-specs.test.mjs` checks the names resolve. The
halt and resume paths are specified in `specs/kill-switch/spec.md`.

## Table 1 — danger surface

| Surface      | Danger                                                                       | Guard (mechanism + test)                                                                                                                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cap          | A reservation that reaches or crosses the cap is granted                     | `>= cap − ε` refuses · `test/ledger.test.mjs::exactly at the cap: refused (the cap is a wall, not a target)` (drill MUT-X)                                                                                                                              |
| Concurrency  | Two processes overspend or lose a booked reservation                         | mkdir lock around read-modify-write · `test/ledger.test.mjs::8 concurrent processes cannot jointly overspend, and every grant is booked` (drill MUT-Z)                                                                                                  |
| Identity     | One ledger reached by two paths forks the books                              | canonical directory, link-free file (`LEDGER_PATH_NOT_CANONICAL`) · `test/ledger.test.mjs::F-85: a ledger reached through a symlinked or hard-linked FILE refuses`                                                                                      |
| Duplicates   | A repeated callId runs the paid action twice                                 | `DUPLICATE_CALL_ID` whatever the status · `test/ledger.test.mjs::duplicate callId`                                                                                                                                                                      |
| Shape        | A hand-edited book frees cap (negative entry, string cap)                    | closed schema, typed entries · `test/ledger.test.mjs::a RESERVED entry with a negative estimate (it would free cap)`                                                                                                                                    |
| Freshness    | A stale ledger is spent from, or made fresh by a write that confirms nothing | 7-day bound; settle/halt/resume keep `updatedAt` · `test/ledger.test.mjs::review S1: settling an old reservation does not make a stale ledger fresh`                                                                                                    |
| Unknown cost | A failed call with unknowable cost is booked as a number                     | entry and flag enter reconciliation; a person clears it · `test/ledger.test.mjs::MCP review N8: an entry awaiting reconciliation can be settled by a person, not through the agent channel`                                                             |
| Lock debris  | A crashed holder's lock is broken while its owner may be alive               | only a dead same-host pid is broken · `test/ledger.test.mjs::owned by a live process we may not signal (EPERM, pid 1)`                                                                                                                                  |
| Files        | Alerts or decisions are written through a planted symlink                    | `appendNoFollow` · `test/ledger.test.mjs::review S4: the alert file is never written through a planted symlink`                                                                                                                                         |
| Cold trail   | A sealed segment is altered or lost, or the summary's shape is wrong         | shape check on every read + hash-chain `sakk ledger verify` (the gate's total lives in the hot summary, so a lost segment fails the audit, not the gate) · `test/ledger-archive.test.mjs::verify catches a flipped byte, a broken link and a wrong tip` |
| In-flight    | Reservations pile up unsettled and grow the hot file without bound           | `MAX_INFLIGHT` (10,000) outstanding then `LEDGER_FULL`; settling still works · `test/ledger-archive.test.mjs::settling past the seal threshold always seals, never leaves hot unbounded`                                                                |
| Seal crash   | A crash mid-seal loses a settled entry or forks the books                    | segment→index→hot order, hot authoritative, redoable prefix · `test/ledger-archive.test.mjs::a seal interrupted before the hot commit is a redoable prefix, no entry lost`                                                                              |

## The hot/cold split (F-105, schema v3)

The books grew without bound: every call read and rewrote the whole
`ledger.json`, so per-call cost rose with history (2万 entries → 96 ms,
10万 → 539 ms; at ~40万 a call crosses the hook's 2 s deadline and every
call is refused). v3 keeps the live file small and bounded while losing no
entry and capping nothing.

- **Hot file** (`ledger.json`): the cap, flags, halt, the outstanding
  reservations, the settled entries not yet sealed, and an `archive`
  summary `{segments, settledCount, settledUsd, tip}`. The gate's decision
  reads only this file: `totalsOf` = `archive.settledUsd` + hot settled +
  hot outstanding. Per-call cost is bounded by the hot size, whatever the
  history.
- **Cold segments** (`ledger.json.cold/<seq>.json`): settled entries sealed
  in append-only segments of `SEAL_AT` each, hash-chained
  (`hash = sha256(seq, prev, entries)`, `prev` = the previous segment's
  hash, the first segment's `prev` = `""`). `archive.tip` is the last
  segment's hash. A segment is never rewritten once sealed.
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

The gate reads **only the hot file** — never a cold segment — so a call
costs the same whatever the history; the archive summary is checked for
shape on every read (a corrupt or missing summary refuses, never reads as
zero settled), but the go/no-go trusts the hot summary the same way it
trusts the cap and the entries beside it. Cold integrity — a lost or altered
segment — is `sakk ledger verify`, which walks the whole hash chain on
demand; losing a segment does not change the gate's total (that lives in the
hot summary), it fails the audit. `sakk ledger export` rebuilds one flat
ledger from cold + hot.

## Table 2 — failure modes

- Refusals carry a code: `BUDGET_EXCEEDED`, `DUPLICATE_CALL_ID`, `ESTIMATE_INVALID`, `INPUT_TOO_LONG`, `INPUT_INVALID`, `CALL_ID_REQUIRED`, `LEDGER_MISSING`, `LEDGER_UNREADABLE`, `LEDGER_MALFORMED`, `LEDGER_SCHEMA_INVALID`, `LEDGER_STALE`, `LEDGER_COST_UNCOMPUTABLE`, `LEDGER_LOCK_UNAVAILABLE`, `LEDGER_WRITE_FAILED`, `LEDGER_PATH_NOT_CANONICAL`, `LEDGER_FULL`, `LEDGER_ARCHIVE_BROKEN`, `RECONCILIATION_REQUIRED`, `RECONCILIATION_ENTRIES_OPEN`, `SETTLE_UNKNOWN_CALL`, `SETTLE_INVALID`, `SETTLE_MISMATCH`, `SETTLE_RECONCILIATION_HUMAN_ONLY`.
- The cold trail is an audit record, not the gate's authority: the go/no-go uses the hot file's atomic summary and never reads a cold segment, so the call stays flat. A read checks the summary's shape (a corrupt or missing summary refuses); `sakk ledger verify` walks the whole chain on demand. Not covered by design: an operator who hand-edits the hot summary itself (the same trust model as a hand-edited cap — a closed schema and the chain detect a changed cold trail, not a rewritten hot total).
- `sakk status` exits 3 while a person must act (reconciliation by flag or entry, or stale), 4 while globally halted.
- Not covered by design: cross-host sharing of one ledger directory (the dead-owner check compares hostnames); a crash inside the lock's create/release window leaves a lock only `sakk unlock` clears (fail-closed); macOS fsync does not flush the drive cache.

## Table 3 — audit questions

- What was reserved, settled and still outstanding, against which cap? (`sakk status --json`)
- Did anything try to spend after a refusal, a halt or a stale bound? (`sakk-alerts.jsonl`)
- Who cleared a reconciliation or confirmed stale books, and when? (`flags.lastReconciledBy`)
- Is the whole settled history intact and unaltered? (`sakk ledger verify` walks the hash chain) and can it be read as one flat book? (`sakk ledger export`)

## Contract

No reservation is granted at or past the cap, under any interleaving of
processes, through any spelling of the ledger's path; every grant is booked;
a ledger the code cannot fully read or that nobody confirmed for 7 days
refuses spending until a named person acts. Settled history is sealed into
an append-only hash-chained cold trail so the live file stays bounded and a
call costs the same whatever the history; no settled entry is dropped, and a
lost or altered segment is caught rather than read as free cap.
