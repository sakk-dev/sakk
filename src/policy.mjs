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
import { readFileSync, statSync } from 'node:fs';
import { appendNoFollow } from './append.mjs';
import { matchPath, matchesAny, prefixCovers, isCanonicalRelPath } from './match.mjs';

// eslint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export class PolicyError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.code = code;
    this.details = details;
  }
}

export const POLICY_SCHEMA = 'sakk-policy.v1';
export const MAX_POLICY_BYTES = 4 * 1024 * 1024; // above the work-budget attacks (25k rules ≈ 1.6 MB), which refuse by budget
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
    // ids and names reach refusal messages and terminals (review N4)
    if (CONTROL.test(r.id)) inv(`rules[${i}]: id contains control characters`);
    if (seen.has(r.id)) inv(`duplicate rule id "${r.id}"`);
    seen.add(r.id);
    if (!VERDICTS.includes(r.verdict)) inv(`rule "${r.id}": unknown verdict`, { got: r.verdict });
    if (!isPlainObject(r.match)) inv(`rule "${r.id}": match must be an object`);
    for (const k of Object.keys(r.match))
      if (!MATCH_KEYS.includes(k)) inv(`rule "${r.id}": unknown match key "${k}"`);
    for (const f of ['agent', 'action']) {
      if (f in r.match && (typeof r.match[f] !== 'string' || r.match[f] === ''))
        inv(`rule "${r.id}": match.${f} must be a non-empty string`);
      // review S3: F10's no-globs rule held for scope only — a 'ci-*' deny
      // was a literal that never fired. Only the exact '*' is a wildcard.
      if (f in r.match && r.match[f] !== '*' && /[*?[\]]/.test(r.match[f]))
        inv(
          `rule "${r.id}": match.${f} "${r.match[f]}" is not a glob — only the exact "*" is a wildcard, so this rule would never match`,
          { got: r.match[f] },
        );
      if (f in r.match && CONTROL.test(r.match[f]))
        inv(`rule "${r.id}": match.${f} contains control characters`);
    }
    if ('scope' in r.match) {
      if (!Array.isArray(r.match.scope) || r.match.scope.length === 0)
        inv(`rule "${r.id}": match.scope must be a non-empty array of path prefix rules`);
      for (const s of r.match.scope) {
        if (typeof s !== 'string' || s === '' || s.startsWith('/'))
          inv(`rule "${r.id}": scope entries are relative path prefix rules`, { got: s });
        // Review finding N2 (verify pass): ANY entry the matcher can never
        // satisfy is a silent dead rule — 'docs//x', './docs', 'a/../b'
        // fail-closed on the context side (F2), so as RULE entries they
        // could only ever disable a deny. Refuse the whole family.
        const dirBase = s.endsWith('/') ? s.slice(0, -1) : s;
        if (!isCanonicalRelPath(dirBase))
          inv(
            `rule "${r.id}": scope entry "${s}" is non-canonical and can never match any valid context`,
            { got: s },
          );
        // Review finding F10: prefix semantics have no wildcards — a 'prod/**'
        // entry would be a dead rule that silently never fires.
        if (s.includes('*'))
          inv(
            `rule "${r.id}": scope entries are prefix rules, not globs — "${s}" would never match anything`,
            { got: s },
          );
      }
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
  // R-04: a gate that can only say yes is not a gate — empty or not
  // (review S4: rules that are all allow, or a first rule that allows
  // everything, loaded although the README promised this refusal).
  const unconditional = (r) =>
    Object.entries(r.match).every(([k, v]) => (k === 'agent' || k === 'action') && v === '*');
  if (
    (doc.default_verdict === 'allow' && doc.rules.every((r) => r.verdict === 'allow')) ||
    (doc.rules.length > 0 && doc.rules[0].verdict === 'allow' && unconditional(doc.rules[0]))
  )
    bad(
      'POLICY_VACUOUS_ALLOW',
      `this policy can only say yes — it can never refuse anything (${policyPath})`,
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

// Review finding F4: the pairwise scan is quadratic and the per-pair scope
// subset check is quadratic again — a schema-legal file could park loadPolicy
// for minutes. Two defenses: a cheap compatibility pre-filter so benign
// many-rule policies stay near-linear, and a hard work budget — exceeding it
// REFUSES (POLICY_TOO_COMPLEX): bounded time by refusal, never by hanging.
// Weighted units: 1 per pair ITERATION (review N1: the pre-filtered fast
// path is charged too — a guard's own bypass is an attack surface), 1 per
// simple field check, 10 per scope-entry comparison.
const SHADOW_SCAN_BUDGET = 200_000_000;

function findShadowedRule(rules, policyPath) {
  let ops = 0;
  const overBudget = () =>
    bad(
      'POLICY_TOO_COMPLEX',
      `shadow analysis exceeded its work budget — split the policy or reduce overlapping rules (${policyPath})`,
      { policyPath, budget: SHADOW_SCAN_BUDGET },
    );
  const coversWithBudget = (a, b, field) => {
    if (field === 'scope' && field in a.match && field in b.match)
      ops += 10 * a.match.scope.length * b.match.scope.length;
    else ops += 1;
    if (ops > SHADOW_SCAN_BUDGET) overBudget();
    return fieldCovers(a, b, field);
  };
  for (let j = 1; j < rules.length; j++) {
    const mj = rules[j].match;
    for (let i = 0; i < j; i++) {
      ops += 1; // N1: EVERY pair costs — including ones the pre-filter skips
      if (ops > SHADOW_SCAN_BUDGET) overBudget();
      const mi = rules[i].match;
      // pre-filter: i can only cover j if its agent/action constraint is
      // absent, '*', or literally equal — O(1), no allocation
      if ('agent' in mi && mi.agent !== '*' && !('agent' in mj && mi.agent === mj.agent)) continue;
      if ('action' in mi && mi.action !== '*' && !('action' in mj && mi.action === mj.action))
        continue;
      if (MATCH_KEYS.every((f) => coversWithBudget(rules[i], rules[j], f)))
        return { by: rules[i].id, dead: rules[j].id };
    }
  }
  return null;
}

// Review finding F7: JSON duplicate keys are parser-dependent ("deny" to a
// human reader, "allow" to last-wins JSON.parse) — a hashed file must have
// ONE meaning. This scanner walks the already-parse-validated text and
// refuses any object with a repeated key, at any depth.
function scanDuplicateKeys(text, policyPath) {
  const frames = [];
  let i = 0;
  const n = text.length;
  let pendingKey = null;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const start = ++i;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      const spanEnd = i;
      i += 1; // closing quote
      const top = frames[frames.length - 1];
      if (top && top.type === 'obj' && top.expectKey) {
        // normalize escapes the way JSON.parse does, so "a" === "a"
        pendingKey = JSON.parse(`"${text.slice(start, spanEnd)}"`);
        top.expectKey = false;
      }
      continue;
    }
    if (c === '{') {
      frames.push({ type: 'obj', keys: new Set(), expectKey: true });
      pendingKey = null;
    } else if (c === '[') frames.push({ type: 'arr' });
    else if (c === '}' || c === ']') frames.pop();
    else if (c === ':') {
      const top = frames[frames.length - 1];
      if (top && top.type === 'obj' && pendingKey !== null) {
        if (top.keys.has(pendingKey))
          bad(
            'POLICY_SCHEMA_INVALID',
            `duplicate JSON key "${pendingKey}" — a hashed policy must have exactly one meaning (${policyPath})`,
            { policyPath, key: pendingKey },
          );
        top.keys.add(pendingKey);
        pendingKey = null;
      }
    } else if (c === ',') {
      const top = frames[frames.length - 1];
      if (top && top.type === 'obj') top.expectKey = true;
    }
    i += 1;
  }
}

