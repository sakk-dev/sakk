# Auditor replay — one page

What a third party can verify about Sakk **on their own clean machine,
without trusting the vendor**. Requirements: git, Node ≥ 20, macOS/Linux.
Time: under 30 minutes.

What "reproducible" means here, precisely: **the judgements reproduce; the
run bookkeeping does not.** Per-case verdicts, violation lists, pass/total
and every scoring-derived metric are identical for two auditors on two
machines at the same commit. Run-local fields — `runId`, `outDir`, wall-clock
durations (`p50_duration_ms`, `p95_duration_ms`), timestamps — differ by
construction. Canonical comparison, judgements only:

```bash
node eval/bin/gold-runner.mjs --fake-executor --out /tmp/replay-a
node -e "const m=require('/tmp/replay-a/metrics.json');delete m.runId;for(const k of ['p50_duration_ms','p95_duration_ms'])delete m.metrics[k];console.log(require('node:crypto').createHash('sha256').update(JSON.stringify(m)).digest('hex'))"
```

Two runs printing the same hash = the judge judged identically.

## 1. Pin what you are auditing

```bash
git clone https://github.com/sakk-dev/sakk && cd sakk
git rev-parse HEAD        # record this commit in your notes
```

A ZIP download refuses the execution steps (`HARNESS_GIT_REQUIRED`): every
run records the harness commit as provenance, and that is the point of the
exercise. (§2's schema check and `--dry-run` still work from a ZIP.)

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
budget ledger, machine-trace scoring) and prints where the evidence landed
(`outDir` in the summary line — that is the directory §5 reads). Verdicts
and scoring metrics reproduce as defined above. No network, no model, no
cost.

## 4. Judge the judge

```bash
npm run drill
```

The drill breaks exactly one scoring rule at a time in a disposable copy
and requires the suite to go red **by the named guardian test** — the one
specific test designated in advance to catch that mutation; the drill
output prints its name next to each `MUTANT KILLED` line, and a kill by any
_other_ test counts as a failure (`WRONG KILLER`). It then proves a
pristine copy stays green. A judge that cannot fail is not evidence; this
is the test of the test. (`npm run fuzz` additionally
replays seeded random attacks on the ledger's money invariants —
`SAKK_FUZZ_SEED=<n>` reproduces any reported seed exactly.)

Shortcut for the whole exercise: `npm run certificate` runs §2–§4 plus both
test suites end-to-end and renders the result as a one-page CERTIFICATE.md.
It is fail-closed by construction — any red gate, stale drill evidence, or
uncommitted tree refuses with a `CERT_*` code and emits nothing, so the
document's existence is itself the claim.

## 5. Read a run's evidence (if you were handed an out-dir)

Each case directory under an out-dir is runner-owned — the agent under test
never saw these paths. The first two exist for every case; the rest appear
only when the case exercises that surface, so their absence on an unrelated
case is normal, not missing evidence:

| File                | Present                                 | What to check                                                                |
| ------------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| `trace.json`        | always                                  | `claim_source` — a PASS must trace to machine evidence, never to self-report |
| `ledger.json`       | always                                  | reserve→settle pairs; totals against `metrics.json`                          |
| `test-runs.jsonl`   | when the case runs tests                | real exit codes behind any "tests pass" claim                                |
| `gate-probe.jsonl`  | when a paid step hits the approval gate | gate invocations for paid steps                                              |
| `sakk-alerts.jsonl` | when the ledger refused/halted          | greppable refusals/halts next to the ledger                                  |

The ledger file is plain JSON; `npx sakk status --ledger <file>` summarizes
it and exits 3 if the run ended in an unresolved reconciliation.

## 6. If you were handed an evidence bundle (.tgz)

No clone needed. Unpack it anywhere and run its own verifier:

```bash
tar -xzf sakk-evidence-*.tgz && cd sakk-evidence-* && node verify.mjs
```

PASS means every file matches the manifest and the files agree with each
other (verdicts vs violations, per-case cost vs per-case ledger, one run,
one harness commit, metrics and pack report recomputed). It does NOT prove
who made the bundle: compare the printed fingerprint with the one the
issuer gave you separately. Issuers build bundles with
`node scripts/evidence-bundle.mjs <out-dir> --to <file.tgz>`, which refuses
to write a bundle that fails its own verifier.

## Honest boundary (today)

Re-scoring a **specific historical run** — re-running the judge on that
run's workdir — still needs the harness at the recorded commit; a bundle
carries the judgements and their evidence, not the agent's workspace.
Authenticity of a bundle rests on the separately communicated fingerprint
until the hash-chained, externally anchored ledger ships. Fully
third-party-verifiable today: gold-set integrity (§2), deterministic verdict
reproduction (§3), the judge's falsifiability (§4), and a bundle's integrity
and internal consistency (§6). Claims beyond that should not be accepted —
by design, you don't have to.
