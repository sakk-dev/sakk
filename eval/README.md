# Sakk Gold Eval

A gold-case evaluation harness for AI agents acting as **executors**: does the
agent stay inside its permissions, spend inside its budget, and deliver real,
verifiable results? It does not measure product quality or model intelligence —
it measures discipline, with machine evidence only.

## What ships here

- ✅ 12 gold cases + a deterministic scorer + an isolating runner + a fully
  scripted fake-executor validation chain
- ✅ a minimal real-execution adapter, verified exclusively against a fake CLI
  recorder — **zero real-model calls are made by this repo's tests**
- ❌ no official baseline yet: gold labels are unapproved — each case's
  expected-behavior labels (`maintainer-label.json`, named for the project's human
  reviewer) await maintainer sign-off, and real-model metrics carry no
  authority until they have it. Real execution is fail-closed behind an
  authorization chain (see `06_REAL_RUN_INSTRUCTIONS.md`); a fresh checkout
  cannot run `--real`, by design.

## Directory map

| Path                                  | Contents                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `cases/G01..G12.json`                 | the 12 case definitions (agent-visible; no gold inside)                                |
| `fixtures/G01..G12/`                  | one synthetic micro-repo per case (no real data, no real secrets)                      |
| `gold/G01..G12/`                      | the answer key: scoring.json + notes.md + maintainer-label.json — never copied into a workdir |
| `gold/manifest.sha256`                | per-file SHA-256 inventory, verified at every runner start                             |
| `schemas/`                            | case / trace / result / metrics JSON Schemas (draft-07 subset)                         |
| `lib/`                                | validate / trace / paid-step gate / env scrub / scorer                                 |
| `bin/gold-runner.mjs`                 | the single entry point: `--validate` / `--dry-run` / `--fake-executor` / `--real`      |
| `fake/agents/`                        | scripted well-behaved agents (harness validation only)                                 |
| `examples/approval-gate.mjs`          | reference approval gate (injectable via `GOLD_GATE_MODULE`)                            |
| `__tests__/`                          | three self-test suites, including negative cases and gate sampling                     |
| `GOLD_RUN_AUTHORIZATION.example.json` | sample authorization file (`approved: false` on purpose)                               |

## Commands

```bash
node eval/bin/gold-runner.mjs --validate        # schema + gold manifest check
node eval/bin/gold-runner.mjs --dry-run         # per-case plan, zero execution
node eval/bin/gold-runner.mjs --fake-executor   # all 12 cases through the full chain, no models
npm run test:eval                               # harness self-tests
npm run drill                                   # mutation drill: prove the judge can fail
```

Execution modes need a **git clone**: every run records the harness commit as
provenance, so a ZIP/tarball download refuses with `HARNESS_GIT_REQUIRED`
(`--validate` and `--dry-run` still work without `.git`).

## Reuse over rebuild

Budgets go through the real sakk ledger (`src/ledger.mjs`) — same fail-closed
and `DUPLICATE_CALL_ID` semantics, no parallel cost source. The permission
case (G06) drives a real injectable approval gate. Real execution spawns one
headless CLI process per case — the "packet" is the task brief the runner
writes into the workdir (`PACKET.md`: task, allowed/forbidden paths, claim
rules) and passes as the prompt: `claude -p <packet> --max-budget-usd <cap>`,
binary injectable via `CLAUDE_BIN` (any CLI that accepts a prompt and emits
a JSON result envelope can sit behind it). There is no orchestration loop
and no session management.

## Document index

`00_EXECUTION_MODEL.md` (execution model and injection points) ·
`01_GOLD_CASE_CATALOG.md` (the 12 cases) · `02_SCORING_POLICY.md` (how
scoring works) · `03_COST_POLICY.md` (money discipline) ·
`04_FAILURE_TAXONOMY.md` (what each failure means) ·
`05_MAINTAINER_LABEL_REVIEW.md` (the reviewer label gate) ·
`06_REAL_RUN_INSTRUCTIONS.md` (real runs, fail-closed) ·
`07_MULTI_AGENT_TRAJECTORY_DESIGN.md` (design only)
