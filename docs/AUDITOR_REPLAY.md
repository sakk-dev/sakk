# Auditor replay — one page

What a third party can verify about Sakk **on their own clean machine,
without trusting the vendor**. Requirements: git, Node ≥ 20, macOS/Linux.
Time: under 30 minutes. Every step is deterministic; two auditors on two
machines get byte-identical verdicts.

## 1. Pin what you are auditing

```bash
git clone https://github.com/sakk-dev/sakk && cd sakk
git rev-parse HEAD        # record this commit in your notes
```

A ZIP download refuses execution (`HARNESS_GIT_REQUIRED`): every run records
the harness commit as provenance, and that is the point of the exercise.

## 2. Verify the gold set is intact

```bash
node eval/bin/gold-runner.mjs --validate
```

Recomputes the SHA-256 manifest over every gold file and checks all 12 case
schemas. Any tampered or missing expectation file fails here, before
anything runs.

## 3. Reproduce the verdicts — zero models, zero spend

```bash
node eval/bin/gold-runner.mjs --fake-executor
```

Runs all 12 behavioral cases through the full chain (isolated git workdir,
budget ledger, machine-trace scoring). The verdict per case and the final
JSON metrics line reproduce deterministically. No network, no model, no
cost.

## 4. Judge the judge

```bash
npm run drill
```

The drill breaks exactly one scoring rule at a time in a disposable copy
and requires the suite to go red **by the named guardian test**, then
proves a pristine copy stays green. A judge that cannot fail is not
evidence; this is the test of the test. (`npm run fuzz` additionally
replays seeded random attacks on the ledger's money invariants —
`SAKK_FUZZ_SEED=<n>` reproduces any reported seed exactly.)

## 5. Read a run's evidence (if you were handed an out-dir)

Each case directory under an out-dir is runner-owned — the agent under test
never saw these paths:

| File                | What to check                                                                 |
| ------------------- | ----------------------------------------------------------------------------- |
| `trace.json`        | `claim_source` — a PASS must trace to machine evidence, never to self-report |
| `ledger.json`       | reserve→settle pairs; totals against `metrics.json`                           |
| `test-runs.jsonl`   | real exit codes behind any "tests pass" claim                                 |
| `gate-probe.jsonl`  | approval-gate invocations for paid steps                                      |
| `sakk-alerts.jsonl` | greppable refusals/halts next to the ledger                                   |

The ledger file is plain JSON; `npx sakk status --ledger <file>` summarizes
it and exits 3 if the run ended in an unresolved reconciliation.

## Honest boundary (today)

Re-scoring a **specific historical run** from a portable evidence pack is on
the roadmap ("evidence packs"), not shipped: scoring consumes the live git
workdir, which is not yet bundled. What ships today and is fully
third-party-verifiable: gold-set integrity (§2), deterministic verdict
reproduction (§3), and the judge's own falsifiability (§4). Claims beyond
that should not be accepted — by design, you don't have to.
