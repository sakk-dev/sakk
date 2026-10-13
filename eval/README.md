# V6 Gold Eval M1A（最小版）

对 **V6 Supervisor 执行体系本身** 的金标评测框架。与 HostApp 产品 Eval（L0–L2、
escape 分类、`/evals` 看板）**完全分离**：这里评的是「Agent 作为执行者是否守规矩、
是否交付真实结果」,不评产品业务质量,两者不共享代码、数据或分数。

## 本轮（M1A）交付边界

- ✅ 框架 + 12 个 Gold Case + 确定性评分器 + 隔离 runner + fake-executor 全链验证
- ❌ 未调用任何真实模型;❌ 未产生正式 Gold Baseline;❌ Gold 标注未经 the maintainer 批准
- 真实执行被 **fail-closed** 十道闸拦死（见 `06_REAL_RUN_INSTRUCTIONS.md`）,
  当前仓库缺 `M0_CLOSURE_ATTESTATION.json`,`--real` 结构性不可能放行。

## 目录

| 路径                                  | 内容                                                               |
| ------------------------------------- | ------------------------------------------------------------------ |
| `00_CURRENT_EXECUTION_MAP.md`         | V6 付费执行入口与注入点的只读事实清单（复用依据）                  |
| `schemas/`                            | case / trace / result 三份 JSON Schema（draft-07 子集）            |
| `cases/G01..G12.json`                 | 12 个 Gold Case 定义（Agent 可见面无金标）                         |
| `fixtures/G01..G12/`                  | 各案例独立微型仓库素材（无真实数据、无真实密钥）                   |
| `gold/G01..G12/`                      | 金标（scoring.json + notes.md + maintainer-label.json,**不进 worktree**） |
| `gold/manifest.sha256`                | 金标逐文件 SHA-256 清单,runner 启动即校验                          |
| `lib/`                                | validate / trace / paid-step / scorer                              |
| `bin/gold-runner.mjs`                 | 唯一入口:--validate / --dry-run / --fake-executor / --real         |
| `fake/agents/`                        | fake 执行器（行为良好的模拟 Agent,框架验证专用）                   |
| `__tests__/gold-eval.test.mjs`        | §九 自测 16 条（含负例与 fail-closed 取样）                        |
| `GOLD_RUN_AUTHORIZATION.example.json` | 真实执行授权文件样例（approved=false）                             |

## 命令

```bash
node supervisor/eval/gold-v1/bin/gold-runner.mjs --validate        # schema+manifest 校验
node supervisor/eval/gold-v1/bin/gold-runner.mjs --dry-run         # 逐案例计划,不执行
node supervisor/eval/gold-v1/bin/gold-runner.mjs --fake-executor   # 12 例全链 fake 验证
node --test supervisor/eval/gold-v1/__tests__/gold-eval.test.mjs   # 框架自测
```

自测**不并入** `pnpm test:supervisor` 既有 glob,独立运行,避免与 M0 证据面混淆。

## 复用而非重建

预算走真实 `supervisor/src/budget-ledger.mjs`（同一套 fail-closed / DUPLICATE_CALL_ID /
同源硬帽纪律）;G06 直接驱动真实 `supervisor/src/pcr.mjs`;真实模式 argv 复用
controller-worker CLI 契约（`-p <packet> --max-budget-usd <cap>`）。没有平行编排器。

## 文档索引

`01_GOLD_CASE_CATALOG.md`（案例目录）· `02_SCORING_POLICY.md`（评分策略）·
`03_COST_POLICY.md`（成本策略）· `04_FAILURE_TAXONOMY.md`(失败分类)·
`05_MAINTAINER_LABEL_REVIEW.md`（the maintainer 标注评审包,未预填批准）·
`06_REAL_RUN_INSTRUCTIONS.md`（真实运行说明,fail-closed）

## M1A.1/M1B 增量(2026-10-01)

- 路径匹配边界收口(`matchPath`,变异 MUT-A 看守)
- G03/G06/G08 隐藏判据机器化;G12 标记 `execution_mode=control_plane_only` 并在
  指标中分账(control_plane_case_count / model_eligible_case_count)
- 真实运行新增:the maintainer 标签闸(逐例五要素)+ §四 授权范围绑定(pilot 范围/单例帽/
  合计帽/provider 白名单)
- 最小真实执行适配器 `runRealCase` 落地,**仅以假 Claude recorder 验证**
  (`__tests__/gold-m1b.test.mjs`);真实模型调用=0;全链放行仍被标签闸+M0 闸封死
- 多 Agent 轨迹仅设计:`07_MULTI_AGENT_TRAJECTORY_DESIGN.md`

## M1 技术收口增量(2026-10-01 第二刀)

- **指标假绿根除**:FAKE 模式下 `real_model_case_pass_rate` 恒为 null,并显式输出
  `executor_mode=FAKE / real_model_case_status=NOT_RUN / real_model_called=false /
fake_executor_case_pass_rate`;只有真实执行(REAL)才允许出现真实模型通过率数字。
  语义由 `schemas/metrics.schema.json` 固定,MUT-D 变异看守。
- **标签哈希绑定**:`maintainer-label.json` 新契约含 `case_sha256`(= `cases/GXX.json`
  文件字节 SHA-256);批准后 Case 内容被改动即哈希失配,批准自动失效。
  12 份空白模板已对齐闸契约字段。
- **路径纵深防线**:matchPath 对空串/绝对路径/`..`/`.`/双斜杠一律不命中任何规则,
  组合语义落点为 UNAUTHORIZED_WRITE(fail-closed);符号链接以落点路径受判。
- 新增自测:`__tests__/gold-m1-closeout.test.mjs`(12 条)。
