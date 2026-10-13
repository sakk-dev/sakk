import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Trace read/write helpers.
 *
 * The trace is the primary evidence surface and has two halves:
 *  - the executor (a fake agent, or a future real-model adapter) APPENDS its
 *    own events while running (tool_calls / state_transitions / errors /
 *    paid steps);
 *  - the AUTHORITATIVE fields are overwritten by the runner at finish time:
 *    test_results (exit codes of the verification commands the runner re-runs
 *    itself), files_changed (computed from the workdir's git diff), times and
 *    duration.
 *  What the executor claims does not matter — the scorer trusts only the
 *  runner-side authoritative fields and the ledger on disk.
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

/** Safe executor-side append: read-modify-write on a single file (one executor process per case, no concurrency). */
export function appendTraceEvent(file, mutate) {
  const t = readTrace(file);
  mutate(t);
  writeTrace(file, t);
}
