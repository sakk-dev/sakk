# Ledger money core — three tables + contract

The original product: reserve before a paid call, settle after, refuse
everything pathological. Written after the fact (finding F-86: the money
paths had no three-tables spec — `test/core-specs.test.mjs` was satisfied by
the kill-switch spec, which covers only the halt). Every guard names the
test that holds it; `test/core-specs.test.mjs` checks the names resolve. The
halt and resume paths are specified in `specs/kill-switch/spec.md`.

## Table 1 — danger surface

| Surface      | Danger                                                                       | Guard (mechanism + test)                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cap          | A reservation that reaches or crosses the cap is granted                     | `>= cap − ε` refuses · `test/ledger.test.mjs::exactly at the cap: refused (the cap is a wall, not a target)` (drill MUT-X)                                                                  |
| Concurrency  | Two processes overspend or lose a booked reservation                         | mkdir lock around read-modify-write · `test/ledger.test.mjs::8 concurrent processes cannot jointly overspend, and every grant is booked` (drill MUT-Z)                                      |
| Identity     | One ledger reached by two paths forks the books                              | canonical directory, link-free file (`LEDGER_PATH_NOT_CANONICAL`) · `test/ledger.test.mjs::F-85: a ledger reached through a symlinked or hard-linked FILE refuses`                          |
| Duplicates   | A repeated callId runs the paid action twice                                 | `DUPLICATE_CALL_ID` whatever the status · `test/ledger.test.mjs::duplicate callId`                                                                                                          |
| Shape        | A hand-edited book frees cap (negative entry, string cap)                    | closed schema, typed entries · `test/ledger.test.mjs::a RESERVED entry with a negative estimate (it would free cap)`                                                                        |
| Freshness    | A stale ledger is spent from, or made fresh by a write that confirms nothing | 7-day bound; settle/halt/resume keep `updatedAt` · `test/ledger.test.mjs::review S1: settling an old reservation does not make a stale ledger fresh`                                        |
| Unknown cost | A failed call with unknowable cost is booked as a number                     | entry and flag enter reconciliation; a person clears it · `test/ledger.test.mjs::MCP review N8: an entry awaiting reconciliation can be settled by a person, not through the agent channel` |
| Lock debris  | A crashed holder's lock is broken while its owner may be alive               | only a dead same-host pid is broken · `test/ledger.test.mjs::owned by a live process we may not signal (EPERM, pid 1)`                                                                      |
| Files        | Alerts or decisions are written through a planted symlink                    | `appendNoFollow` · `test/ledger.test.mjs::review S4: the alert file is never written through a planted symlink`                                                                             |

## Table 2 — failure modes

- Refusals carry a code: `BUDGET_EXCEEDED`, `DUPLICATE_CALL_ID`, `ESTIMATE_INVALID`, `CALL_ID_REQUIRED`, `LEDGER_MISSING`, `LEDGER_UNREADABLE`, `LEDGER_MALFORMED`, `LEDGER_SCHEMA_INVALID`, `LEDGER_STALE`, `LEDGER_COST_UNCOMPUTABLE`, `LEDGER_LOCK_UNAVAILABLE`, `LEDGER_WRITE_FAILED`, `LEDGER_PATH_NOT_CANONICAL`, `RECONCILIATION_REQUIRED`, `RECONCILIATION_ENTRIES_OPEN`, `SETTLE_UNKNOWN_CALL`, `SETTLE_INVALID`, `SETTLE_MISMATCH`, `SETTLE_RECONCILIATION_HUMAN_ONLY`.
- `sakk status` exits 3 while a person must act (reconciliation by flag or entry, or stale), 4 while globally halted.
- Not covered by design: cross-host sharing of one ledger directory (the dead-owner check compares hostnames); a crash inside the lock's create/release window leaves a lock only `sakk unlock` clears (fail-closed); macOS fsync does not flush the drive cache.

## Table 3 — audit questions

- What was reserved, settled and still outstanding, against which cap? (`sakk status --json`)
- Did anything try to spend after a refusal, a halt or a stale bound? (`sakk-alerts.jsonl`)
- Who cleared a reconciliation or confirmed stale books, and when? (`flags.lastReconciledBy`)

## Contract

No reservation is granted at or past the cap, under any interleaving of
processes, through any spelling of the ledger's path; every grant is booked;
a ledger the code cannot fully read or that nobody confirmed for 7 days
refuses spending until a named person acts.
