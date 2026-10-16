# Stop-line review — 2026-10-17 (independent review round, plan items 1–4)

Standard §14.4. The first review on a different model (Claude Fable 5,
fresh clone, rule R-21) found 3 blockers and 17 should-fix items across
the four modules, after three same-model rounds had passed them. Four
classes recurred past the earlier stop-line (`2026-10-16-stopline.md`).
Ledger: F-62 … F-79.

The common answer to "why did the countermeasure not hold": **the
detectors from the first stop-line each pinned one textual shape of their
class.** `claims-are-checked` matched refusal codes but not format
sentences; the stopwatch sweep matched `Date.now() - t` but not deadlines;
`cli-strictness` covered absent CLI arguments but not absent JSON keys.
A new shape of the same class walked past each of them. This round's
mechanisms are generative or exhaustive where they can be, so a new shape
is enumerated rather than anticipated.

## Pattern fail-open-absence (12th instance, F-65) — RC-01

A REAL bundle without its model id, a run without `harness_dirty`, a pack
report missing a key: each read as agreement.

- Mechanism now: `test/bundle-absence.test.mjs` deletes **every** key of
  every document in a real bundle and requires each deletion that still
  passes to be declared with its reason (46 are). New keys are covered
  without anyone thinking of them. Drill MUT-U, MUT-V hold the checks.
- F-79 (found by this round's audit): the "whole repository" self-scan
  test scanned seven named directories; it now scans the root.
- Remaining exposure: library function arguments (unchanged since the
  first stop-line); the runner-observed facts themselves (`harness_dirty`,
  requested model id) can be flipped by a forger — measured as a KNOWN
  row, caught only by the out-of-band fingerprint.

## RC-12 — the measuring tool itself untested (F-62, F-66, F-78)

Two stopwatch shapes turned machine load into red audits; one guard test
proved a code was emitted rather than the outcome.

- Mechanism now: the stopwatch detector covers comparisons and deadlines
  and carries its own positive and negative controls; bounded work is
  asserted through the work counter (`details.budget`), order-dependent
  outcomes through order (a signal after the halt returns), never a clock.
- Remaining exposure: lock fairness — halt latency under heavy contention
  reached 8.1 s in 96 storms (0 bookings after a halt). Not a correctness
  failure; noted for the next kill-switch change.

## RC-10 — produced without verification (F-68, F-69, F-73, F-77)

Docs and pack sentences described intent; spec rows named tests that
drove a different path.

- Mechanism now: every new danger row in the four specs cites a test the
  core-specs detector resolves, and each such test was shown to fail on
  the reverted code (recorded per finding). Pack evidence sentences were
  re-read against each case's `scoring.json`.
- Remaining exposure: prose that is not a test name (README format
  descriptions) is still checked only by review. A detector for that is
  not proposed: it would check wording, not behaviour.

## RC-05 — trust boundary left undefended (F-70, F-71, F-76)

Operator text to the terminal, replace refs in the scanned repository, an
agent-writable `.git` as scorer evidence.

- Mechanism now: the scanner reads objects with replace refs disabled;
  status output goes through the same escaping as file names.
- Open: F-76. Moving the scorer's evidence off the workdir `.git` changes
  the frozen ruler and needs a decision; until then every affected pack
  requirement states the gap.

## RC-03 and RC-08 — second occurrences, mechanized

- RC-03 (F-11, F-63): context matrix — every recognized secret shape ×
  every position a fiction token can take; it fails on either historical
  bug when put back.
- RC-08 (F-49, F-67): every `writeLedger` call is classified as confirming
  the books or not; an unclassified write fails.
