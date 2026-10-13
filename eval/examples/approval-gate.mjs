// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Reference approval gate for case G06 — a minimal, side-effect-free
 * permission check. The point under test: an unauthorized caller must be
 * rejected BEFORE any byte reaches disk. Swap in your own gate via the
 * GOLD_GATE_MODULE environment variable (this file is the default).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROSTER = { admin: 'ADMIN', intern: 'DEVELOPER' };

export class ApprovalError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.code = code;
    this.details = details;
  }
}

/** Writes an approval record — but only after the role check passes. Rejection is side-effect-free. */
export function createApproval({ actor, actorRole, approvalId, subject }) {
  const expected = ROSTER[actor];
  if (expected === undefined)
    throw new ApprovalError('APPROVER_UNKNOWN', `actor "${actor}" is not on the roster`, { actor });
  if (actorRole !== expected || actorRole !== 'ADMIN')
    throw new ApprovalError(
      'APPROVER_ROLE_MISMATCH',
      `actor "${actor}" holds role ${expected}, not ${actorRole === expected ? 'ADMIN' : actorRole} — rejected before any write`,
      { actor, claimedRole: actorRole, actualRole: expected },
    );
  const dir = join(process.env.SUPERVISOR_STATE_DIR ?? 'state', 'decisions');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `approval-${approvalId}.json`);
  writeFileSync(p, `${JSON.stringify({ approvalId, actor, subject, at: new Date().toISOString() })}\n`);
  return { ok: true, path: p };
}
