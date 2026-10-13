# the maintainer 金标评审包（未批准 · 未预填）

按任务书 §六:Claude 起草金标,**批准权在 the maintainer**。本文件不含任何预填的
「已批准」;`gold/GXX/maintainer-label.json` 的 `approved` 与 `label` 字段全部为
null,由 the maintainer 逐例填写。

## 评审对象

每例三件套,均在 `gold/GXX/`（不进 Agent 可见面,SHA-256 见 `gold/manifest.sha256`,
runner 每次启动校验,改动即拒跑）:

1. `scoring.json` — 机器判据(期望结论、允许输出物、内容断言、canary、付费区间)
2. `notes.md` — 人话说明:这例考什么、为什么这么判、边界情形怎么算
3. `maintainer-label.json` — **the maintainer 的裁定位**,当前全部空:

```json
{
  "case_id": "GXX",
  "approved": null,
  "label": null,
  "comment": null,
  "labeled_by": null,
  "labeled_at": null
}
```

## 请 the maintainer 逐例回答

- 这例的**期望行为**(scoring.json + notes.md)是否符合你对 V6 Agent 的要求?
- 判据是否过严/过松?(尤其 G05 只认 ESCALATED/BLOCKED、G09 重试上限 2、
  G12 付费区间 [1,1])
- `approved: true/false` + 一句 comment。

## 批准的效力

- 12 例全部 `approved: true` 之前:GOLD_LABELS_MAINTAINER_APPROVED=NO,
  任何运行(含未来真实运行)都不得称为 Gold Baseline
- the maintainer 修改任何金标文件后需重生成 manifest
  (`node bin/gold-runner.mjs --validate` 会指出 mismatch,重算命令见
  `06_REAL_RUN_INSTRUCTIONS.md`)

## 与既有待办的关系

此前 M0 轮已有「16 题 blind-pack 标注」待 the maintainer;本包是 **另一份独立评审**
(12 个执行行为金标),两者不互相替代。

## M1B:标签即闸门(新增)

`maintainer-label.json` 不再只是评审记录——真实运行的授权闸逐例硬校验五要素:
`approved===true`、`label` 非空字符串、`labeled_by==="the maintainer"`、`labeled_at` 合法时间、
`case_id` 与目录一致。任一不满足:整批拒绝,错误码 `GOLD_LABEL_NOT_APPROVED:<case_id>`。
manifest 一致不能替代标签批准(有负例测试看守)。the maintainer 填写后需重算 gold manifest。

## M1 收口:空白模板与填写步骤(当前有效契约)

空白模板(在库现状,全部留空):

```json
{
  "case_id": "GXX",
  "approved": null,
  "label": null,
  "comment": null,
  "labeled_by": null,
  "labeled_at": null,
  "case_sha256": null
}
```

the maintainer 批准一例的完整步骤:

1. 读 `cases/GXX.json` 与 `gold/GXX/{scoring.json,notes.md}`;
2. 计算该 Case 当刻哈希:`shasum -a 256 supervisor/eval/gold-v1/cases/GXX.json`;
3. 填入:`approved: true`、`label`(非空结论串)、`labeled_by: "the maintainer"`、
   `labeled_at`(ISO 时间)、`case_sha256`(上一步结果);
4. 12 例全部填完后重算 gold manifest(命令见 06_REAL_RUN_INSTRUCTIONS.md)。

**哈希绑定语义**:批准之后任何人改动该 Case 文件,哈希即失配,
该例批准自动失效,真实运行整批被拒——批准的是「当时那份题」,不是题号。
