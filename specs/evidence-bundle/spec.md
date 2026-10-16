# Evidence bundles — three tables + contract

Plan item ④, L1 (it vouches for cost and verdicts to a third party).
Written after implementation: the testing standard's audit found this L1
change had no three-tables file (finding F-53). Every guard names the test
that holds it; `test/core-specs.test.mjs` checks the names resolve.

## Table 1 — danger surface

| Surface    | Danger                                                | Guard (mechanism + test)                                                                                                                                    |
| ---------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spend      | A run with unsettled or unreconciled spend reads PASS | INCOMPLETE (exit 3) · `test/evidence-bundle.test.mjs::a RESERVED entry left open is unresolved spend too` (drill MUT-L)                                     |
| Metrics    | Inflated metrics survive a regenerated manifest       | full recompute · `test/evidence-bundle.test.mjs::inflated pass rate in metrics.json → METRIC_MISMATCH` (drill MUT-M)                                        |
| Parsing    | Falsy or duplicate-key JSON turns a check into a skip | object-or-named-problem, duplicate-key scan · `test/evidence-bundle.test.mjs::→ CASE_FILE_INVALID + METRICS_UNVERIFIABLE` (drill MUT-N)                     |
| Self-trust | The bundled verifier vouches for itself               | shasum steps first; verifier must be committed · `test/evidence-bundle.test.mjs::the bundle README orders the independent checks BEFORE running verify.mjs` |
| Files      | Links or special files reach the auditor's disk       | regular files only · `test/evidence-bundle.test.mjs::a symlink in the run directory → BUNDLE_SOURCE_INVALID, nothing written`                               |
| Mode       | A FAKE run is relabelled REAL                         | provider, model id and labels cross-checked · `test/evidence-bundle.test.mjs::a FAKE bundle whose mode label claims a real baseline → MODE_MISMATCH`        |
| Overspend  | A truthful overrun cannot be issued as evidence       | flagged overrun ⇒ INCOMPLETE · `test/evidence-bundle.test.mjs::an overrun past the case cap that sakk flagged is INCOMPLETE`                                |

## Table 2 — failure modes

- Building: `BUNDLE_SOURCE_INVALID`, `BUNDLE_TARGET_EXISTS`, `BUNDLE_TARGET_INVALID`, `BUNDLE_VERIFIER_DIRTY`, `BUNDLE_VERIFIER_UNPINNED`, `BUNDLE_SELF_CHECK_FAILED`, `BUNDLE_WRITE_FAILED` — exit 2, nothing at the target.
- Verifying: PASS (0) · INCOMPLETE (3) · FAIL (1), each problem named.
- Not covered by design: a full rebuild of every file passes `verify.mjs`; only the out-of-band fingerprint catches it (AUDITOR_REPLAY §6) — measured as a KNOWN row in `scripts/attack-asr.mjs`.

## Table 3 — audit questions

- Is this the bundle the issuer made? (fingerprint vs out-of-band value)
- Which run, commit, mode, model; did it finish; is its spend final? (`bundle.json`, `metrics.json`, INCOMPLETE items)
- Do the verdicts, costs and metrics agree with each other? (verify.mjs)

## Contract

A bundle reads PASS only when every file is intact, every cross-file fact
agrees, and the run's results and spend are final.
