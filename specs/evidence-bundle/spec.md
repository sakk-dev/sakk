# Evidence bundles — three tables + contract

Plan item ④, L1 (it vouches for cost and verdicts to a third party).
Written after implementation: the testing standard's audit found this L1
change had no three-tables file (finding F-53). Every guard names the test
that holds it; `test/core-specs.test.mjs` checks the names resolve.

## Table 1 — danger surface

| Surface    | Danger                                                | Guard (mechanism + test)                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spend      | A run with unsettled or unreconciled spend reads PASS | INCOMPLETE (exit 3) · `test/evidence-bundle.test.mjs::a RESERVED entry left open is unresolved spend too` (drill MUT-L)                                                                                         |
| Metrics    | Inflated metrics survive a regenerated manifest       | full recompute · `test/evidence-bundle.test.mjs::inflated pass rate in metrics.json → METRIC_MISMATCH` (drill MUT-M)                                                                                            |
| Parsing    | Falsy or duplicate-key JSON turns a check into a skip | object-or-named-problem, duplicate-key scan · `test/evidence-bundle.test.mjs::→ CASE_FILE_INVALID + METRICS_UNVERIFIABLE` (drill MUT-N)                                                                         |
| Self-trust | The bundled verifier vouches for itself               | shasum steps first; verifier must be committed · `test/evidence-bundle.test.mjs::the bundle README orders the independent checks BEFORE running verify.mjs`                                                     |
| Files      | Links or special files reach the auditor's disk       | regular files only · `test/evidence-bundle.test.mjs::a symlink in the run directory → BUNDLE_SOURCE_INVALID, nothing written`                                                                                   |
| Mode       | A FAKE run is relabelled REAL                         | provider, model id and labels cross-checked · `test/evidence-bundle.test.mjs::a FAKE bundle whose mode label claims a real baseline → MODE_MISMATCH`                                                            |
| Overspend  | A truthful overrun cannot be issued as evidence       | flagged overrun ⇒ INCOMPLETE · `test/evidence-bundle.test.mjs::an overrun past the case cap that sakk flagged is INCOMPLETE`                                                                                    |
| Absence    | Deleting one key turns a check into a skip (F-65)     | REAL names its model; every run states harness_dirty; closed pack report · `test/bundle-absence.test.mjs::every silently deletable key is declared, and every declaration is still needed` (drill MUT-U, MUT-V) |
| Harness    | A REAL run on a modified tree reads COVERED           | INCOMPLETE + HARNESS_MODIFIED · `test/evidence-bundle.test.mjs::a REAL run on a modified or uncheckable tree → INCOMPLETE (HARNESS_MODIFIED)`                                                                   |
| Downgrade  | An older genuine verifier is shipped and prints PASS  | the auditor runs the CURRENT verifier from a clone (README step 4) · `test/evidence-bundle.test.mjs::bundle.json and the README name the verifier commit`                                                       |

## Table 2 — failure modes

- Building: `BUNDLE_SOURCE_INVALID`, `BUNDLE_TARGET_EXISTS`, `BUNDLE_TARGET_INVALID`, `BUNDLE_VERIFIER_DIRTY`, `BUNDLE_VERIFIER_UNPINNED`, `BUNDLE_SELF_CHECK_FAILED`, `BUNDLE_WRITE_FAILED` — exit 2, nothing at the target.
- Verifying: PASS (0) · INCOMPLETE (3) · FAIL (1), each problem named. INCOMPLETE items: `SPEND_UNRESOLVED`, `SPEND_OVER_CAP`, `BATCH_STOPPED`, `CASES_NOT_RUN`, `HARNESS_MODIFIED`.
- Not covered by design: a full rebuild of every file passes `verify.mjs`; only the out-of-band fingerprint catches it (AUDITOR_REPLAY §6) — measured as a KNOWN row in `scripts/attack-asr.mjs`.

## Table 3 — audit questions

- Is this the bundle the issuer made? (fingerprint vs out-of-band value)
- Which run, commit, mode, model; did the tree match the commit; did it finish; is its spend final? (`bundle.json`, `metrics.json`, INCOMPLETE items)
- Do the verdicts, costs and metrics agree with each other? (verify.mjs)

## Contract

A bundle reads PASS only when every file is intact, every cross-file fact
agrees, and the run's results and spend are final.
