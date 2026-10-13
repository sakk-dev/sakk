# 真实运行说明（fail-closed · M1B 适配器已实现,放行仍封死）

**当前状态:真实执行仍结构性不可能。** 执行适配器已在 M1B 落地(见文末增量节),
但授权链要求 (a) 12 例 the maintainer 标签全部批准(现全空,标签闸必拒)且 (b) 仓库存在
`supervisor/eval/gold-v1/M0_CLOSURE_ATTESTATION.json` 且
`V6_M0_VERIFIED=YES ∧ M0_EXIT_GATE=PASS ∧ M0_STATUS=CLOSED`(现不存在,
M0 闸必拒)。两道闸都要 the maintainer/独立验收亲手解,Claude 不自解。

## 十道闸(任一不满足即拒,全部有自测覆盖或结构性保证)

1. `--authorization <path>` 未提供或文件缺失 → AUTHORIZATION_FILE_MISSING
2. JSON 不可解析 → AUTHORIZATION_MALFORMED
3. `approved !== true` → NOT_APPROVED
4. `allow_real_model !== true` → REAL_MODEL_NOT_ALLOWED
5. `approved_by` 空 → APPROVED_BY_EMPTY
6. `model_id` 空 → MODEL_ID_EMPTY
7. 预算字段缺失/非正数 → BUDGET_INVALID
8. 权威预算账本(V6_BUDGET_LEDGER_PATH 或默认路径)不可读 → AUTHORITATIVE_LEDGER_UNREADABLE
9. M0 书面闭环不可验证 → M0_CLOSURE_UNVERIFIABLE(当前必触发)
10. Gold Manifest 校验不过 / workdir 不在隔离 tmp → GOLD_MANIFEST_* / WORKROOT_NOT_ISOLATED_TMP

## the maintainer 授权流程(未来轮)

1. 完成并落盘 M0 独立验收 → 由验收方写 `M0_CLOSURE_ATTESTATION.json`
2. the maintainer 批准全部 12 例金标(见 `05_MAINTAINER_LABEL_REVIEW.md`)
3. 复制 `GOLD_RUN_AUTHORIZATION.example.json` → 真实授权文件,the maintainer 亲自填:
   `approved: true`、`allow_real_model: true`、`approved_by: "the maintainer"`、
   `model_provider/model_id`(模型由 the maintainer 选,Claude 不代选)、三个预算数字
4. 先 Pilot(`pilot_cases`: G01/G05/G10,上限 $6),the maintainer 看结果再决定全量($24)
5. 运行:

```bash
node supervisor/eval/gold-v1/bin/gold-runner.mjs --real --authorization <path>
```

- 每次付费调用经真实 budget-ledger 预留,`--max-budget-usd` 与预留同值同源
- 金标若有修改,先重算 manifest:

```bash
cd supervisor/eval/gold-v1/gold && find . -type f ! -name manifest.sha256 -print0 | xargs -0 shasum -a 256 | sed 's|  \./|  |' | sort -k2 > manifest.sha256
```

## 明令禁止(本轮已遵守,下一轮同样有效)

- Claude 不得代填授权文件、不得代选模型、不得自行扩预算
- fake-executor 结果不得对外表述为模型能力基线
- 真实运行结果在 the maintainer 标注批准前不得称 Gold Baseline

## M1B 增量:适配器已实现,闸门更多,全链仍封死

执行体不再是「刻意未实现」:`runRealCase` 已落地(独立临时 Git 工作区、
预留成功才 spawn、可注入 CLAUDE_BIN、捕获 argv/stdout/stderr/exit/timeout/起止、
runner 亲跑 verification、diff 由 runner 计算、声明只认结构化结果)。
**但本轮只用假 Claude recorder 验证过;真实模型调用次数=0。**

argv 形态(逐项对照本机 `claude --help` 2.1.251 实证):

```
claude -p --output-format json --model <model_id> --max-budget-usd <cap> <packet>
```

授权闸顺序(任一不过即拒):授权文件形态 → model_provider(仅 anthropic)/model_id
→ §四 范围绑定(选案 ⊆ pilot_case_ids;G12 这类 control_plane_only 不得当模型案例;
cap < 单例上限;Σcap < pilot 预算;full 预算不可替代)→ 权威账本可读 →
**the maintainer 标签闸(逐例五要素,GOLD_LABEL_NOT_APPROVED:<id>)** → gold manifest →
M0 书面闭环 → 隔离工作区。当前仓库:标签全空+无 M0 attestation,两道闸都必拒。

成本:只认 envelope.total_cost_usd;读不到 → 不伪造、预留挂账、账本进对账态、停批。

收尾契约:模型回复最后一行必须是
`{"final_claim":"PASS|FAIL|BLOCKED|ESCALATED","files_changed":[...]}`,
缺失按 FAIL(严格 JSON.parse,无正则猜测)。

## M1 收口补充:标签闸五要素升级为六要素

`maintainer-label.json` 校验新增 `case_sha256` 绑定(= 被批准那一刻 `cases/GXX.json`
的文件字节 SHA-256)。六项任一不满足 → `GOLD_LABEL_NOT_APPROVED:<case_id>`,
整批拒绝:approved===true、label 非空、labeled_by==="the maintainer"、labeled_at 合法时间、
case_id 与目录一致、case_sha256 与当前 Case 文件一致。
