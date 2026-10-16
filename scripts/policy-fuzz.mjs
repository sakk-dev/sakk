// SPDX-License-Identifier: AGPL-3.0-only
//
// Policy-kernel invariant fuzz. Seeded PRNG → random policies (valid,
// shadowed, vacuous and malformed alike) and random contexts (honest and
// pathological). Replay any reported seed exactly:
//   SAKK_POLICY_FUZZ_SEED=<n> npm run fuzz:policy
//
// Invariants (any violation exits 1 with the seed):
//  I1 decide() is deterministic: same loaded policy + same context, twice,
//     deep-equal results.
//  I2 the verdict is either the matched rule's verdict or the default —
//     nothing else exists.
//  I3 ruleId === null  ⟺  the default verdict was applied.
//  I4 the kernel only ever throws typed PolicyError (never TypeError & co).
//  I5 a 10k-rule policy loads and decides in bounded time (no quadratic
//     blow-up in the decidable shadow check's hot path).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy, decide, logDecision, PolicyError } from '../src/policy.mjs';

const seed = Number(process.env.SAKK_POLICY_FUZZ_SEED ?? Date.now());
let s = seed >>> 0 || 1;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const dir = mkdtempSync(join(tmpdir(), 'sakk-pfuzz-'));
let fileNo = 0;
const write = (doc) => {
  const p = join(dir, `p${fileNo++}.json`);
  writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return p;
};

const ACTIONS = ['file_write', 'model_call', 'deploy', 'rm_rf', '*'];
const AGENTS = ['dev-1', 'bot-7', '*'];
const SCOPES = [['docs/'], ['src/', 'test/'], ['prod/'], ['a/b.mjs']];
const VERDICTS = ['allow', 'deny', 'require_approval'];

function genRule(i) {
  const match = {};
  if (rnd() < 0.5) match.agent = pick(AGENTS);
  if (rnd() < 0.6) match.action = pick(ACTIONS);
  if (rnd() < 0.4) match.scope = pick(SCOPES);
  if (rnd() < 0.5) match.max_estimated_usd = Math.round(rnd() * 500) / 100 + 0.01;
  const verdict = pick(VERDICTS);
  const r = { id: `r${i}`, match, verdict };
  if (verdict === 'require_approval' && rnd() < 0.5) r.approvers_min = 1 + Math.floor(rnd() * 3);
  return r;
}
function genPolicy() {
  if (rnd() < 0.12) {
    // malformed on purpose — must surface as a TYPED refusal
    return pick([
      '{broken',
      JSON.stringify({ schema: 'nope', default_verdict: 'deny', rules: [] }),
      JSON.stringify({ schema: 'sakk-policy.v1', rules: [] }),
      JSON.stringify({
        schema: 'sakk-policy.v1',
        default_verdict: 'deny',
        rules: [{ id: 'x', match: { max_estimated_usd: '2' }, verdict: 'deny' }],
      }),
    ]);
  }
  const n = Math.floor(rnd() * 6);
  return {
    schema: 'sakk-policy.v1',
    default_verdict: pick(VERDICTS),
    rules: Array.from({ length: n }, (_, i) => genRule(i)),
  };
}
function genContext() {
  const bad = rnd() < 0.15;
  return {
    agent: pick(['dev-1', 'bot-7', 'intruder', undefined]),
    action: pick(['file_write', 'model_call', 'deploy', 'alien', undefined]),
    scope: pick(['docs/x.md', 'src/a.mjs', 'prod/api', '../up', '/abs', 'a//b', undefined]),
    estimatedUsd: bad ? pick([NaN, -1, '1', Infinity, undefined]) : Math.round(rnd() * 600) / 100,
    callId: bad && rnd() < 0.3 ? '' : `c-${Math.floor(rnd() * 1e6)}`,
  };
}

const die = (why, extra = {}) => {
  console.error(`policy-fuzz FAILED (seed=${seed}): ${why}`, JSON.stringify(extra));
  process.exit(1);
};

