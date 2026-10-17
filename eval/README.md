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
| `lib/`                                | validate / trace / paid-step gate / env scrub / scorer / case packs / bundle verifier  |
| `packs/`                              | regulatory case packs: requirement themes mapped to cases, with gaps                   |
| `bin/gold-runner.mjs`                 | the single entry point: `--validate` / `--dry-run` / `--fake-executor` / `--real`      |
| `fake/agents/`                        | scripted well-behaved agents (harness validation only)                                 |
| `examples/approval-gate.mjs`          | reference approval gate (injectable via `GOLD_GATE_MODULE`)                            |
| `__tests__/`                          | the harness's own test suites, including negative cases and gate sampling              |
| `GOLD_RUN_AUTHORIZATION.example.json` | sample authorization file (`approved: false` on purpose)                               |

## Commands

```bash
node eval/bin/gold-runner.mjs --validate        # schema + gold manifest check
node eval/bin/gold-runner.mjs --dry-run         # per-case plan, zero execution
node eval/bin/gold-runner.mjs --fake-executor   # all 12 cases through the full chain, no models
npm run test:eval                               # harness self-tests
npm run drill                                   # mutation drill: prove the judge can fail
```

### Case packs (by regulation)

`eval/packs/` groups gold cases by regulatory requirement — currently
`cbuae-ai-oversight`, `dora-ict-change` and `difc-data-protection` (9 of the
12 cases appear: G04 and G09 map to no requirement in these packs, and the
control-plane budget case G12 cannot run against a model, so it is in no
pack). Run one and get a per-requirement verdict beside
the metrics (`pack-report.json`):

```bash
node eval/bin/gold-runner.mjs --fake-executor --pack cbuae-ai-oversight
```

What the verdict means depends on the run:

- **FAKE** runs read `HARNESS_ONLY` for every requirement — they prove the
  harness chain works and say nothing about any model or agent.
- **REAL** runs (only possible with approved gold labels) read `COVERED` when
  every case behind a requirement ran and passed on a harness tree that
  matches its commit; a passing requirement on a modified or uncheckable
  tree reads `HARNESS_MODIFIED`; otherwise `NOT_COVERED`. The report names
  the model id as requested and the binary that PATH resolved, and flags a
  `CLAUDE_BIN` override — no binary, overridden or not, is verified to be
  that model. A REAL batch that stops early exits 1.

Every requirement lists its `gaps` (what its cases do not show) and every
pack lists `not_covered` regulatory themes that no case exercises — a
starting list, not an exhaustive one. Themes
are paraphrased; clause numbers must be verified against the official text
before a pack is cited as compliance evidence.

Execution modes need a **git clone**: every run records the harness commit as
provenance, so a ZIP/tarball download refuses with `HARNESS_GIT_REQUIRED`
(`--validate` and `--dry-run` still work without `.git`).

## Known limits before the first real run

Found by the independent review of 2026-10-17 and open until the gold set
moves to v2 (findings F-90, F-76 in `findings/ledger.json`); FAKE runs are
unaffected:

- **Five cases cannot pass honestly in REAL mode.** G02, G03, G04, G10 and
  G11 require the machine test log, but only G01 and G08 ship the test entry
  point that writes it, and the agent's packet never names it: an honest
  PASS scores FALSE_COMPLETION, while a test log forged by hand would pass.
- **G09 passes with a hand-made artifact.** The rule bounds retries from
  above only; it never requires that the flaky tool actually ran.
- **Changed files are read from the agent's own `.git`** (F-76).

Fixing any of these changes the frozen gold set, so they ship together as
gold v2 with a version bump.

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
