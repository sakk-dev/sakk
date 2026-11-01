# AGENTS.md

Instructions for any coding agent working in this repository. The
non-negotiables live in CONSTITUTION.md; the full rulebook in docs/RULES.md.

## Before you change anything (self-evolution, R-22 — enforced, not optional)

1. `npm run brief -- <paths you will touch>`: the problem classes those
   files have hit, the questions this branch must answer, and the blind
   spots of the checks that will run.
2. Answer them in `findings/acks/<branch>.json` — how this change avoids
   each one (40+ characters, no copy-paste between answers). Until then a
   Claude Code edit of those files — or a shell command that may write — is
   blocked (PreToolUse hook), a commit is
   refused (git pre-commit hook, turned on by `npm run hooks`), and CI fails
   the branch. Codex and people meet the same git hooks and CI.
3. Every problem you see goes to the ledger: `npm run inbox -- add "<what>"`
   (a red `npm run audit` step does this itself), then log it in
   `findings/ledger.json` **under its class in `findings/classes.json`** —
   a new instance of a known problem is an occurrence of that class, never a
   new class. A new class must say why it is none of the existing ones and
   carry an approval. Commits are refused while the inbox is not empty.
4. A `fix` commit names its finding (`F-nn`) or says `No-finding: <why>`.

Details: docs/SELF_EVOLUTION.md.

## Setup & checks (run these; they are the gate)

- Install: nothing to install — plain Node ≥ 20, macOS/Linux, zero deps.
- Unit + CLI suites: `npm test`
- Eval harness suite: `npm run test:eval`
- Everything: `npm run test:all`
- Mutation drill (run when touching scorer/runner/any fail-closed path):
  `npm run drill`
- Ledger invariant fuzz (run when touching src/ledger.mjs): `npm run fuzz`
- Format: `npm run format:check` (prettier 3.9.10, pinned) · lint: `npm run lint`
  (ESLint 10.13.0, pinned, core rules only)
- Commit gate (exit codes passed straight through, never via tail/grep):
  `npm run gate && git commit`
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
