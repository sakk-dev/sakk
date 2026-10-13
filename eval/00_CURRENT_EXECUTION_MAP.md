# 00 · V6 真实执行入口与注入点(只读核查,2026-09-30 @ d76122b)

## 执行入口(六个,全部已过 M0.2 预算闸)

| 入口                               | 文件:行                                                                                         | 付费形态            | 预算闸                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------- | --------------------------- |
| controller worker                  | bin/continuity-controller.mjs:253 附近 spawnSync(CLAUDE_BIN,'-p'…'--max-budget-usd',WORKER_MAX) | Claude CLI headless | reservePaidCall(worker $25) |
| controller Shell                   | 同文件 :344 附近('--max-budget-usd',SHELL_MAX)                                                  | Claude CLI headless | reservePaidCall(shell $10)  |
| dispatch create(superctl 唤醒经此) | src/dispatch.mjs createSession→session-bootstrap.buildCreateArgv(含 cap)                        | Claude CLI 会话创建 | defaultDispatchBudgetGuard  |
| dispatch resume                    | src/dispatch.mjs:839 spawnImpl(bin,['-p','--resume',…,'--max-budget-usd',cap])                  | Claude CLI resume   | 同上                        |
| wakeChief resume                   | src/wake.mjs:139 spawn(bin,['-p','--resume',…,'--max-budget-usd',WAKE_MAX])                     | Claude CLI resume   | reserve(CHIEF $25)    |
| usage probe                        | src/usage.mjs probeAvailability(execImpl)                                                       | Claude CLI 最短探针 | reserve($0.10)        |

权限入口:src/pcr.mjs createPcr——assertPcrAuthority 在任何副作用之前验权(M0/F6)。
成本真源:src/budget-ledger.mjs——唯一账本,fail-closed 全谱+DUPLICATE_CALL_ID(M0.2)。

## 注入点(Gold runner 复用,零平行编排器)

| 注入                                                            | 证据                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| SUPERVISOR_STATE_DIR                                            | paths.mjs:61 起(测试隔离契约;pcr/dispatch/wake 状态全走它)                              |
| V6_BUDGET_LEDGER_PATH                                           | budget-ledger.mjs:53(defaultLedgerPath)                                                 |
| CLAUDE_BIN                                                      | continuity-controller.mjs:99(worker 二进制解析)                                         |
| SUPERVISOR_WAKE_CMD                                             | dispatch.mjs:839 / wake.mjs:139                                                         |
| execImpl(usage) / spawnImpl+budgetGuard+createSession(dispatch) | usage.mjs:22 / dispatch.mjs:567,601 附近                                                |
| 临时 worktree/fixture                                           | 既有测试三处范式:mkdtemp 合成仓(characterization)/pid 隔离(paths)/recorder stub(gating) |

## Gold runner 的复用决策

- **预算**:直接 import 现有 `budget-ledger.mjs`(reserve/settle/DUPLICATE_CALL_ID),per-case 账本经 V6_BUDGET_LEDGER_PATH 指到 case 隔离目录——不另造成本源。
- **权限案例(G06)**:直接驱动真实 `pcr.mjs`(SUPERVISOR_STATE_DIR 指 case 工作目录)。
- **真实执行形态**:与 controller worker 同款 `claude -p <packet> --max-budget-usd <cap>` CLI 契约(经 CLAUDE_BIN 解析);M1A 仅构造 argv 并 fail-closed,不执行。
- **不新建**:编排循环/重试策略/会话管理一概不建——每 case 一次性进程,与 controller worker 的 disposable 模型一致。