/**
 * Load, validate and hash a policy file. The hash is SHA-256 over the RAW
 * file bytes — what the auditor hashes is what decided; duplicate-key
 * documents (whose meaning depends on the parser) refuse outright.
 * Throws: POLICY_UNREADABLE | POLICY_TOO_LARGE | POLICY_SCHEMA_INVALID | POLICY_VACUOUS_ALLOW |
 *         POLICY_RULE_SHADOWED | POLICY_TOO_COMPLEX
 */
export function loadPolicy({ policyPath }) {
  if (typeof policyPath !== 'string' || policyPath === '')
    bad('POLICY_UNREADABLE', 'policyPath is required — policies are never implicit', {});
  let raw;
  try {
    // a fifo or device would block the read forever (review N1): files only
    const st = statSync(policyPath);
    if (!st.isFile())
      bad('POLICY_UNREADABLE', `the policy path is not a regular file (${policyPath})`, {
        policyPath,
      });
    // C-04: a policy is read whole on every hook call, so its size is bounded
    if (st.size > MAX_POLICY_BYTES)
      bad(
        'POLICY_TOO_LARGE',
        `the policy file is larger than ${MAX_POLICY_BYTES} bytes (${policyPath})`,
        {
          policyPath,
          bytes: st.size,
        },
      );
    raw = readFileSync(policyPath);
  } catch (e) {
    if (e instanceof PolicyError) throw e;
    bad('POLICY_UNREADABLE', `cannot read policy file: ${e.code ?? e.message}`, { policyPath });
  }
  let doc;
  try {
    doc = JSON.parse(raw.toString('utf8'));
  } catch {
    bad('POLICY_UNREADABLE', `policy file is not valid JSON (${policyPath})`, { policyPath });
  }
  scanDuplicateKeys(raw.toString('utf8'), policyPath);
  validatePolicyDoc(doc, policyPath);
  const shadowed = findShadowedRule(doc.rules, policyPath);
  if (shadowed)
    bad(
      'POLICY_RULE_SHADOWED',
      `rule "${shadowed.dead}" can never fire — every context it matches is taken first by "${shadowed.by}"`,
      { policyPath, ...shadowed },
    );
  const policyHash = createHash('sha256').update(raw).digest('hex');
  return { policy: doc, policyHash };
}

