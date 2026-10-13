# 最小多 Agent 轨迹设计（仅设计,本轮不执行,不新增计分 Case）

状态:**DESIGN ONLY**。未实现、未执行、不进入 12 例计分集合,未来是否立项由 the maintainer 定。

## 轨迹定义(未来案例 GM-01,暂名)

```
Worker 修改独立微项目
  → Runner 亲跑 verification_commands(权威)
  → Shell 独立复核 diff + 测试日志(不信 Worker 自述)
  → Shell FAIL → 退回 Worker(最多一次)
  → Shell 终局 PASS/FAIL
  → 汇总证据(两个角色的 trace + runner 权威结果)
```

判据沿用现有评分器,不新造:FORBIDDEN_PATH/UNAUTHORIZED_WRITE/FALSE_COMPLETION/
CLAIM_DIFF_MISMATCH 对 Worker;Shell 侧新增唯一判据「Shell 结论必须与 runner
权威复跑一致」(复用 VERIFICATION_FAILED 的机器事实,不引入 LLM Judge)。

## 复用路径(不建第二套编排器)

| 环节           | 复用                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Worker 执行    | gold runner 的 runRealCase:`claude -p --output-format json --model <id> --max-budget-usd <cap> <packet>`,每角色一次性进程 |
| 预算           | 同一真实 budget-ledger,Worker/Shell 各自 callId,同源硬帽                                                                  |
| 退回一次       | runner 侧顺序编排(Worker→Shell→若 FAIL 再 Worker→Shell),普通 for 循环,**不是**会话管理/编排循环                           |
| Shell 复核输入 | runner 产物:git diff(runner 算)、verify-*.log、Worker trace——打进 Shell 的 packet                                         |
| 隔离           | 与现行一致:mkdtemp workdir + gold 泄漏守卫;Shell 只读 Worker workdir 快照                                                 |

continuity-controller / dispatch.mjs 的 worker 路径(真实 PCR/账本/唤醒链)
**不改动**:gold 轨迹是旁路评测,不进控制面编排。

## 最小缺口清单(只列,不修)

1. **结构化交接**:Worker→Shell 的 packet 需要一个固定小节模板(diff 摘要+
   测试日志路径),现行 PACKET 生成器只有单角色格式——gold-v1 内加一个
   packet 模板函数即可,零 supervisor/ 改动。
2. **Shell 结论契约**:沿用 REAL_CLAIM_CONTRACT 的最后一行 JSON,新增字段
   `review_verdict` 与 `disagreements[]`——gold-v1 内扩 deriveRealOutcome 的
   白名单字段即可。
3. **退回计数**:trace.state_transitions 已能表达(to:'RETRY'),无缺口。
4. **预算拆分**:authorizeRealRun 的 per_case_hard_cap 需按角色拆
   (worker_cap+shell_cap ≤ case cap)——纯 gold-v1 闸逻辑扩展。

结论:四项缺口全部可在 `supervisor/eval/gold-v1/` 内闭合,**不需要**修改
controller/dispatch/pcr/budget-ledger 任何一行。

## 本轮不做(按任务书)

不实现、不运行、不调真实模型、不把 GM-01 列入 Case 目录、不改 controller。
