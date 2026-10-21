# Decide — closing the self-evolution bypasses

**Go.** On 2026-10-21 the owner asked for the "check history before
development" mechanism to stop being bypassed. Blueprint line: the
self-evolution loop (testing standard §15). The ledger must act before the
next problem, and skipping it must fail.

- **Scope:** R1–R5 in `spec.md`. Shell writes, frozen answers, answers that
  name a check, recorded misses, and stop-the-line as a gate.
- **Out of scope:** proving that a guard fails on the bug (mutation), a model
  judge for answer truth, and porting to other projects (they take this spec
  as the reference).
- **Owner decision needed before merge:** the five classes stopped today
  (C-02, C-03, C-04, C-13, C-15). Each needs a detector, a waiver or dated
  debt. This branch closes C-02 with the F-120 fix. It proposes dated debt
  for the other four, tied to open-source v1 M0, and the pull request
  lists the dates for the owner to accept or change.