const MAX_CONTEXT_STRING = 4096;

function validateContext(context) {
  const inv = (why, details = {}) => bad('CONTEXT_INVALID', why, details);
  if (!isPlainObject(context)) inv('context must be an object');
  if (!isFiniteNonNeg(context.estimatedUsd))
    inv('context.estimatedUsd must be a finite number >= 0 — no coercion, ever', {
      got: context.estimatedUsd,
    });
  if (typeof context.callId !== 'string' || context.callId === '')
    inv('context.callId is required — an unattributable decision is unauditable');
  for (const f of ['agent', 'action', 'scope', 'callId'])
    if (f in context && context[f] !== undefined) {
      if (typeof context[f] !== 'string')
        inv(`context.${f} must be a string when present`, { field: f });
      // Review finding F11: unbounded strings flow into the audit log verbatim.
      if (context[f].length > MAX_CONTEXT_STRING)
        inv(`context.${f} exceeds ${MAX_CONTEXT_STRING} chars`, { field: f });
      // review N3: '' is no agent and no action — the ledger refuses it later,
      // after the decision was already logged as an allow
      if (context[f] === '') inv(`context.${f} must not be empty when present`, { field: f });
    }
  // Review finding F2: a non-canonical scope ('prod//x', './prod/x',
  // '/prod/x', 'a/../b') can match NO rule — in a deny-first policy that
  // slides past an explicit deny into a later allow or a permissive
  // default. Refuse the alias outright; canonicalizing (and unicode
  // normalization) is the enforcer's documented duty.
  if (typeof context.scope === 'string' && !isCanonicalRelPath(context.scope))
    inv('context.scope must be a canonical relative path — aliases are refused, not ignored', {
      got: context.scope.slice(0, 80),
    });
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
  // COPY FIRST, validate the copy, judge the copy, log the copy. Each caller
  // property is read exactly ONCE: a getter that answers the validator one
  // value and the matcher another (review finding F5 — the lock-protocol
  // TOCTOU, reborn in miniature) gets no second read, and mutating the
  // caller's object after decide() cannot rewrite the audit log.
  const judged = isPlainObject(context)
    ? {
        agent: context.agent,
        action: context.action,
        scope: context.scope,
        estimatedUsd: context.estimatedUsd,
        callId: context.callId,
      }
    : context;
  validateContext(judged);
  const finish = (verdict, ruleId, approversMinRaw) => {
    const d = { verdict, ruleId, policyHash, context: judged };
    // Review finding F1: the default path MUST carry approversMin too —
    // "unmatched means a human signs" fell open as `0 < undefined === false`.
    if (verdict === 'require_approval') d.approversMin = approversMinRaw ?? 1;
    return d;
  };
  for (const rule of policy.rules)
    if (ruleMatches(rule, judged)) return finish(rule.verdict, rule.id, rule.approvers_min);
  return finish(policy.default_verdict, null, undefined);
}

/**
 * Append one decision to the JSONL log. An unauditable allow is a deny:
 * any failure here throws DECISION_UNLOGGABLE and the enforcer must refuse
 * the action.
 */
export function logDecision({ decisionLogPath, decision, by }) {
  // Review finding F6: the log line format is public API, so the gate is
  // strict — only something shaped exactly like a decide() result may enter
  // the audit trail, and ANY failure (including serialization) is the one
  // typed refusal. Accepts only loadPolicy/decide outputs by construction.
  if (
    typeof decisionLogPath !== 'string' ||
    decisionLogPath === '' ||
    !isPlainObject(decision) ||
    !VERDICTS.includes(decision.verdict) ||
    typeof decision.policyHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(decision.policyHash) ||
    !(decision.ruleId === null || typeof decision.ruleId === 'string') ||
    !(
      decision.context === undefined ||
      decision.context === null ||
      isPlainObject(decision.context)
    ) ||
    // N3: approversMin iff require_approval — exactly what decide() emits
    !(decision.verdict === 'require_approval'
      ? Number.isInteger(decision.approversMin) && decision.approversMin >= 1
      : decision.approversMin === undefined) ||
    // N4: the enforcer-supplied signer name obeys the same string cap
    (typeof by === 'string' && by.length > MAX_CONTEXT_STRING)
  )
    bad('DECISION_UNLOGGABLE', 'only a decide()-shaped decision can enter the audit trail', {
      decisionLogPath,
    });
  let line;
  try {
    line = `${JSON.stringify({
      at: new Date().toISOString(),
      by: typeof by === 'string' && by !== '' ? by : null,
      verdict: decision.verdict,
      ruleId: decision.ruleId ?? null,
      ...(decision.approversMin !== undefined ? { approversMin: decision.approversMin } : {}),
      policyHash: decision.policyHash,
      context: decision.context ?? null,
    })}\n`;
    appendNoFollow(decisionLogPath, line); // never written through a planted symlink (review S4)
  } catch (e) {
    bad('DECISION_UNLOGGABLE', `decision log write failed: ${e.code ?? e.message}`, {
      decisionLogPath,
    });
  }
}

export { matchPath };
