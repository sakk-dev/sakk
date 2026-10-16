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

No clone needed. The bundle ships its own verifier (`verify.mjs`), which
is exactly why you check the bundle WITHOUT it first — a forged bundle can
ship a verifier that prints PASS. In this order:

```bash
tar -tzf bundle.tgz                         # one top-level sakk-evidence-<run>/ dir, no absolute or ../ paths
mkdir fresh && tar -xzf bundle.tgz -C fresh && cd fresh/sakk-evidence-*
shasum -a 256 MANIFEST.sha256               # = the fingerprint the issuer gave you SEPARATELY? if not: stop
shasum -a 256 -c MANIFEST.sha256            # every file, verify.mjs included, matches
node verify.mjs                             # only now
```

(`sha256sum` works the same on Linux.) Optionally compare `verify.mjs`
byte for byte with `eval/lib/bundle-verify.mjs` of the sakk version named
in `bundle.json`.

verify.mjs PASS means: only regular files, all matching the manifest; one
run, one harness commit, one executor mode (cross-checked against every
trace's provider); the case list equals the case directories; verdicts
agree with violations; each case's cost equals what its own ledger
settled; metrics.json recomputes from the per-case files (all metrics
except `trace_completeness_rate`, which is range-checked); the pack report
recomputes (a FAKE run can only read HARNESS_ONLY). Anything unreadable or
ill-typed is a named failure, never a skipped check.

It does NOT show who made the bundle: a full rebuild — verdicts edited, a
failing case dropped, metrics and manifest recomputed — passes verify.mjs.
Only the out-of-band fingerprint catches that. Nor does it re-judge
verdicts against the agent's workspace (see the boundary below). `run/`
holds raw logs that can contain whatever the agent printed, secrets
included — review before forwarding. Issuers build bundles with
`node scripts/evidence-bundle.mjs <out-dir> --to <file.tgz>`, which
refuses to write a bundle whose archive fails its own verifier.

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
