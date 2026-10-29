# Stop-line review — 2026-10-28 (V1 close-out, every open P0 failure deferred)

Standard §15.4: when a root-cause class's last two escapes both upgraded no
check ("none: …"), the line stops until a review says why. This is that
review for the twenty findings filed from the 2026-10-28 black-box P0 UAT
(F-182…F-201; method and per-case table in
`findings/reviews/2026-10-28-p0-uat-blackbox.md`).

**Why no check was upgraded.** On 2026-10-28 the owner closed V1 as it
stands (docs/DECISIONS.md D10): every open P0 failure moves to V2, the
security gaps are written down as known limits, and no code changes go
into V1. A detector added now would only turn red on code the owner has
decided not to change in this version. So each finding carries
`mechanism_upgrade: "none: deferred to V2 …"`, and docs/V2-BACKLOG.md
names, per finding, the fix, the sweep and the detector V2 must add. The
four classes this stops (C-02, C-05, C-07, C-08) carry the owner's waiver
pointing at D10; C-13's overdue debt became a waiver for the same reason;
C-15's dated debt was extended to F-201.

This is a deliberate, recorded gap, not a held countermeasure. V2 starts
by adding the detectors listed below, before any fix lands, so each fix is
proved by a check that was red first.

## RC-01 — assumption never verified (F-183, F-184, F-186, F-187, F-190)

The guard assumed its input arrives in the one spelling it knows: names in
one case (F-183, cases G-SEC-003/004/006/007/008), git's force flag in its
listed forms (F-184, G-SEC-005, J-UAT-015), a path whose name is the file
read (F-186, K-SEC-044), a policy file the agent cannot reach (F-187,
J-UAT-017), Write content that is a string (F-190, R-REL-001).

- Last two escapes: F-187 and F-190, both "none:" by D10.
- V2 detector: a spelling-variant table test that feeds every protected
  name and flag through case, cluster, prefix and link variants and
  requires the same verdict as the plain form; a type-fuzz test over every
  tool_input field.

## RC-04 — one surface covered, its siblings not (F-185, F-189, F-194)

A check written for one entry point left the others open: the R-24 gate
sees `sakk` but not a launcher (F-185, J-UAT-016); the install matcher
covers Read/Write/Bash but not Grep/Glob, and adds no deny-read rules
(F-189, G-SEC-012, G-INS-008); redaction covers the command field but not
path or scope (F-194, U-SEC-016/017, A-ACC-023).

- Last two escapes: F-189 and F-194, both "none:" by D10.
- V2 detector: an inventory test that lists every tool the agent can call
  and every field a decision record holds, and fails when one has no guard
  or no redaction path.

## RC-05 — trusted the agent's own state (F-191, F-193)

The spend gate reads the log folder from the agent's environment (F-191,
S-SEC-010) and trusts the hot-ledger summary without re-checking it
(F-193, L-REL-013).

- Last two escapes: F-191 and F-193, both "none:" by D10.
- V2 detector: a tamper test that moves the log folder and edits the
  summary, and requires reserve to refuse.

## RC-06 — a path only a real run exercises (F-201)

The console Stop button reads a token from an HttpOnly cookie, so the page
never sends it (F-201, U-FN-011). Unit tests called the route directly.
C-15's dated debt (gold v2, until 2026-11-30) now includes a browser run of
the button.

## RC-07 — legal obligation unchecked (F-199)

Code derived from MIT-licensed projects ships without their notices
(F-199, P-ACC-008). Release blocker, with F-111. V2 detector: a pack-time
test that requires a NOTICE entry for every `derived-from` header.

## RC-09 — one bad input takes down the whole command (F-192)

An unreadable agent log crashes `sakk spend` and the hook blames its rules
(F-192, S-REL-001). V2 detector: an EACCES fixture in the spend tests.

## RC-10 — claim without verification (F-182, F-188, F-195, F-196, F-197, F-198)

The 10-27 acceptance counted a case passed by test name (F-182); the spec
weakened REQ-G13's deny to ask (F-188, G-SEC-011); the console's
"read-only" and header claims (F-195, A-ACC-010, U-SEC-021/022); init's
"hook wired" (F-196, P-INS-001); the README plugin command (F-197,
P-INS-009); rule counts and checklist ticks (F-198, K-ACC-068, P-ACC-005).

- Last two escapes: F-197 and F-198, both "none:" by D10.
- V1 change: none to code. The false or stale claims are corrected or
  marked as known limits in README, GUARD.md and SPEND.md (D10), so the
  docs no longer state what the code does not do.
- V2 detector: a docs-claims test that runs every command shown in README
  and compares every count it states against the code; acceptance by
  expected result only (F-182), never by test name.

## RC-12 — the check's own pattern has holes (F-200)

The emittable-code detector's regex misses some source forms, so four
refusal codes have no negative test (F-200, A-ACC-006). V2 detector: parse
the source instead of matching text.

## Not new findings

A-ACC-014 and P-ACC-015 are F-111 (release version discipline, still a
release blocker). P-ACC-001, P-ACC-002, P-ACC-004, P-ACC-012 and P-INS-004
are features the owner deferred on 2026-10-27; they fail because they were
never built. All are in docs/V2-BACKLOG.md.
