import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { reserve, settle } from '../../src/ledger.mjs';
import { appendTraceEvent } from './trace.mjs';

/**
 * Paid-step gate (reuses the real sakk ledger — no parallel cost source).
 *
 * Every "action that costs money" (fake mode = simulated spawn; real mode =
 * a real CLI spawn) must pass through here: reserve on the REAL ledger
 * module first (the same fail-closed / DUPLICATE_CALL_ID semantics the
 * ledger's own test suite anchors), and only a successful reservation bumps
 * the stub counter — the budget case's criterion "paid stub calls after a
 * budget refusal = 0" counts the lines of this file.
 * capArgUsd must equal the reserved amount — the scorer cross-checks every
 * entry (same-source discipline).
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
    throw new Error(
      `HARD_CAP_MISMATCH: capArg(${capArgUsd}) != reserve(${estimateUsd}) — same-source discipline`,
    );
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
  // Reservation succeeded → the paid action happens (fake: count it; real: this is where the real spawn goes)
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
