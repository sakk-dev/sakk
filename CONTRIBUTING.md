# Contributing to Sakk

Thanks for your interest! Two ground rules keep this project sustainable:

1. **CLA required.** Sakk is dual-licensed (AGPL-3.0 + commercial). To keep
   that possible, all contributions must be covered by a Contributor License
   Agreement. The CLA bot will prompt you on your first pull request; PRs
   cannot merge without it.
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
- `npm run format:check` — Prettier (config in `.prettierrc.json`). CI
  enforces it.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:` — with a scope when
it helps (`feat(ledger): …`). Breaking changes get a `!` and a
`BREAKING CHANGE:` footer. Releases follow [SemVer](https://semver.org/);
user-facing changes get a line in `CHANGELOG.md` under `[Unreleased]`.

## Pull requests

- One logical change per PR; link the issue it addresses.
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

## The v3 quality pipeline (required)

CONSTITUTION.md states the non-negotiables; docs/RULES.md is the rulebook.
In short: one-sentence diffs go straight in (L0); anything touching money,
evidence, isolation or concurrency (L1 core) needs the three-tables +
acceptance contract in `specs/`, lands with attack-shaped tests, passes the
deterministic gates (`npm run test:all && npm run drill && npm run fuzz`),
and gets independent adversarial review before merge; paid-core blocks (L2)
additionally need a signed design review first. Fixes self-report
verified / partial / failed; the same defect bounced twice stops the line
for redesign.

## Reporting security issues

Never open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).
