import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Trace 读写助手（Gold Eval M1A）。
 *
 * Trace 是评分的第一证据面,分两半:
 *  - 执行器(fake agent / 将来的真模型适配层)在运行中**追加**自己的事件
 *    (tool_calls/state_transitions/errors/paid 步骤);
 *  - **权威字段由 runner 收尾时覆写**:test_results(runner 亲自跑 verification
 *    commands 的退出码)、files_changed(workdir git diff 实算)、时间与时长。
 *  执行器声称什么不重要——评分器只信 runner 侧的权威字段与账本落盘。
 */

export function createTrace({ runId, caseId, gitCommit, provider, modelId, packetVersion }) {
  return {
    run_id: runId,
    case_id: caseId,
    git_commit: gitCommit,
    model_provider: provider,
    model_id: modelId ?? null,
    prompt_or_packet_version: packetVersion,
    started_at: new Date().toISOString(),
    ended_at: null,
    duration_ms: 0,
    tool_calls: [],
    state_transitions: [],
    files_changed: [],
    commands_executed: [],
    test_results: [],
    budget_reserved_usd: 0,
    actual_cost_usd: 0,
    final_claim: 'FAIL',
    evidence_paths: [],
    errors: [],
  };
}

export function readTrace(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeTrace(file, trace) {
  writeFileSync(file, `${JSON.stringify(trace, null, 1)}\n`);
}

/** 执行器侧的安全追加:读-改-写单文件(每 case 单执行器进程,无并发) */
export function appendTraceEvent(file, mutate) {
  const t = readTrace(file);
  mutate(t);
  writeTrace(file, t);
}
