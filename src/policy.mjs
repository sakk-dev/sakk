// SPDX-License-Identifier: AGPL-3.0-only
//
// Policy kernel (sakk-policy.v1) — the deterministic, auditable answer to
// "may this agent do this action at this cost?", decided BEFORE any
// reservation exists. Design signed 2026-10-15 (specs/policy-engine/):
//  - decide() is PURE: same policy bytes + same context → same verdict.
//  - This module never imports the ledger and never performs the action;
//    enforcement belongs to the enforcer (MCP server / hook / CI gate),
//    which calls reserve() only on an ALLOW.
//  - Every refusal carries a stable machine code (public API).

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { matchPath, matchesAny, prefixCovers } from './match.mjs';

export class PolicyError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.code = code;
    this.details = details;
  }
}

export const POLICY_SCHEMA = 'sakk-policy.v1';
const VERDICTS = ['allow', 'deny', 'require_approval'];
const RULE_KEYS = ['id', 'match', 'verdict', 'approvers_min'];
const MATCH_KEYS = ['agent', 'action', 'scope', 'max_estimated_usd'];

const isPlainObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
const isFiniteNonNeg = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

function bad(code, message, details) {
  throw new PolicyError(code, message, details);
}

function validatePolicyDoc(doc, policyPath) {
  const inv = (why, details = {}) =>
    bad('POLICY_SCHEMA_INVALID', `${why} (${policyPath})`, { policyPath, ...details });
  if (!isPlainObject(doc)) inv('policy root must be an object');
  for (const k of Object.keys(doc))
    if (!['schema', 'default_verdict', 'rules'].includes(k)) inv(`unknown top-level key "${k}"`);
  if (doc.schema !== POLICY_SCHEMA) inv(`schema must be "${POLICY_SCHEMA}"`, { got: doc.schema });
  if (!VERDICTS.includes(doc.default_verdict))
    inv(
      'default_verdict is mandatory: allow | deny | require_approval — there is no implicit default',
    );
  if (!Array.isArray(doc.rules)) inv('rules must be an array');
  const seen = new Set();
  doc.rules.forEach((r, i) => {
    if (!isPlainObject(r)) inv(`rules[${i}] must be an object`);
    for (const k of Object.keys(r))
      if (!RULE_KEYS.includes(k)) inv(`rules[${i}]: unknown key "${k}"`);
    if (typeof r.id !== 'string' || r.id === '') inv(`rules[${i}]: id must be a non-empty string`);
    if (seen.has(r.id)) inv(`duplicate rule id "${r.id}"`);
    seen.add(r.id);
    if (!VERDICTS.includes(r.verdict)) inv(`rule "${r.id}": unknown verdict`, { got: r.verdict });
    if (!isPlainObject(r.match)) inv(`rule "${r.id}": match must be an object`);
    for (const k of Object.keys(r.match))
      if (!MATCH_KEYS.includes(k)) inv(`rule "${r.id}": unknown match key "${k}"`);
    for (const f of ['agent', 'action'])
      if (f in r.match && (typeof r.match[f] !== 'string' || r.match[f] === ''))
        inv(`rule "${r.id}": match.${f} must be a non-empty string`);
    if ('scope' in r.match) {
      if (!Array.isArray(r.match.scope) || r.match.scope.length === 0)
        inv(`rule "${r.id}": match.scope must be a non-empty array of path prefix rules`);
      for (const s of r.match.scope)
        if (typeof s !== 'string' || s === '' || s.startsWith('/'))
          inv(`rule "${r.id}": scope entries are relative path prefix rules`, { got: s });
    }
    if (
      'max_estimated_usd' in r.match &&
      !(isFiniteNonNeg(r.match.max_estimated_usd) && r.match.max_estimated_usd > 0)
    )
      inv(`rule "${r.id}": max_estimated_usd must be a finite number > 0`);
    if ('approvers_min' in r) {
      if (r.verdict !== 'require_approval')
        inv(`rule "${r.id}": approvers_min only belongs on require_approval rules`);
      if (!Number.isInteger(r.approvers_min) || r.approvers_min < 1)
        inv(`rule "${r.id}": approvers_min must be an integer >= 1`);
    }
  });
  // R-04: a gate that can only say yes is not a gate.
  if (doc.rules.length === 0 && doc.default_verdict === 'allow')
    bad(
      'POLICY_VACUOUS_ALLOW',
      `empty rules with default allow can never refuse anything (${policyPath})`,
      { policyPath },
    );
}

/** Field-level coverage: does constraint of `a` accept every context that
 * `b`'s accepts? Only the decidable cases return true. */
function fieldCovers(a, b, field) {
  if (!(field in a.match)) return true; // absent = matches anything
  if ((field === 'agent' || field === 'action') && a.match[field] === '*') return true; // '*' too
  if (!(field in b.match)) return false; // a constrains, b does not
  if (field === 'agent' || field === 'action') return a.match[field] === b.match[field];
  if (field === 'scope')
    return b.match.scope.every((sb) => a.match.scope.some((sa) => prefixCovers(sa, sb)));
  if (field === 'max_estimated_usd') return a.match.max_estimated_usd >= b.match.max_estimated_usd;
  return false;
}

