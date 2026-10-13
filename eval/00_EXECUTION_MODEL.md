# 00 · Execution model and injection points

How the harness runs things, and every seam where a deployment can inject its
own implementation. The design rule throughout: **reuse over rebuild** — the
harness owns no orchestration loop, no retry policy, and no session
management. Each case is one disposable process in one disposable directory.

## Per-case lifecycle

1. `mkdtemp` an isolated workdir; copy the case's fixture in.
2. Guard against gold leakage: if any `gold/<case>/` file name exists in the
   workdir, the runner throws (`GOLD_LEAK_INTO_WORKDIR`).
3. Write `PACKET.md` (the task brief) and commit fixture+packet as the git
   baseline — the agent's diff is everything after this commit.
4. Create a per-case ledger (`capUsd = case.max_budget_usd`) and a trace
   skeleton. Machine logs (trace, gate probe, test log) live **outside** the
   workdir, owned by the runner.
5. Execute: fake mode spawns the scripted agent; real mode goes through the
   authorization chain, reserves on the ledger, then spawns the CLI once.
6. The runner re-runs every `verification_command` itself and overwrites the
   authoritative trace fields (test results, files changed, timing).
7. The scorer grades from machine facts; results land in the out-dir.

## Injection points

| Seam             | Env / parameter                                                              | Used for                                                        |
| ---------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Executor binary  | `CLAUDE_BIN`                                                                 | real mode; tests inject a fake recorder                         |
| Approval gate    | `GOLD_GATE_MODULE` (module path)                                             | G06; default `eval/examples/approval-gate.mjs`                  |
| Gate probe trace | `GOLD_GATE_TRACE` (file path)                                                | machine record of real gate calls, outside the workdir          |
| Test log         | `GOLD_TEST_LOG` (file path)                                                  | fixture test entry points append `{ts, exit}` lines             |
| Org ledger       | `SAKK_BUDGET_LEDGER_PATH`                                                    | the authoritative ledger the real-run gate must be able to read |
| Case context     | `GOLD_WORKDIR` / `GOLD_TRACE` / `GOLD_LEDGER` / `GOLD_COUNTER` / `GOLD_CASE` | injected into every executor process                            |

## Environment scrub

Every spawn goes through `lib/exec-env.mjs`, which strips
`NODE_TEST_CONTEXT`: under an outer `node --test`, a child `node --test` run
exits 0 even when its tests fail — a false-green channel for any scorer that
trusts exit codes. Empirically confirmed; regression-tested.

## Paid-action gate

Every action that costs money passes `lib/paid-step.mjs`: reserve on the real
ledger first; only a successful reservation increments the paid counter; the
cap argument must equal the reserved amount (`HARD_CAP_MISMATCH` otherwise).
The budget case (G12) is scored by counting that file's lines.
