# Testing profile: Sakk

- **Standard:** internal AI-agent testing standard **v1.1** (layers T0–T6,
  change levels L0–L2, §14 root-cause attribution). The standard's text is
  not copied here; this file records only what is specific to Sakk.
- **Phase:** development → pre-release. Real-model runs are fail-closed
  behind approved gold labels and a model key (not yet provided).
- **One command:** `npm run audit` runs every applicable layer below, takes
  each exit code directly, writes logs to `audit-logs/<stamp>/` and a
  `SUMMARY.md`; any red step makes the audit red.

## Layers

| Layer            | Applies? | How Sakk meets it                                                                                                                                                                                                                                                                                                                        | Status                                                                       |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| T0 deterministic | yes      | `npm test` + `npm run test:eval` (exit codes direct); every refusal code asserted by a test (`test/claims-are-checked.test.mjs`); mutation drill, one anchor per core guard (`npm run drill`, 18 anchors; `test/core-specs.test.mjs` requires an anchor per core file); invariant fuzz (`npm run fuzz`, `fuzz:policy`); secret self-scan | verified                                                                     |
| T1 judge         | no       | Sakk has no model judge: the gold scorer is deterministic code, and its ability to fail is proven by the drill                                                                                                                                                                                                                           | n/a                                                                          |
| T2 reliability   | partly   | `npm run golden-k` — every gold case k = 3, pass@1 with Wilson 95% interval, pass^k, run-to-run stability                                                                                                                                                                                                                                | FAKE executor only (harness reliability); real-model k-runs **not verified** |
| T3 adversarial   | yes      | `npm run attack-asr` — attack list over the external inputs of the kill switch, secret scanning, case packs and evidence bundles; each payload ≥ 5 variants; CLAIMED rows gate at ASR 0, KNOWN rows (documented non-coverage) are reported; Sakk calls no model, so system-level ASR = model-level                                       | verified (deterministic)                                                     |
| T4 conversation  | no       | Sakk gates single calls; it holds no dialogue                                                                                                                                                                                                                                                                                            | n/a                                                                          |
| T5 production    | not yet  | not deployed — `sakk status` exit codes and `sakk-alerts.jsonl` are the hooks a deployment would monitor                                                                                                                                                                                                                                 | not started                                                                  |
| T6 governance    | partly   | case packs map gold cases to CBUAE, DORA and DIFC themes (clause numbers unverified); mapping below; incident records in `specs/retro/`                                                                                                                                                                                                  | partial                                                                      |

## Change levels (standard §5)

L1 = anything touching the ledger, policy kernel, MCP gate, secret
scanning, scorer/runner, case-pack verdicts or the evidence verifier — the
files listed as CORE in `test/core-specs.test.mjs`. L1 requires a
three-tables file in `specs/`, a drill anchor, the invariant fuzz and an
independent adversarial review before merge. L2 adds a design signed by
the maintainer before work starts.

## Thresholds

- Every suite green with **no skipped tests** (the certificate refuses a skip).
- Drill: every anchor killed by its named test; pristine control green.
- T3: CLAIMED ASR = 0 with ≥ 5 variants per payload.
- T2 (FAKE): pass^k = all cases, zero run-to-run verdict changes.

## Red lines

No spend after a halt; no reservation past the cap; no PASS from a FAKE run
read as model evidence; no secret printed in any output; no bundle reads
PASS while its spend is unresolved.

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
`schema-pins`, `core-specs` (all under `test/`).

## Open items

- Real-model T2 / T3 runs: need approved gold labels and a model key.
- T5: starts at the first deployment.
- Proposal S-1 (a root-cause class "absence treated as success") awaits a decision.
