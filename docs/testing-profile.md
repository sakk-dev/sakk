# Testing profile: Sakk

- **Standard:** internal AI-agent testing standard **v1.2** (layers T0–T6,
  change levels L0–L2, §14 root-cause attribution). The standard's text is
  not copied here; this file records only what is specific to Sakk.
- **Phase:** development → pre-release. Real-model runs are fail-closed
  behind approved gold labels and a model key (not yet provided).
- **One command:** `npm run audit` runs every applicable layer below, takes
  each exit code directly, writes logs to `audit-logs/<stamp>/` and a
  `SUMMARY.md`; any red step makes the audit red.

## Layers

| Layer            | Applies? | How Sakk meets it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status                                                                       |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| T0 deterministic | yes      | lint (`npm run lint`, ESLint core rules, 0 warnings) + format + `npm test` + `npm run test:eval`; commit gate `npm run gate && git commit` (exit codes passed straight through, standard §12.3); every refusal code asserted by a test (`test/claims-are-checked.test.mjs`); mutation drill, one anchor per core guard (23 anchors, `test/core-specs.test.mjs` requires one per core file); invariant fuzz for every L1 module (`fuzz` ledger, `fuzz:policy`, `fuzz:l1` packs/scan/bundle — each with PASS controls); secret self-scan; frozen gold set (`test/gold-set-frozen.test.mjs`) | verified                                                                     |
| T1 judge         | no       | Sakk has no model judge: the gold scorer is deterministic code, and its ability to fail is proven by the drill                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | n/a                                                                          |
| T2 reliability   | partly   | `npm run golden-k` — every gold case k = 3, key cases (G05, G06, G07, G12) k = 5, pass@1 with Wilson 95% interval, pass^k, run-to-run stability; k and thresholds from `eval/thresholds.json`                                                                                                                                                                                                                                                                                                                                                                                             | FAKE executor only (harness reliability); real-model k-runs **not verified** |
| T3 adversarial   | yes      | `npm run attack-asr` (`--list` prints the attack list: entry × payload × variants, each with its target and success signature, standard §6); each payload ≥ 5 variants; CLAIMED rows gate at ASR 0, KNOWN rows (documented non-coverage) are reported; Sakk calls no model, so system-level ASR = model-level                                                                                                                                                                                                                                                                             | verified (deterministic)                                                     |
| T4 conversation  | no       | Sakk gates single calls; it holds no dialogue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | n/a                                                                          |
| T5 production    | not yet  | not deployed — `sakk status` exit codes and `sakk-alerts.jsonl` are the hooks a deployment would monitor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | not started                                                                  |
| T6 governance    | partly   | case packs map gold cases to CBUAE, DORA and DIFC themes (clause numbers unverified); mapping below; incident records in `specs/retro/` and `findings/`; an "AI-generated" disclosure policy does not apply — Sakk produces no content for publication                                                                                                                                                                                                                                                                                                                                    | partial                                                                      |

## Change levels (standard §5)

L1 = anything touching the ledger, policy kernel, MCP gate, secret
scanning, scorer/runner, case-pack verdicts or the evidence verifier — the
files listed as CORE in `test/core-specs.test.mjs`. L1 requires a
three-tables file in `specs/`, a drill anchor, the invariant fuzz and an
independent adversarial review before merge. L2 adds a design signed by
the maintainer before work starts.

## Thresholds

File: `eval/thresholds.json` (the audit reads it; tightening is free, loosening
needs a written reason there).

- Every suite green with **no skipped tests**, lint 0 warnings.
- Drill: every anchor killed by its named test; pristine control green.
- T3: CLAIMED ASR = 0 with ≥ 5 variants per payload.
- T2 (FAKE): pass^k = all cases, zero run-to-run verdict changes.
- L1 fuzz: 200 trials per module, zero invariant violations, PASS controls present.

## Reviews (standard principle 6: the judge is not the writer)

Code is written by Claude Opus 5.5. Independent adversarial reviews of L1
changes run on a different model (Claude Fable 5) from a fresh clone, with
no access to the author's reasoning. Earlier rounds on PRs #5–#8 used the
author's own model; that bias was not measured and is stated here.

First round on the other model (2026-10-16/17, all four plan 1–4 modules):
3 blockers and 17 should-fix items that three same-model rounds had
passed — evidence the self-preference bias was real. 3 + 14 fixed with a
test shown to fail on the old code; F-75 (scanner precision) and F-76
(scorer evidence from the agent's `.git`) open; review in
`findings/reviews/2026-10-17-independent-round.md`.

## Red lines

Each red line names the drill anchors that prove its guard can fail
(`test/core-specs.test.mjs` requires at least one per line).

| Red line                                           | Drill anchors       |
| -------------------------------------------------- | ------------------- |
| No spend after a halt                              | MUT-G, MUT-H, MUT-W |
| No reservation past the cap                        | MUT-X, MUT-Z        |
| No PASS from a FAKE run read as model evidence     | MUT-I, MUT-T, MUT-U |
| No secret printed in any output                    | MUT-Y               |
| No bundle reads PASS while its spend is unresolved | MUT-L               |

## Governance mapping (standard §10, thematic)

| Sakk evidence                                            | Regulation theme                                                        | Status                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------- |
| kill switch, approval gate, escalation cases (G05, G06)  | human oversight and stop (CBUAE AI guidance; EU AI Act human oversight) | thematic, clauses unverified |
| scoped-change and traceability cases, evidence bundles   | ICT change management and traceability (EU DORA)                        | thematic, clauses unverified |
| processing-boundary and injection cases, secret scanning | data processing boundaries (DIFC data protection)                       | thematic, clauses unverified |

## Findings and attribution (§14)

Ledger `findings/ledger.json` · gate `test/findings-ledger.test.mjs` ·
indicators `npm run findings-report` · stop-line reviews `findings/reviews/`.
Class detectors: `cli-strictness`, `claims-are-checked`, `hostile-names`,
`schema-pins`, `core-specs`, `bundle-absence` (all under `test/`), plus the
secret-scan context matrix and the ledger-write classification.

## Self-evolution (§15)

Before a change: `npm run brief -- <paths>` (also printed by `npm run gate`).
Every finding carries `areas`; every class-mechanism ref its `since`; an
escape past an existing detector records `mechanism_gap` and
`mechanism_upgrade`; `findings/prevention.json` holds the questions learned
from each class. All four are enforced by the self-evolution gate in
`test/findings-ledger.test.mjs`. Design: `docs/SELF_EVOLUTION.md`.

## Open items

- Real-model T2 / T3 runs: need approved gold labels and a model key.
- T5: starts at the first deployment.
- Proposal S-1 (a root-cause class "absence treated as success") awaits a decision.
