## What this changes

<!-- One logical change. Link the issue: Fixes #NNN -->

## Ledger brief (R-22)

<!-- Paste the "Past findings here" and "Ask before you build" lines from
`npm run brief` for this change, and say how the change answers each question. -->

## Checklist

- [ ] `npm run test:all` green locally
- [ ] New/changed behavior has tests; weakened guards have a red mutation drill
- [ ] `npm run format:check` passes
- [ ] `CHANGELOG.md` updated under `[Unreleased]` (user-facing changes)
- [ ] No new runtime dependencies
- [ ] Case/fixture/scoring/schema changes reviewed as executable code
- [ ] Core-area change: three-tables + contract in `specs/` and converge check done (R-01/R-11)
- [ ] Bugfix: attack-shaped regression included; self-report verified / partial / failed
- [ ] Every problem found while building is in `findings/ledger.json` (areas, root cause, guard; escape fields if its class had a detector)
- [ ] CLA signed (bot will prompt on first PR)

## Money semantics

<!-- If this touches reserve/settle/reconciliation/caps/refusal codes:
explain the before/after semantics and why it is safe. -->
