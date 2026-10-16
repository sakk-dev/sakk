# Testing profile: Sakk

- Standard: internal AI-agent testing standard v1.1 (layers T0–T6, §14
  root-cause attribution). The standard's text is not copied here; this
  file records only what is specific to Sakk.
- Phase: development (no production users yet; real-model runs are
  fail-closed behind approved gold labels).

## Where each layer lives

| Layer            | Sakk                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| T0 deterministic | `npm test`, `npm run test:eval`; mutation drill (`npm run drill`, 7 named mutants); invariant fuzz (`npm run fuzz`, `fuzz:policy`) |
| T1 judge         | the gold scorer is deterministic (no LLM judge); its falsifiability is the drill                                                   |
| T2 reliability   | gold runs with the fake executor are deterministic; k-run reliability needs real runs (pending)                                    |
| T3 adversarial   | independent adversarial review before every merge of a core area (R-05); campaign harnesses in `scripts/campaign/`                 |
| T4 conversation  | not applicable: Sakk gates single calls, it holds no dialogue                                                                      |
| T5 production    | `sakk status` exit codes and `sakk-alerts.jsonl`; no production deployment yet                                                     |
| T6 governance    | case packs (`eval/packs/`) map gold cases to CBUAE, DORA and DIFC themes — thematic, clause numbers unverified                     |

## Thresholds and red lines

- A gate is green only when every suite exits 0, the drill kills every
  mutant and the pristine control is green, and the certificate engine
  (`npm run certificate`) accepts.
- Red lines: no spend after a halt; no reservation past the cap; no PASS
  from a fake run read as model evidence; no secret printed in any output.

## Findings and attribution (§14)

- Ledger: `findings/ledger.json` (from 2026-10-16; earlier findings are in
  `specs/retro/` and the attribution logs in `docs/RULES.md`).
- Gate: `test/findings-ledger.test.mjs` — complete fields, valid
  classification against `findings/taxonomy.lock.yaml`, guards that
  resolve, a running detector for every class seen twice, a stop-line
  review for every class seen three times (`findings/reviews/`).
- Class detectors: `test/cli-strictness.test.mjs`,
  `test/claims-are-checked.test.mjs`, `test/hostile-names.test.mjs`,
  `test/schema-pins.test.mjs`.

## Open items

- Real-model reliability runs (T2) need the DeepSeek / Anthropic key as a
  repository secret and approved gold labels.
- Proposal S-1 (new root-cause class "absence treated as success") awaits a
  decision; see `findings/reviews/2026-10-16-stopline.md`.
