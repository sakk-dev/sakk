# Contributing to Sakk

Thanks for your interest! Two ground rules keep this project sustainable:

1. **CLA required.** Sakk is dual-licensed (AGPL-3.0 + commercial). To keep
   that possible, all contributions must be covered by a Contributor License
   Agreement. Until a CLA bot is installed, the maintainer collects the
   signed CLA by hand before merging your first pull request.
2. **Tests carry the contract.** Every behavioral change needs a test, and
   every guard needs a negative test. If you weaken a fail-closed path, the
   mutation drills must catch you — that is by design.

## Development

- Plain Node ≥ 20, zero runtime dependencies. Keep it that way.
- `npm test` — ledger suite. `npm run test:eval` — eval harness suite.
  `npm run test:all` — both. All must be green before a PR.
- `npm run drill` — mutation drill: breaks one safety rule at a time in a
  temp copy and requires the named guardian test to go red. Run it when you
  touch the scorer, the runner, or any fail-closed path.
- `npm run fuzz` — seeded invariant fuzz on the ledger's money semantics
  (`SAKK_FUZZ_SEED=<n>` replays a reported seed exactly). Run it when you
  touch `src/ledger.mjs`.
- `npm run format:check` — Prettier (config in `.prettierrc.json`). CI
  enforces it.
- CI runs once per commit: on its pull request, and on `main` after the
  merge. A newer push to a pull request cancels the older run. A branch
  without a pull request gets no CI run; the pre-push hook checks it. The
  worst-case runner-minutes of one commit are capped by
  `test/ci-cost.test.mjs` — raising the cap states the cost in the PR.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:` — with a scope when
it helps (`feat(ledger): …`). Breaking changes get a `!` and a
`BREAKING CHANGE:` footer. Releases follow [SemVer](https://semver.org/);
user-facing changes get a line in `CHANGELOG.md` under `[Unreleased]`.

## Pull requests

- One logical change per PR; link the issue it addresses.
- At most three pull requests are open at once, drafts included. Merge or
  close one before opening a fourth: CI's cap step (`scripts/wip-limit.mjs`,
  the base branch's copy) fails every pull request after the three oldest.
- New or changed behavior → tests in the same PR. A weakened guard without a
  red drill is grounds for rejection on its own.
- Changes to money semantics (reserve/settle/reconciliation, caps, refusal
  codes) get extra scrutiny and may require a design discussion first — open
  an issue before writing code.

## Eval cases are executable code

`eval/cases/*.json` and `eval/gold/*/scoring.json` contain shell commands the
harness executes (`verification_commands`, `coverage_mutants.cmd`), and
`eval/schemas/*.json` feed `new RegExp`. Review changes to them with the same
severity as source code — a case or schema edit IS arbitrary code execution
in CI and on reviewers' machines.

## Quality pipeline (required)

CONSTITUTION.md states the non-negotiables; docs/RULES.md is the living
rulebook, where every rule carries the incident that earned it. What it
means for your PR, by scope:

- **Small diff** — explainable in one sentence, touches no core area:
  green tests + `npm run format:check`, normal review. That's it.
- **Core-area diff** — anything under `src/`, `bin/`, `eval/lib/` or
  `eval/bin/` (money, evidence, isolation, concurrency): before coding,
  add a short threat-model note to `specs/` (copy any file in
  `specs/retro/` as the template — who attacks, which inputs are
  pathological, what evidence judges success, what "done" means). The PR
  then ships the change **with** a test that re-runs the attack, passes
  `npm run test:all && npm run drill && npm run fuzz`, and gets a review
  from someone — or some AI agent — who didn't write it.
- **New subsystem**: all of the above, plus a maintainer-signed design
  review before implementation starts (`specs/<feature>/` holds the
  design: decide / spec / plan / contract).

Two process rules worth knowing up front: a bugfix PR states per finding
whether it is **verified fixed / partially fixed / not fixed** — no bare
"done"; and when the same defect bounces twice, we stop patching and
redesign instead of stacking a third patch.

## Reporting security issues

Never open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).
