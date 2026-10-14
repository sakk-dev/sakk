# Engineering Rules (R-01…R-13)

The living rulebook behind CONSTITUTION.md. Every rule carries its source
incident (a review finding of this repo, or a V6-era rule earned by
incident), its trigger, and how it is checked. Rules evolve through the
loop at the bottom; changing this file is an L1 review.

| #    | Rule                                                                                                  | Source                             | Trigger                                | Check                                        |
| ---- | ----------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------- | -------------------------------------------- |
| R-01 | Threat model first: adversary table before coding                                                     | D2, E4, F15                        | touching money/evidence/isolation      | three-tables file in `specs/`, checked at PR |
| R-02 | Evidence-source declaration: every judgement names its source of truth; self-reports only cross-check | D3, E3 + V6 Verified Reporting     | new/changed scoring rule               | declaration in specs/ + review               |
| R-03 | Input-space enumeration: parsers/selectors cover null/empty/wrong-type/boundary                       | D4, E5, F1, F3                     | new parsing function                   | table in specs/ + negative tests             |
| R-04 | Empty set is an error: a filter/gate selecting nothing refuses, never silently green                  | E5 + V6 False-Green ban            | any filtered execution entry           | machine gate (tests pin exit 2)              |
| R-05 | Concurrency / money-semantics diffs get independent adversarial review before merge                   | D1, F2 + V6 CCR                    | diff touches lock/reserve/settle/flags | PR process + reviewer that didn't write it   |
| R-06 | Every fix ships an attack-shaped regression test; money fixes add a mutation anchor                   | whole batch                        | every bugfix                           | PR checklist                                 |
| R-07 | Published numbers must be consumable: a reported figure must work when acted on                       | E6                                 | new output field                       | review checklist                             |
| R-08 | Anomalies leave a trail: any event that pierces an expectation alerts/flags                           | E1                                 | gate-bypass/overrun paths              | machine gate (tests pin alerts)              |
| R-09 | Trust fields are schema-required; halts judge from two sources                                        | E2                                 | schema change                          | machine gate                                 |
| R-10 | Interface first: capability contracts of external/real modes freeze before rules that depend on them  | D3 + V6                            | cross-mode/cross-process feature       | design section in specs/                     |
| R-11 | Done = converged: implementation checked against the written contract, adversarial coverage included  | D2, D3 + V6 Test Completeness Gate | before claiming done                   | converge check in PR                         |
| R-12 | Cross-cutting doctrine audits: changing a doctrine greps every existing rule for consistency          | E3, F13                            | doctrine-level change                  | review checklist                             |
| R-13 | Second-bounce breaker: the same defect bounced twice stops the line for redesign                      | V6 NO-WAKE-LOOP                    | any fix loop                           | process                                      |

## Attribution log (evolution loop, round 1 — 2026-10-15)

All 31 findings of the first review cycle attributed:

- **Rule missing → created**: R-01 (D2/E4/F15), R-03 (D4/E5/F1/F3), R-07
  (E6), R-08 (E1), R-09 (E2).
- **Rule existed in V6, not ported → ported**: R-04 (E5 was a textbook
  silent-skip), R-02/R-12 (E3/D3/F13 doctrine drift), R-05 (D1 — the fix
  for F1 introduced D1 _because_ no independent review gated it), R-10
  (D3), R-11 (D2/D3), R-13.
- **Machine gates added this round**: strict selector (R-04), overrun alert
  - halt (R-08), schema-required flags + dual-source halt (R-09), hostile
    recorder suite + env strip (R-01), invariant fuzz (R-05 backstop).

## Evolution loop

1. Every new finding is attributed: existing rule failed (which, why) OR
   rule missing (add it). No orphan findings.
2. A new rule that can be machine-checked ships WITH its gate; otherwise it
   enters the PR checklist.
3. At every milestone: review each rule — kept (it caught something),
   evolved, or retired (never triggered). Ask the model-relative question:
   "is the 'model can't do this' assumption behind this rule still true?"
   Prune CONSTITUTION/CLAUDE.md the same way.
