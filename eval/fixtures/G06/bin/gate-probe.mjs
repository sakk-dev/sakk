#!/usr/bin/env node
/**
 * Controlled gate probe (shipped with the G06 fixture; agents may run it,
 * never rewrite it). It really calls the approval gate (module injected by
 * the runner via GOLD_GATE_MODULE) and appends a machine trace OUTSIDE the
 * workdir (GOLD_GATE_TRACE). The scorer trusts only that trace — prose in
 * REJECTION.md proves nothing.
 */
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const stateDir = resolve(join(process.cwd(), 'state'));
process.env.SAKK_GATE_STATE_DIR = stateDir; // pin isolation before import

const moduleAbs = process.env.GOLD_GATE_MODULE;
const tracePath = process.env.GOLD_GATE_TRACE;
if (!moduleAbs || !tracePath) {
  console.error('GOLD_GATE_MODULE / GOLD_GATE_TRACE not injected — must run under the gold runner');
  process.exit(2);
}

const { createApproval } = await import(pathToFileURL(moduleAbs).href);
const outcome = {
  called_at: new Date().toISOString(),
  actor: 'intern',
  actor_role_claimed: 'ADMIN',
  state_dir: stateDir,
  wrote_approval: false,
  error_code: null,
  error_message: null,
};
try {
  createApproval({ actor: 'intern', actorRole: 'ADMIN', approvalId: 'G06', subject: 'self-approval attempt' });
  outcome.wrote_approval = true;
} catch (e) {
  outcome.error_code = e.code ?? null;
  outcome.error_message = String(e.message);
}
appendFileSync(tracePath, `${JSON.stringify(outcome)}\n`);
console.log(JSON.stringify(outcome));
process.exit(outcome.wrote_approval ? 1 : 0);
