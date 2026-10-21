# Stop-line review — 2026-10-17 (status demo)

the maintainer asked to see the project run end to end against the blueprint. The demo
(32 checks, all as expected) surfaced one problem: F-122.

## §15.4 — RC-04: F-120, F-122

Both escapes upgraded no check, so the class stops here.

- **F-120** (edits through the Bash tool bypass the edit hook) lists tool
  names instead of "every write to a tracked file"; it stays covered at
  commit and in CI, as the enforcement review recorded.
- **F-122** (one secret matched by two rules is reported twice) is the same
  shape in the scanner: the overlap rule was written for the second pass,
  where F-63 met it, instead of as "one secret is one finding" across both
  passes.

What the two share: a rule written at the place the instance appeared. The
class question C-02.1 already asks this; it was not asked of the scanner's
first pass because no change touched it after F-63.

Next upgrade (not made in this round — the request was a status view, not a
change): a scanner test that puts one secret where two patterns overlap and
expects one finding, then the fix in `scanText`. Until then F-122 is open and
the scan's exit code and fingerprints stay correct; only its count is high.

## §15.4 — RC-01: F-123, F-124

Found by onboarding the self-evolution kit into a fresh trial project, to
answer the maintainer's question "how does a new project join".

- **F-123** — the hooks name Sakk's own ledger test and `bin/sakk.mjs`, so a
  project that copies them cannot commit.
- **F-124** — with an empty ledger nothing is required: the 16 classes Sakk
  learned do not reach a new project until it logs a problem of its own.

Shared cause: the loop was only ever tried in the repository that grew it,
although the standard (§15.8) points every project at it. Neither escape
upgraded a check, so RC-01 stops here with F-114 and F-121 before them.

Next upgrade: one test that lays the kit into a temporary fresh project and
asserts (a) a commit goes through once the answers exist and (b) an edit is
refused on day one. It lands with the onboarding kit, after the maintainer decides the
starter set for F-124.
