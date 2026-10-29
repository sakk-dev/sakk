## What this changes

<!-- One logical change. Link the issue: Fixes #NNN -->

## Ledger brief (R-22)

<!-- The answers live in findings/acks/<branch>.json and CI checks they cover
every changed file. Summarise here which problem classes this change touched
and any finding it logged or attached to a class. -->

## Checklist

- [ ] `npm run test:all` green locally
- [ ] New/changed behavior has tests; weakened guards have a red mutation drill
- [ ] `npm run format:check` passes
- [ ] `CHANGELOG.md` updated under `[Unreleased]` (user-facing changes)
- [ ] No new runtime dependencies
- [ ] Case/fixture/scoring/schema changes reviewed as executable code
- [ ] Core-area change: three-tables + contract in `specs/` and converge check done (R-01/R-11)
- [ ] Bugfix: attack-shaped regression included; self-report verified / partial / failed
- [ ] A judgement on a command, path or tool call is made on the target it reaches, or asks / refuses / declares the gap where it cannot resolve it (R-23)
- [ ] A new subcommand, flag or file that changes a control is declared in `test/kill-switch.test.mjs`, and the agent it binds cannot loosen it (R-24)
- [ ] Every problem found while building is in `findings/ledger.json` (areas, root cause, guard; escape fields if its class had a detector)
- [ ] CLA signed (collected by the maintainer before your first merge)

## Money semantics

<!-- If this touches reserve/settle/reconciliation/caps/refusal codes:
explain the before/after semantics and why it is safe. -->