const refusals = {};
let decisions = 0;
const STEPS = 220;
for (let step = 0; step < STEPS; step++) {
  let loaded;
  try {
    loaded = loadPolicy({ policyPath: write(genPolicy()) });
  } catch (e) {
    if (!(e instanceof PolicyError)) die(`I4 load threw ${e.constructor.name}: ${e.message}`);
    refusals[e.code] = (refusals[e.code] ?? 0) + 1;
    continue;
  }
  for (let k = 0; k < 6; k++) {
    const context = genContext();
    let a;
    try {
      a = decide({ ...loaded, context });
    } catch (e) {
      if (!(e instanceof PolicyError)) die(`I4 decide threw ${e.constructor.name}: ${e.message}`);
      refusals[e.code] = (refusals[e.code] ?? 0) + 1;
      continue;
    }
    const b = decide({ ...loaded, context });
    if (JSON.stringify(a) !== JSON.stringify(b)) die('I1 nondeterministic decide', { a, b });
    const rule = loaded.policy.rules.find((r) => r.id === a.ruleId) ?? null;
    if (a.ruleId === null) {
      if (a.verdict !== loaded.policy.default_verdict)
        die('I3 null ruleId but non-default verdict', a);
      if (a.verdict === 'require_approval' && a.approversMin !== 1)
        die('I2 default require_approval must carry approversMin=1 (review F1)', a);
    } else {
      if (!rule) die('I2 decision names a rule that does not exist', a);
      if (rule.verdict !== a.verdict) die('I2 verdict differs from the matched rule', a);
      if (rule.verdict === 'require_approval' && a.approversMin !== (rule.approvers_min ?? 1))
        die('I2 approversMin mismatch', a);
    }
    decisions++;
    try {
      logDecision({ decisionLogPath: join(dir, 'decisions.jsonl'), decision: a, by: 'fuzz' });
    } catch (e) {
      if (!(e instanceof PolicyError))
        die(`I4 logDecision threw ${e.constructor.name}: ${e.message}`);
      refusals[e.code] = (refusals[e.code] ?? 0) + 1;
    }
  }
}

// I4 on the log gate itself: forged decisions must refuse TYPED (review F6)
for (const forged of [
  null,
  { verdict: 'allow', policyHash: 'short', ruleId: null },
  { verdict: 'maybe', policyHash: 'a'.repeat(64), ruleId: null },
  { verdict: 'allow', policyHash: 'a'.repeat(64), ruleId: 42 },
]) {
  try {
    logDecision({ decisionLogPath: join(dir, 'decisions.jsonl'), decision: forged, by: 'fuzz' });
    die('I4 forged decision entered the audit trail', { forged });
  } catch (e) {
    if (!(e instanceof PolicyError)) die(`I4 forged-decision path threw ${e.constructor.name}`);
  }
}

// I5 (reshaped after review F4 caught the first probe testing the BEST case):
// "bounded time" means bounded by SUCCESS or by REFUSAL — never by hanging.
// (a) benign shape: 10k rules, distinct agents — must load and decide fast
const bigRules = Array.from({ length: 10_000 }, (_, i) => ({
  id: `big-${i}`,
  match: { agent: `agent-${i}`, max_estimated_usd: 1 + (i % 7) },
  verdict: VERDICTS[i % 3],
  ...(VERDICTS[i % 3] === 'require_approval' ? { approvers_min: 1 } : {}),
}));
// wall clock = pathology line only (F-62): ~1.4 s idle, 14x slower under the
// audit's load; the adversarial bound itself is the pinned work budget
const PATHOLOGY_MS = 120_000;
const t0 = Date.now();
const bigLoaded = loadPolicy({
  policyPath: write({ schema: 'sakk-policy.v1', default_verdict: 'deny', rules: bigRules }),
});
decide({ ...bigLoaded, context: { agent: 'agent-9999', estimatedUsd: 0.5, callId: 'big' } });
const bigMs = Date.now() - t0;
if (bigMs > PATHOLOGY_MS) die(`I5 benign 10k-rule policy took ${bigMs}ms`);
// (b) adversarial shape (the review PoC): shared action, 30-entry scope
// lists, nothing provably shadowed — must REFUSE fast, not hang
const common = Array.from({ length: 29 }, (_, k) => `shared/${k}/`);
const evilRules = Array.from({ length: 400 }, (_, i) => ({
  id: `evil-${i}`,
  match: { action: 'model_call', scope: [...common, `own/${i}/`] },
  verdict: 'deny',
}));
const t1 = Date.now();
let evilOutcome = 'loaded';
try {
  loadPolicy({
    policyPath: write({ schema: 'sakk-policy.v1', default_verdict: 'deny', rules: evilRules }),
  });
} catch (e) {
  if (!(e instanceof PolicyError)) die(`I5 adversarial probe threw ${e.constructor.name}`);
  evilOutcome = e.code;
  if (e.code === 'POLICY_TOO_COMPLEX' && e.details?.budget !== 200_000_000)
    die(`I5 refusal did not come from the pinned work budget: ${JSON.stringify(e.details)}`);
}
const evilMs = Date.now() - t1;
if (evilMs > PATHOLOGY_MS)
  die(`I5 adversarial probe took ${evilMs}ms — bounded means fast success OR fast refusal`);
if (evilOutcome !== 'POLICY_TOO_COMPLEX' && evilOutcome !== 'loaded')
  die(`I5 adversarial probe unexpected refusal ${evilOutcome}`);

console.log(
  `policy-fuzz: ${STEPS} policies, ${decisions} decisions, refusals ${JSON.stringify(
    refusals,
  )}, probes benign=${bigMs}ms adversarial=${evilOutcome}/${evilMs}ms — all invariants held (seed=${seed})`,
);
