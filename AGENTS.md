# AGENTS.md

Instructions for any coding agent working in this repository. The
non-negotiables live in CONSTITUTION.md; the full rulebook in docs/RULES.md.

## Setup & checks (run these; they are the gate)

- Install: nothing to install — plain Node ≥ 20, macOS/Linux, zero deps.
- Unit + CLI suites: `npm test`
- Eval harness suite: `npm run test:eval`
- Everything: `npm run test:all`
- Mutation drill (run when touching scorer/runner/any fail-closed path):
  `npm run drill`
- Ledger invariant fuzz (run when touching src/ledger.mjs): `npm run fuzz`
- Format: `npm run format:check` (prettier 3.9.10, pinned)
- Full audit against the testing standard (T0/T2/T3/§14, one command):
  `npm run audit` — see docs/testing-profile.md

## Code style

- ES modules, Node built-ins only. Never add a runtime dependency.
- Prettier governs formatting; don't hand-format.
- Comments state constraints the code can't show — no narration.

## Hard rules

- Every refusal path needs a negative test; every bugfix needs an
  attack-shaped regression test in the same PR.
- Diffs touching `src/ledger.mjs` lock/reserve/settle/flags, or the
  scorer's rules, require the three-tables file in `specs/` (see
  CONSTITUTION #4) and independent adversarial review before merge.
- Error codes, env var names, JSON shapes, and exit codes are public API —
  changing any is a semver-relevant change with a CHANGELOG entry.
- `eval/` has its own AGENTS.md with stricter rules — read it before
  touching anything there.

## PR expectations

Conventional Commits; CHANGELOG under [Unreleased] for user-facing changes;
the PR template checklist is enforced, not decorative.