function findShadowedRule(rules) {
  for (let j = 1; j < rules.length; j++)
    for (let i = 0; i < j; i++)
      if (MATCH_KEYS.every((f) => fieldCovers(rules[i], rules[j], f)))
        return { by: rules[i].id, dead: rules[j].id };
  return null;
}

/**
 * Load, validate and hash a policy file. The hash is SHA-256 over the RAW
 * file bytes — what the auditor hashes is what decided.
 * Throws: POLICY_UNREADABLE | POLICY_SCHEMA_INVALID | POLICY_VACUOUS_ALLOW |
 *         POLICY_RULE_SHADOWED
 */
export function loadPolicy({ policyPath }) {
  if (typeof policyPath !== 'string' || policyPath === '')
    bad('POLICY_UNREADABLE', 'policyPath is required — policies are never implicit', {});
  let raw;
  try {
    raw = readFileSync(policyPath);
  } catch (e) {
    bad('POLICY_UNREADABLE', `cannot read policy file: ${e.code ?? e.message}`, { policyPath });
  }
  let doc;
  try {
    doc = JSON.parse(raw.toString('utf8'));
  } catch {
    bad('POLICY_UNREADABLE', `policy file is not valid JSON (${policyPath})`, { policyPath });
  }
  validatePolicyDoc(doc, policyPath);
  const shadowed = findShadowedRule(doc.rules);
  if (shadowed)
    bad(
      'POLICY_RULE_SHADOWED',
      `rule "${shadowed.dead}" can never fire — every context it matches is taken first by "${shadowed.by}"`,
      { policyPath, ...shadowed },
    );
  const policyHash = createHash('sha256').update(raw).digest('hex');
  return { policy: doc, policyHash };
}

function validateContext(context) {
  const inv = (why, details = {}) => bad('CONTEXT_INVALID', why, details);
  if (!isPlainObject(context)) inv('context must be an object');
  if (!isFiniteNonNeg(context.estimatedUsd))
    inv('context.estimatedUsd must be a finite number >= 0 — no coercion, ever', {
      got: context.estimatedUsd,
    });
  if (typeof context.callId !== 'string' || context.callId === '')
    inv('context.callId is required — an unattributable decision is unauditable');
  for (const f of ['agent', 'action', 'scope'])
    if (f in context && context[f] !== undefined && typeof context[f] !== 'string')
      inv(`context.${f} must be a string when present`, { field: f });
}

function ruleMatches(rule, context) {
  const m = rule.match;
  if ('agent' in m && m.agent !== '*' && m.agent !== context.agent) return false;
  if ('action' in m && m.action !== '*' && m.action !== context.action) return false;
  if ('scope' in m) {
    // a context without a scope cannot satisfy a scope-constrained rule
    if (typeof context.scope !== 'string') return false;
    if (!matchesAny(context.scope, m.scope)) return false;
  }
  // AT the limit matches (plain <=); the ledger's epsilon wall is the
  // ledger's own, independent concern.
  if ('max_estimated_usd' in m && !(context.estimatedUsd <= m.max_estimated_usd)) return false;
  return true;
}

/**
 * PURE decision: no I/O, no clock, no randomness. First match wins, top to
 * bottom; no rule matched → the mandatory default verdict with ruleId null.
 * Throws: CONTEXT_INVALID
 */
export function decide({ policy, policyHash, context }) {
  validateContext(context);
  // The decision carries a whitelist COPY of the context, never the caller's
  // reference: mutating the context after decide() must not be able to make
  // the logged context differ from the judged one (audit-lie surface), and
  // extra fields cannot be smuggled into the decision log.
  const judged = {
    agent: context.agent,
    action: context.action,
    scope: context.scope,
    estimatedUsd: context.estimatedUsd,
    callId: context.callId,
  };
  for (const rule of policy.rules) {
    if (ruleMatches(rule, judged)) {
      const d = { verdict: rule.verdict, ruleId: rule.id, policyHash, context: judged };
      if (rule.verdict === 'require_approval') d.approversMin = rule.approvers_min ?? 1;
      return d;
    }
  }
  return { verdict: policy.default_verdict, ruleId: null, policyHash, context: judged };
}

/**
 * Append one decision to the JSONL log. An unauditable allow is a deny:
 * any failure here throws DECISION_UNLOGGABLE and the enforcer must refuse
 * the action.
 */
export function logDecision({ decisionLogPath, decision, by }) {
  if (
    typeof decisionLogPath !== 'string' ||
    decisionLogPath === '' ||
    !isPlainObject(decision) ||
    !VERDICTS.includes(decision.verdict) ||
    typeof decision.policyHash !== 'string'
  )
    bad(
      'DECISION_UNLOGGABLE',
      'a decision without a verdict, hash and log path cannot be audited',
      {
        decisionLogPath,
      },
    );
  const line = `${JSON.stringify({
    at: new Date().toISOString(),
    by: typeof by === 'string' && by !== '' ? by : null,
    verdict: decision.verdict,
    ruleId: decision.ruleId ?? null,
    ...(decision.approversMin !== undefined ? { approversMin: decision.approversMin } : {}),
    policyHash: decision.policyHash,
    context: decision.context ?? null,
  })}\n`;
  try {
    appendFileSync(decisionLogPath, line);
  } catch (e) {
    bad('DECISION_UNLOGGABLE', `decision log write failed: ${e.code ?? e.message}`, {
      decisionLogPath,
    });
  }
}

export { matchPath };
