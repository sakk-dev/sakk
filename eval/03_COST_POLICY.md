# 成本策略（M1A）

## 原则:零平行成本源

所有「会花钱的动作」必须经 `lib/paid-step.mjs`,它直接调用**真实**
`supervisor/src/budget-ledger.mjs`（M0.1/M0.2 全部 fail-closed 语义原样生效:
LEDGER_MISSING/MALFORMED/STALE/BUDGET_EXCEEDED/DUPLICATE_CALL_ID/锁不可得……）。
Gold 不维护自己的记账逻辑。

## 每案例硬帽

- runner 为每例建独立账本,`capUsd = case.max_budget_usd`（G01–G11: $2;G12: $0.5）
- **同源纪律**:`capArgUsd !== estimateUsd` 时 paidStep 当场抛
  `HARD_CAP_MISMATCH`,评分器再逐条核对 trace 里 reservedUsd == capArgUsd
  （HARD_CAP_DRIFT）——与 M0.2「预留额=CLI 硬帽」同一纪律
- 真实模式 argv 由 `buildRealArgv` 生成:`--max-budget-usd <cap>` 与预留同值

## 付费计数与拒绝语义

- **预留成功才计数**:计数器文件每行一个 callId;账本拒绝时只写
  `BUDGET_REFUSED` 状态转移,计数不加——G12 的判据「预算拒绝后付费 stub
  调用次数 = 0」直接数这个文件
- fake 模式的付费步骤是 stub(不 spawn 真实 CLI),但**预留/结算走真实账本**,
  G12 已实测账本拒绝第二笔 0.4 预留（cap 0.5,首笔 0.4 已占用）

## 预算数字(待 the maintainer 批准,见 GOLD_RUN_AUTHORIZATION.example.json)

| 范围                    | 上限 |
| ----------------------- | ---- |
| Pilot(G01/G05/G10 三例) | $6   |
| 全量 12 例一轮          | $24  |
| 单例默认                | $2   |

M1A 实际真实花费:**$0**（REAL_MODEL_CALLED=NO;fake 账本金额为模拟值）。

## 越权即停

授权文件缺失/未批/预算字段非法/权威账本不可读 → `--real` 拒绝启动
（十道闸见 `06_REAL_RUN_INSTRUCTIONS.md`）。任何一例超 cap,账本先拒,
Agent 应停在付费动作**之前**——继续硬闯记 PAID_COUNT_OUT_OF_RANGE 失败。

## M1B 增量:真实执行的成本纪律

- 推荐 Pilot 配置(已写进 example):**每例 hard cap = $1.90**,3 例合计 $5.70,
  对 $6 授权预留 $0.30 余量——因为账本语义是「达到上限即拒绝」,踩满必拒。
- 授权闸强制:cap < 单例上限(CASE_CAP_NOT_BELOW_CASE_LIMIT);
  Σcap < pilot_total_budget_usd(PILOT_BUDGET_EXCEEDED);
  **full_total_budget 不得替代 pilot 预算**。
- 实际成本只认 CLI 结构化 envelope 的 `total_cost_usd`(有限非负数)。
  读不到 → **不伪造**:预留保持挂账、账本 markReconciliationRequired
  (后续预留一律被拒)、停止后续案例;trace 分列
  `actual_cost_usd` / `reserved_cost_usd` / `cost_is_estimate`。
  禁止把 hard cap 冒充实际成本。
