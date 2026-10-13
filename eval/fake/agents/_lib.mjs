import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendTraceEvent } from '../../lib/trace.mjs';
import { paidStep } from '../../lib/paid-step.mjs';

/**
 * Shared helpers for the fake agents (harness validation only).
 *
 * These scripts simulate a WELL-BEHAVED agent to exercise the
 * runner/scorer/isolation/budget chain — they are NOT a model baseline, and
 * any metrics they produce must be labeled FAKE_EXECUTOR. Bad behavior
 * (false PASS, unauthorized writes, leaks) is not simulated here: the
 * scorer's negative cases live in __tests__ as hand-built traces/workdirs.
 */

export const ctx = {
  workdir: process.env.GOLD_WORKDIR,
  trace: process.env.GOLD_TRACE,
  ledger: process.env.GOLD_LEDGER,
  counter: process.env.GOLD_COUNTER,
  caseDef: JSON.parse(process.env.GOLD_CASE ?? '{}'),
};

export function runCmd(cmd, { asTest = false } = {}) {
  const r = spawnSync('/bin/sh', ['-c', cmd], {
    cwd: ctx.workdir,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const exit = r.status ?? -1;
  appendTraceEvent(ctx.trace, (t) => {
    t.commands_executed.push({ cmd, exit });
    if (asTest) t.test_results.push({ source: 'executor', cmd, exit });
  });
  return { exit, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function readFile(rel) {
  return readFileSync(join(ctx.workdir, rel), 'utf8');
}

export function writeFile(rel, content) {
  const p = join(ctx.workdir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function editFile(rel, fn) {
  writeFile(rel, fn(readFile(rel)));
}

export function paid(callId, usd) {
  return paidStep({
    ledgerPath: ctx.ledger,
    traceFile: ctx.trace,
    counterFile: ctx.counter,
    callId,
    estimateUsd: usd,
    capArgUsd: usd,
    simulateActualUsd: usd,
  });
}

export function transition(to, extra = {}) {
  appendTraceEvent(ctx.trace, (t) =>
    t.state_transitions.push({ at: new Date().toISOString(), to, ...extra }),
  );
}

export function finish({ claim, files, evidence = [] }) {
  appendTraceEvent(ctx.trace, (t) => {
    t.final_claim = claim;
    t.files_changed = files;
    t.evidence_paths.push(...evidence);
    t.state_transitions.push({ at: new Date().toISOString(), to: claim });
  });
}
