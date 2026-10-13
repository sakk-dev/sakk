import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { reserve, settle } from '../../src/ledger.mjs';
import { appendTraceEvent } from './trace.mjs';

/**
 * 付费步骤门（Gold Eval M1A · 复用真实 budget-ledger,零平行成本源）。
 *
 * 任何「会花钱的动作」(fake 模式=模拟 spawn;real 模式=真 CLI spawn)都必须
 * 经过这里:先在**真实账本模块**上预留(同一套 fail-closed/DUPLICATE_CALL_ID
 * 语义,M0.1/M0.2 的全部测试就是它的地基),预留成功才把 stub 计数器 +1
 * ——G12 的判据「预算拒绝后付费 stub 调用次数=0」就数这个文件的行数。
 * capArgUsd 必须与预留额相等——评分器会逐条核对(与 M0.2 同源纪律)。
 */
export function paidStep({
  ledgerPath,
  traceFile,
  counterFile,
  callId,
  estimateUsd,
  capArgUsd,
  simulateActualUsd,
}) {
  if (capArgUsd !== estimateUsd) {
    throw new Error(`HARD_CAP_MISMATCH: capArg(${capArgUsd}) != reserve(${estimateUsd})——同源纪律`);
  }
  try {
    reserve({
      ledgerPath,
      callId,
      estimatedMaxUsd: estimateUsd,
      runId: 'gold',
      agentId: 'GOLD_EXECUTOR',
    });
  } catch (e) {
    appendTraceEvent(traceFile, (t) => {
      t.state_transitions.push({
        at: new Date().toISOString(),
        to: 'BUDGET_REFUSED',
        code: e.code ?? 'BUDGET_ERROR',
        callId,
      });
    });
    return { ok: false, code: e.code ?? 'BUDGET_ERROR' };
  }
  // 预留成功 → 付费动作发生(fake:计数;real:此处对应真实 spawn)
  appendFileSync(counterFile, `${callId}\n`);
  appendTraceEvent(traceFile, (t) => {
    t.tool_calls.push({
      at: new Date().toISOString(),
      kind: 'paid_step',
      callId,
      reservedUsd: estimateUsd,
      capArgUsd,
    });
    t.budget_reserved_usd += estimateUsd;
  });
  const actual = simulateActualUsd ?? estimateUsd;
  settle({ ledgerPath, callId, actualUsd: actual });
  appendTraceEvent(traceFile, (t) => {
    t.actual_cost_usd += actual;
  });
  return { ok: true };
}

export function paidCallCount(counterFile) {
  if (!existsSync(counterFile)) return 0;
  return readFileSync(counterFile, 'utf8').split('\n').filter(Boolean).length;
}
