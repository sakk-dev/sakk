# Hardening campaign (pre-publication test offensive)

Maintainer call 2026-10-16: publication waits until the system has been
tested HARD — long-running, multi-process, fault-injected, cross-platform,
real-client. Existing gates were all seconds-long, single-process, clean-
environment; the selling point is a gate that survives chaos, so chaos is
the test plan.

## Phases

| Phase          | Harness                                                                                                                                                                    | Question                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| T1 soak        | `campaign/soak-ledger.mjs` — N workers hammer one ledger for M minutes while the conductor SIGKILLs them randomly; continuous invariant audits + grant/booked cross-check  | does money survive chaos                      |
| T2 faults      | `campaign/fault-injection.mjs` — corrupt-ledger corpus (parse→mutate→stringify), permission faults, clock skew, lock debris                                                | is every way the world breaks a NAMED refusal |
| T3 MCP torture | `campaign/mcp-torture.mjs` — K servers on one ledger driven by seeded hostile clients (garbage frames, floods, bursts); zero-silent-drop guarantee via per-request timeout | does the enforcer survive hostile clients     |
| T4 matrix      | `campaign/matrix.sh` — node 20/22/24 containers × suites+faults+soak+torture + an ENOSPC probe on tiny tmpfs                                                               | same behavior everywhere, incl. disk-full     |
| T5 real client | real Claude Code with `sakk mcp` configured                                                                                                                                | does the first real consumer work             |
| T6 compat      | genesis-commit writer → current reader/writer                                                                                                                              | upgrades never corrupt books                  |

## Adversary/evidence discipline

Invariants (overspend, duplicate ids, alien statuses, booked⊆granted mod
kill-window, zero silent drops, typed-refusals-only, hash-pinned decision
lines) are asserted by the harnesses themselves; every run prints seeds —
`--seed N` replays byte-exactly. Reports go to the maintainer with raw counts.

## Findings → fixes (the loop, round 5)

- **C-4 (HIGH, product, fixed)**: unchecked `writeSync` return — a short
  write under ENOSPC installed truncated books atomically. Byte-accounted
  write loop + typed `LEDGER_WRITE_FAILED` + temp cleanup; the matrix
  ENOSPC probe now asserts post-disk-full readability. Found ONLY by the
  real-tmpfs leg: no amount of mocking found it locally — the chaos plan
  earning its keep.

- **C-1 (product, fixed here)**: `readLedger` tolerated unknown top-level
  keys — incl. an own `__proto__` key via JSON.parse. v1 is now a CLOSED
  schema (`LEDGER_TOP_KEYS`); unknown keys refuse `LEDGER_SCHEMA_INVALID`.
  Attack regression in test/ledger.test.mjs. Future fields = schema bump.
- **C-2 (measurement)**: under 8-way contention + kill-injection, lock
  waits time out (`LEDGER_LOCK_UNAVAILABLE`) at ~0.016% of ops (2/12,400)
  — documented behavior, now measured; enterprise fleets will see this
  rate class.
- **C-3 (gap, noted)**: no machine-readable public error-code registry —
  the torture harness had to grep codes out of source. Candidate: export a
  `CODES` map; parked for the next API-surface PR.
- **Harness lessons (three false alarms before one truth)**: regex
  "corruption" on pretty-printed JSON corrupts nothing — mutate parsed
  objects; a trailing-newline slice is not a truncation; a read-only FILE
  does not stop temp+rename writes (that is the atomic-write design — the
  directory is the permission gate). The harness asserts the design now.
- **Conductor lesson**: `cmd | tail` launders exit codes — long runs are
  launched bare.
