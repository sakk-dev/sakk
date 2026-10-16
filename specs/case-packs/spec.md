# Case packs by regulation — three tables + contract

Plan item ①, L1 (it changes what an evaluation report claims). Written after
implementation: the testing standard's audit found this L1 change had no
three-tables file (finding F-53). Every guard below names the test that
holds it; `test/core-specs.test.mjs` checks the names resolve.

## Table 1 — danger surface

| Surface           | Danger                                                                  | Guard (mechanism + test)                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Report status     | A FAKE run reads COVERED — harness proof sold as compliance evidence    | FAKE/unknown mode ⇒ HARNESS_ONLY · `eval/__tests__/case-packs.test.mjs::FAKE mode → HARNESS_ONLY for every requirement, even when every case passed` (drill MUT-I) |
| Report status     | A mis-cased or object mode slips past the REAL check                    | exact `'REAL'` only · `eval/__tests__/case-packs.test.mjs::an unknown or mis-cased mode never reads COVERED`                                                       |
| Pack content      | A requirement claims more than its cases show                           | mandatory `gaps` / `not_covered` · `eval/__tests__/case-packs.test.mjs::missing not_covered, or a requirement without gaps, is invalid`                            |
| Pack content      | A pack holds cases a real run refuses, so it can never produce evidence | allowlist `execution_mode: "model"` · `eval/__tests__/case-packs.test.mjs::control: the fixture reaches the case-type gate`                                        |
| Runner CLI        | A misspelled selector silently runs every case                          | strict argv · `eval/__tests__/case-packs.test.mjs::a misspelled selector exits 2 instead of running every case`                                                    |
| Report provenance | A REAL report hides which binary ran, or that the tree was dirty        | `model`, `harness_dirty` · `eval/__tests__/case-packs.test.mjs::harness_dirty: false on a clean tree, true after an eval/ or src/ change`                          |
| Exit code         | A stopped REAL batch exits 0                                            | `realExitCode` · `eval/__tests__/case-packs.test.mjs::review N-2: a REAL batch that stopped early is never exit 0`                                                 |

## Table 2 — failure modes

- Broken pack file → `PACK_INVALID` naming every broken file; `--validate` exits 1 (`packs_ok: false`).
- Unknown pack id → `PACK_UNKNOWN`, exit 2; nothing runs.
- A case fails or never runs → `NOT_COVERED` with `NOT_RUN`/`FAIL` per case.
- A REAL batch stops (unknown cost, budget) → `batch_stopped` in the report, exit 1.

## Table 3 — audit questions the artifacts answer

- Which run, which harness commit, which executor mode, which model and binary produced this verdict? (`pack-report.json`)
- Which cases back each requirement, and what do they not show? (`requirements[].cases`, `gaps`, `not_covered`)
- Did the batch finish? (`batch_stopped`, exit code)

## Contract

A pack report never reads COVERED unless a REAL run executed every backing
case and each passed; its limits travel with it.
