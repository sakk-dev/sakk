import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, decide, logDecision, PolicyError } from '../src/policy.mjs';
import { initLedger, reserve, settle, readLedger } from '../src/ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICIES = join(HERE, '..', 'policies');
const tdir = () => mkdtempSync(join(tmpdir(), 'sakk-pol-'));

const writePolicy = (doc) => {
  const p = join(tdir(), 'policy.json');
  writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return p;
};
const base = (over = {}) => ({
  schema: 'sakk-policy.v1',
  default_verdict: 'deny',
  rules: [{ id: 'r1', match: { action: 'file_write' }, verdict: 'allow' }],
  ...over,
});
const ctx = (over = {}) => ({
  agent: 'dev-1',
  action: 'file_write',
  scope: 'docs/readme.md',
  estimatedUsd: 0.1,
  callId: 'c-1',
  ...over,
});
const expectCode = (fn, code) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof PolicyError, `expected PolicyError, got ${e.constructor.name}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected ${code}, nothing thrown`);
};

describe('loadPolicy: every load refusal has a name', () => {
  test('missing/empty policyPath → POLICY_UNREADABLE', () => {
    expectCode(() => loadPolicy({}), 'POLICY_UNREADABLE');
    expectCode(() => loadPolicy({ policyPath: '' }), 'POLICY_UNREADABLE');
  });
  test('nonexistent file → POLICY_UNREADABLE', () => {
    expectCode(() => loadPolicy({ policyPath: join(tdir(), 'nope.json') }), 'POLICY_UNREADABLE');
  });
  test('invalid JSON → POLICY_UNREADABLE', () => {
    expectCode(() => loadPolicy({ policyPath: writePolicy('{nope') }), 'POLICY_UNREADABLE');
  });
  test('wrong schema id → POLICY_SCHEMA_INVALID', () => {
    expectCode(
      () => loadPolicy({ policyPath: writePolicy(base({ schema: 'sakk-policy.v2' })) }),
      'POLICY_SCHEMA_INVALID',
    );
  });
  test('missing default_verdict → POLICY_SCHEMA_INVALID (no implicit default, ever)', () => {
    const d = base();
    delete d.default_verdict;
    expectCode(() => loadPolicy({ policyPath: writePolicy(d) }), 'POLICY_SCHEMA_INVALID');
  });
  test('unknown verdict / unknown keys / duplicate ids all refuse', () => {
    expectCode(
      () =>
        loadPolicy({
          policyPath: writePolicy(base({ rules: [{ id: 'x', match: {}, verdict: 'maybe' }] })),
        }),
      'POLICY_SCHEMA_INVALID',
    );
    expectCode(
      () => loadPolicy({ policyPath: writePolicy(base({ surprise: 1 })) }),
      'POLICY_SCHEMA_INVALID',
    );
    expectCode(
      () =>
        loadPolicy({
          policyPath: writePolicy(
            base({ rules: [{ id: 'x', match: { color: 'red' }, verdict: 'allow' }] }),
          ),
        }),
      'POLICY_SCHEMA_INVALID',
    );
    expectCode(
      () =>
        loadPolicy({
          policyPath: writePolicy(
            base({
              rules: [
                { id: 'dup', match: { action: 'a' }, verdict: 'allow' },
                { id: 'dup', match: { action: 'b' }, verdict: 'deny' },
              ],
            }),
          ),
        }),
      'POLICY_SCHEMA_INVALID',
    );
  });
  test('approvers_min on a non-approval rule, or < 1, refuses', () => {
    expectCode(
      () =>
        loadPolicy({
          policyPath: writePolicy(
            base({ rules: [{ id: 'x', match: {}, verdict: 'allow', approvers_min: 2 }] }),
          ),
        }),
      'POLICY_SCHEMA_INVALID',
    );
    expectCode(
      () =>
        loadPolicy({
          policyPath: writePolicy(
            base({
              rules: [{ id: 'x', match: {}, verdict: 'require_approval', approvers_min: 0 }],
            }),
          ),
        }),
      'POLICY_SCHEMA_INVALID',
    );
  });
  test('pathological match values refuse: absolute scope, zero/negative/string amounts', () => {
    for (const match of [
      { scope: ['/etc'] },
      { scope: [] },
      { max_estimated_usd: 0 },
      { max_estimated_usd: -1 },
      { max_estimated_usd: '2' },
    ])
      expectCode(
        () =>
          loadPolicy({
            policyPath: writePolicy(base({ rules: [{ id: 'x', match, verdict: 'deny' }] })),
          }),
        'POLICY_SCHEMA_INVALID',
      );
  });
  test('POLICY_VACUOUS_ALLOW: an empty allow-by-default policy refuses at load', () => {
    expectCode(
      () => loadPolicy({ policyPath: writePolicy(base({ default_verdict: 'allow', rules: [] })) }),
      'POLICY_VACUOUS_ALLOW',
    );
  });
  test('empty rules with default deny is a valid lockdown policy', () => {
    const { policy } = loadPolicy({ policyPath: writePolicy(base({ rules: [] })) });
    assert.equal(policy.rules.length, 0);
  });
  test('hash is over raw bytes: reformatting the same document changes the hash', () => {
    const doc = base();
    const a = loadPolicy({ policyPath: writePolicy(doc) });
    const b = loadPolicy({ policyPath: writePolicy(JSON.stringify(doc, null, 2)) });
    assert.notEqual(a.policyHash, b.policyHash);
    const a2 = loadPolicy({ policyPath: writePolicy(doc) });
    assert.equal(a.policyHash, a2.policyHash);
  });
});

describe('loadPolicy: shadow detection (provable dead rules refuse)', () => {
  const shadowed = (rules) =>
    expectCode(
      () => loadPolicy({ policyPath: writePolicy(base({ rules })) }),
      'POLICY_RULE_SHADOWED',
    );
  test('identical match objects: the later rule is dead, both ids are named', () => {
    const e = shadowed([
      { id: 'first', match: { action: 'deploy' }, verdict: 'allow' },
      { id: 'second', match: { action: 'deploy' }, verdict: 'deny' },
    ]);
    assert.equal(e.details.by, 'first');
    assert.equal(e.details.dead, 'second');
  });
  test('absent-field and "*" supersets are detected', () => {
    shadowed([
      { id: 'everything', match: {}, verdict: 'deny' },
      { id: 'never', match: { action: 'deploy' }, verdict: 'allow' },
    ]);
    shadowed([
      { id: 'star', match: { agent: '*' }, verdict: 'deny' },
      { id: 'never', match: { agent: 'dev-1' }, verdict: 'allow' },
    ]);
  });
  test('prefix superset: docs/ swallows docs/api/', () => {
    shadowed([
      { id: 'broad', match: { scope: ['docs/'] }, verdict: 'allow' },
      { id: 'narrow', match: { scope: ['docs/api/'] }, verdict: 'deny' },
    ]);
  });
  test('amount superset: max 10 swallows max 2', () => {
    shadowed([
      { id: 'big', match: { max_estimated_usd: 10 }, verdict: 'allow' },
      { id: 'small', match: { max_estimated_usd: 2 }, verdict: 'deny' },
    ]);
  });
  test('partial overlap is NOT refused (the checker only kills provable corpses)', () => {
    const { policy } = loadPolicy({
      policyPath: writePolicy(
        base({
          rules: [
            { id: 'by-agent', match: { agent: 'a' }, verdict: 'allow' },
            { id: 'by-action', match: { action: 'x' }, verdict: 'deny' },
          ],
        }),
      ),
    });
    assert.equal(policy.rules.length, 2);
  });
});

describe('decide: context validation refuses, never coerces', () => {
  const loaded = loadPolicy({ policyPath: writePolicy(base()) });
  const dec = (c) => decide({ ...loaded, context: c });
  test('estimatedUsd absent / NaN / string / negative / Infinity → CONTEXT_INVALID', () => {
    for (const estimatedUsd of [undefined, NaN, '0.1', -1, Infinity])
      expectCode(() => dec(ctx({ estimatedUsd })), 'CONTEXT_INVALID');
  });
  test('callId required; non-object context refuses; wrong-typed fields refuse', () => {
    expectCode(() => dec(ctx({ callId: '' })), 'CONTEXT_INVALID');
    expectCode(() => dec(null), 'CONTEXT_INVALID');
    expectCode(() => dec(ctx({ agent: 42 })), 'CONTEXT_INVALID');
  });
});

describe('decide: first-match semantics', () => {
  test('first match wins: the earlier of two overlapping rules decides', () => {
    const { policy, policyHash } = loadPolicy({
      policyPath: writePolicy(
        base({
          rules: [
            { id: 'docs-allow', match: { scope: ['docs/'] }, verdict: 'allow' },
            { id: 'writes-deny', match: { action: 'file_write' }, verdict: 'deny' },
          ],
        }),
      ),
    });
    const d = decide({ policy, policyHash, context: ctx() });
    assert.equal(d.verdict, 'allow');
    assert.equal(d.ruleId, 'docs-allow');
    const d2 = decide({ policy, policyHash, context: ctx({ scope: 'src/x.mjs' }) });
    assert.equal(d2.ruleId, 'writes-deny');
  });
  test('amount is a match condition: over the limit falls through to the NEXT rule, then default', () => {
    const { policy, policyHash } = loadPolicy({
      policyPath: writePolicy(
        base({
          default_verdict: 'deny',
          rules: [
            { id: 'small', match: { max_estimated_usd: 1 }, verdict: 'allow' },
            {
              id: 'medium',
              match: { max_estimated_usd: 5 },
              verdict: 'require_approval',
              approvers_min: 1,
            },
          ],
        }),
      ),
    });
    assert.equal(
      decide({ policy, policyHash, context: ctx({ estimatedUsd: 0.5 }) }).ruleId,
      'small',
    );
    assert.equal(
      decide({ policy, policyHash, context: ctx({ estimatedUsd: 3 }) }).ruleId,
      'medium',
    );
    const over = decide({ policy, policyHash, context: ctx({ estimatedUsd: 50 }) });
    assert.equal(over.verdict, 'deny');
    assert.equal(over.ruleId, null);
  });
  test('boundary: AT the limit matches (plain <=, the epsilon wall stays the ledger business)', () => {
    const { policy, policyHash } = loadPolicy({
      policyPath: writePolicy(
        base({ rules: [{ id: 'cap', match: { max_estimated_usd: 1 }, verdict: 'allow' }] }),
      ),
    });
    assert.equal(decide({ policy, policyHash, context: ctx({ estimatedUsd: 1 }) }).ruleId, 'cap');
  });
  test('no rule matched → mandatory default, ruleId null — never an implicit allow', () => {
    const { policy, policyHash } = loadPolicy({ policyPath: writePolicy(base()) });
    const d = decide({ policy, policyHash, context: ctx({ action: 'alien_action' }) });
    assert.equal(d.verdict, 'deny');
    assert.equal(d.ruleId, null);
  });
  test('require_approval carries approversMin (explicit, and defaulting to 1)', () => {
    const { policy, policyHash } = loadPolicy({
      policyPath: writePolicy(
        base({
          rules: [
            {
              id: 'four-eyes',
              match: { action: 'deploy' },
              verdict: 'require_approval',
              approvers_min: 2,
            },
            { id: 'one-eye', match: { action: 'merge' }, verdict: 'require_approval' },
          ],
        }),
      ),
    });
    assert.equal(
      decide({ policy, policyHash, context: ctx({ action: 'deploy' }) }).approversMin,
      2,
    );
    assert.equal(decide({ policy, policyHash, context: ctx({ action: 'merge' }) }).approversMin, 1);
  });
  test('F1: the DEFAULT require_approval verdict carries approversMin too', () => {
    const { policy, policyHash } = loadPolicy({
      policyPath: writePolicy(
        base({
          default_verdict: 'require_approval',
          rules: [{ id: 'block-rm', match: { action: 'rm_rf' }, verdict: 'deny' }],
        }),
      ),
    });
    const d = decide({ policy, policyHash, context: ctx({ action: 'deploy' }) });
    assert.equal(d.verdict, 'require_approval');
    assert.equal(d.ruleId, null);
    assert.equal(d.approversMin, 1, 'unmatched-means-a-human-signs must not fall open');
  });
  test('a scope-constrained rule never matches a context without a scope', () => {
    const { policy, policyHash } = loadPolicy({
      policyPath: writePolicy(
        base({ rules: [{ id: 'scoped', match: { scope: ['docs/'] }, verdict: 'allow' }] }),
      ),
    });
    const c = ctx();
    delete c.scope;
    assert.equal(decide({ policy, policyHash, context: c }).ruleId, null);
  });
  test('F2 attack: ASCII path aliases REFUSE (CONTEXT_INVALID), never slide past a deny', () => {
    const { policy, policyHash } = loadPolicy({
      policyPath: writePolicy(
        base({ rules: [{ id: 'docs', match: { scope: ['docs/'] }, verdict: 'allow' }] }),
      ),
    });
    for (const scope of ['../docs/x', '/docs/x', 'docs//x', 'docs/./x', 'docs/x/..'])
      expectCode(() => decide({ policy, policyHash, context: ctx({ scope }) }), 'CONTEXT_INVALID');
    // a unicode homoglyph is an honest-looking canonical string: it falls
    // through to the default (normalization is the enforcer's documented duty)
    const d = decide({ policy, policyHash, context: ctx({ scope: 'dοcs/x' }) });
    assert.equal(d.ruleId, null);
  });
  test('F2 attack on the shipped profile: prod//api cannot dodge the prod deny into an allow', () => {
    const l = loadPolicy({ policyPath: join(POLICIES, 'permissive-dev.json') });
    for (const scope of ['prod//api', '/prod/api', './prod/api', 'prod/./api'])
      expectCode(
        () => decide({ ...l, context: ctx({ action: 'deploy', scope, estimatedUsd: 0.5 }) }),
        'CONTEXT_INVALID',
      );
  });
  test('F5 attack: a getter cannot answer the validator one value and the matcher another', () => {
    const loaded = loadPolicy({ policyPath: writePolicy(base()) });
    let reads = 0;
    const sneaky = {
      agent: 'dev-1',
      action: 'file_write',
      scope: 'docs/readme.md',
      callId: 'c-g',
      get estimatedUsd() {
        return reads++ === 0 ? 0.1 : NaN;
      },
    };
    const d = decide({ ...loaded, context: sneaky });
    assert.equal(d.context.estimatedUsd, 0.1, 'exactly one read, taken before validation');
    const replay = decide({ ...loaded, context: d.context });
    assert.deepEqual(
      replay.verdict,
      d.verdict,
      'the logged context must replay to the same verdict',
    );
    let reads2 = 0;
    const nanFirst = {
      ...ctx(),
      get estimatedUsd() {
        return reads2++ === 0 ? NaN : 0.1;
      },
    };
    expectCode(() => decide({ ...loaded, context: nanFirst }), 'CONTEXT_INVALID');
  });
  test('attack: mutating the context AFTER decide cannot rewrite the logged context', () => {
    const loaded = loadPolicy({ policyPath: writePolicy(base()) });
    const c = ctx();
    const d = decide({ ...loaded, context: c });
    c.scope = 'prod/launch-codes';
    c.estimatedUsd = 9999;
    assert.equal(d.context.scope, 'docs/readme.md', 'decision must hold a copy, not the reference');
    assert.equal(d.context.estimatedUsd, 0.1);
  });
  test('decide is pure: identical inputs → deep-equal outputs; the context is not mutated', () => {
    const loaded = loadPolicy({ policyPath: writePolicy(base()) });
    const c = ctx();
    const frozen = JSON.stringify(c);
    const a = decide({ ...loaded, context: c });
    const b = decide({ ...loaded, context: c });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(c), frozen);
  });
});

describe('logDecision: an unauditable allow is a deny', () => {
  const loaded = loadPolicy({ policyPath: writePolicy(base()) });
  const decision = decide({ ...loaded, context: ctx() });
  test('appends one JSONL line carrying verdict, ruleId, policyHash and context', () => {
    const log = join(tdir(), 'decisions.jsonl');
    logDecision({ decisionLogPath: log, decision, by: 'mcp-server' });
    logDecision({ decisionLogPath: log, decision, by: 'mcp-server' });
    const lines = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].verdict, 'allow');
    assert.equal(lines[0].policyHash, loaded.policyHash);
    assert.equal(lines[0].context.callId, 'c-1');
    assert.equal(lines[0].by, 'mcp-server');
  });
  test('unwritable log path → DECISION_UNLOGGABLE', () => {
    const dirAsFile = tdir(); // a directory: appendFileSync must fail
    expectCode(
      () => logDecision({ decisionLogPath: dirAsFile, decision, by: 'x' }),
      'DECISION_UNLOGGABLE',
    );
  });
  test('F6 attack: a circular context fails TYPED, never as a raw TypeError', () => {
    const log = join(tdir(), 'd.jsonl');
    const circ = { ...decision, context: {} };
    circ.context.self = circ.context;
    expectCode(
      () => logDecision({ decisionLogPath: log, decision: circ, by: 'x' }),
      'DECISION_UNLOGGABLE',
    );
  });
  test('F6 attack: forged decision shapes cannot enter the audit trail', () => {
    const log = join(tdir(), 'd.jsonl');
    for (const forged of [
      { ...decision, policyHash: '' },
      { ...decision, policyHash: 'zz'.repeat(32) },
      { ...decision, ruleId: 42 },
      { ...decision, context: 'not-an-object' },
      { ...decision, verdict: 'require_approval', approversMin: 0 },
      // N3: approversMin iff require_approval — decide() never emits these
      { ...decision, verdict: 'require_approval' },
      { ...decision, approversMin: 3 },
    ])
      expectCode(
        () => logDecision({ decisionLogPath: log, decision: forged, by: 'x' }),
        'DECISION_UNLOGGABLE',
      );
  });
  test('N4: an unbounded signer name cannot flood the audit log', () => {
    expectCode(
      () =>
        logDecision({ decisionLogPath: join(tdir(), 'd.jsonl'), decision, by: 'x'.repeat(5000) }),
      'DECISION_UNLOGGABLE',
    );
  });
  test('a decision without verdict/hash cannot be logged', () => {
    expectCode(
      () => logDecision({ decisionLogPath: join(tdir(), 'd.jsonl'), decision: {}, by: 'x' }),
      'DECISION_UNLOGGABLE',
    );
  });
});

describe('adversarial-review round: load-side attacks (F4/F7/F10/F11)', () => {
  test('F7 attack: duplicate JSON keys refuse — one hashed file, one meaning', () => {
    const dupTop =
      '{"schema":"sakk-policy.v1","default_verdict":"deny","default_verdict":"allow","rules":[]}';
    const e = expectCode(
      () => loadPolicy({ policyPath: writePolicy(dupTop) }),
      'POLICY_SCHEMA_INVALID',
    );
    assert.match(e.message, /duplicate JSON key/);
    const dupNested =
      '{"schema":"sakk-policy.v1","default_verdict":"deny","rules":[{"id":"a","match":{"action":"x","action":"y"},"verdict":"deny"}]}';
    expectCode(() => loadPolicy({ policyPath: writePolicy(dupNested) }), 'POLICY_SCHEMA_INVALID');
    const dupEscaped =
      '{"schema":"sakk-policy.v1","default_verdict":"deny","rules":[{"id":"a","\\u006datch":{},"match":{},"verdict":"deny"}]}';
    expectCode(() => loadPolicy({ policyPath: writePolicy(dupEscaped) }), 'POLICY_SCHEMA_INVALID');
  });
  test('F7 guard: braces, colons and escaped quotes inside string VALUES are not keys', () => {
    const tricky = {
      schema: 'sakk-policy.v1',
      default_verdict: 'deny',
      rules: [{ id: 'we{ird:,"x', match: { action: '{"a":1,"a":2}' }, verdict: 'deny' }],
    };
    const { policy } = loadPolicy({ policyPath: writePolicy(tricky) });
    assert.equal(policy.rules[0].id, 'we{ird:,"x');
  });
  test('F10: a glob-looking scope entry is a dead rule — refused at load', () => {
    expectCode(
      () =>
        loadPolicy({
          policyPath: writePolicy(
            base({ rules: [{ id: 'g', match: { scope: ['prod/**'] }, verdict: 'deny' }] }),
          ),
        }),
      'POLICY_SCHEMA_INVALID',
    );
  });
  test('F11: oversized context strings refuse instead of flooding the audit log', () => {
    const loaded = loadPolicy({ policyPath: writePolicy(base()) });
    expectCode(
      () => decide({ ...loaded, context: ctx({ callId: 'x'.repeat(5000) }) }),
      'CONTEXT_INVALID',
    );
  });
  test('N1 attack (verify pass): uncounted pre-filter spin — distinct-agent mega-policy refuses, never idles', () => {
    const rules = Array.from({ length: 25_000 }, (_, i) => ({
      id: `r${i}`,
      match: { agent: `agent-${i}` },
      verdict: 'deny',
    }));
    // the bound is the work counter, not a stopwatch (F-62): the refusal must
    // come from the shadow-scan budget, and that budget is pinned
    const e = expectCode(
      () => loadPolicy({ policyPath: writePolicy(base({ rules })) }),
      'POLICY_TOO_COMPLEX',
    );
    assert.equal(e.details.budget, 200_000_000, 'refused by the pinned work budget');
  });
  test('N1 boundary: the benign 10k distinct-agent policy still loads', () => {
    const rules = Array.from({ length: 10_000 }, (_, i) => ({
      id: `r${i}`,
      match: { agent: `agent-${i}` },
      verdict: 'deny',
    }));
    const { policy } = loadPolicy({ policyPath: writePolicy(base({ rules })) });
    assert.equal(policy.rules.length, 10_000);
  });
  test('N2 attack: the whole dead-entry family refuses at load, not just globs', () => {
    for (const entry of ['docs//x', './docs', 'a/../b', '.', 'docs/.', '/', 'docs//'])
      expectCode(
        () =>
          loadPolicy({
            policyPath: writePolicy(
              base({ rules: [{ id: 'd', match: { scope: [entry] }, verdict: 'deny' }] }),
            ),
          }),
        'POLICY_SCHEMA_INVALID',
      );
    // legit forms stay legit: dir rule, exact file, dot-named dir
    const { policy } = loadPolicy({
      policyPath: writePolicy(
        base({
          rules: [
            { id: 'ok', match: { scope: ['docs/', 'a/b.mjs', '.github/'] }, verdict: 'deny' },
          ],
        }),
      ),
    });
    assert.equal(policy.rules[0].match.scope.length, 3);
  });
  test('F4 attack: the quadratic shadow-scan shape refuses fast with POLICY_TOO_COMPLEX', () => {
    const common = Array.from({ length: 29 }, (_, k) => `shared/${k}/`);
    const rules = Array.from({ length: 300 }, (_, i) => ({
      id: `r${i}`,
      match: { action: 'model_call', scope: [...common, `own/${i}/`] },
      verdict: 'deny',
    }));
    const e = expectCode(
      () => loadPolicy({ policyPath: writePolicy(base({ rules })) }),
      'POLICY_TOO_COMPLEX',
    );
    assert.equal(e.details.budget, 200_000_000, 'refused by the pinned work budget (F-62)');
  });
});

describe('reference policies: load, hash stably, and express the three tiers', () => {
  test('both references load; hashes are stable across loads', () => {
    for (const f of ['permissive-dev.json', 'regulated-strict.json']) {
      const p = join(POLICIES, f);
      const a = loadPolicy({ policyPath: p });
      const b = loadPolicy({ policyPath: p });
      assert.equal(a.policyHash, b.policyHash);
    }
  });
  test('permissive-dev: prod deploys deny; small spend auto; expensive needs eyes', () => {
    const l = loadPolicy({ policyPath: join(POLICIES, 'permissive-dev.json') });
    const d = (c) => decide({ ...l, context: c });
    assert.equal(
      d(ctx({ action: 'deploy', scope: 'prod/api', estimatedUsd: 0.1 })).verdict,
      'deny',
    );
    assert.equal(d(ctx({ estimatedUsd: 1.5 })).ruleId, 'small-spend-auto');
    const big = d(ctx({ estimatedUsd: 9 }));
    assert.equal(big.verdict, 'require_approval');
    assert.equal(big.approversMin, 1);
  });
  test('regulated-strict: CBUAE three tiers — low auto, medium sampled, high four-eyes, rest deny', () => {
    const l = loadPolicy({ policyPath: join(POLICIES, 'regulated-strict.json') });
    const d = (c) => decide({ ...l, context: c });
    assert.equal(d(ctx({ estimatedUsd: 0.3 })).verdict, 'allow');
    assert.equal(d(ctx({ estimatedUsd: 0.6 })).verdict, 'deny'); // over the low tier → default
    assert.equal(d(ctx({ action: 'model_call', estimatedUsd: 4 })).approversMin, 1);
    assert.equal(d(ctx({ action: 'deploy', estimatedUsd: 0.1 })).approversMin, 2);
    assert.equal(d(ctx({ action: 'rm_rf', estimatedUsd: 0.01 })).verdict, 'deny');
  });
});

describe('integration demo: an enforcer composes kernel + ledger (ledger touched ONLY on allow)', () => {
  // The minimal honest enforcer, shaped like the MCP server will be.
  function enforcer({ loaded, context, ledgerPath, logPath, approvals = [], requester }) {
    const decision = decide({ ...loaded, context });
    try {
      logDecision({ decisionLogPath: logPath, decision, by: 'demo-enforcer' });
    } catch {
      return { acted: false, why: 'DECISION_UNLOGGABLE' };
    }
    if (decision.verdict === 'deny') return { acted: false, why: 'denied', decision };
    if (decision.verdict === 'require_approval') {
      // F1: an unreadable approval requirement is a refusal, never a compare
      if (!(Number.isInteger(decision.approversMin) && decision.approversMin >= 1))
        return { acted: false, why: 'approval_requirement_unreadable', decision };
      // F3: approvers are a SET of named identities, requester excluded
      const distinct = new Set(
        approvals
          .map((a) => a?.by)
          .filter((by) => typeof by === 'string' && by !== '' && by !== requester),
      );
      if (distinct.size < decision.approversMin)
        return { acted: false, why: 'approval_missing', decision };
    }
    reserve({ ledgerPath, callId: context.callId, estimatedMaxUsd: context.estimatedUsd });
    settle({ ledgerPath, callId: context.callId, actualUsd: context.estimatedUsd / 2 });
    return { acted: true, decision };
  }
  const setup = () => {
    const d = tdir();
    const ledgerPath = join(d, 'ledger.json');
    initLedger({ ledgerPath, capUsd: 10 });
    return { ledgerPath, logPath: join(d, 'decisions.jsonl') };
  };
  const loaded = loadPolicy({ policyPath: join(POLICIES, 'regulated-strict.json') });

  test('allow → exactly one ledger entry; deny → zero; the kernel itself never spends', () => {
    const { ledgerPath, logPath } = setup();
    const ok = enforcer({
      loaded,
      context: ctx({ callId: 'ok-1', estimatedUsd: 0.3 }),
      ledgerPath,
      logPath,
    });
    assert.equal(ok.acted, true);
    const no = enforcer({
      loaded,
      context: ctx({ action: 'rm_rf', callId: 'no-1', estimatedUsd: 0.3 }),
      ledgerPath,
      logPath,
    });
    assert.equal(no.acted, false);
    assert.equal(readLedger({ ledgerPath }).entries.length, 1);
  });
  test('require_approval: self-approval does not count; distinct approvers unlock the reserve', () => {
    const { ledgerPath, logPath } = setup();
    const c = ctx({ action: 'deploy', callId: 'dep-1', estimatedUsd: 1 });
    const selfOnly = enforcer({
      loaded,
      context: c,
      ledgerPath,
      logPath,
      requester: 'dev-1',
      approvals: [{ by: 'dev-1' }, { by: 'dev-1' }],
    });
    assert.equal(selfOnly.acted, false);
    assert.equal(readLedger({ ledgerPath }).entries.length, 0, 'no approval, no reservation');
    const fourEyes = enforcer({
      loaded,
      context: c,
      ledgerPath,
      logPath,
      requester: 'dev-1',
      approvals: [{ by: 'alice' }, { by: 'bob' }],
    });
    assert.equal(fourEyes.acted, true);
    assert.equal(readLedger({ ledgerPath }).entries.length, 1);
  });
  test('F1 attack: default require_approval + empty approvals must NOT act (0 < undefined trap)', () => {
    const { ledgerPath, logPath } = setup();
    const defApproval = loadPolicy({
      policyPath: writePolicy(
        base({
          default_verdict: 'require_approval',
          rules: [{ id: 'block-rm', match: { action: 'rm_rf' }, verdict: 'deny' }],
        }),
      ),
    });
    const r = enforcer({
      loaded: defApproval,
      context: ctx({ action: 'deploy', callId: 'd-f1', estimatedUsd: 0.2 }),
      ledgerPath,
      logPath,
      requester: 'dev-1',
      approvals: [],
    });
    assert.equal(r.acted, false);
    assert.equal(readLedger({ ledgerPath }).entries.length, 0, 'fail-open regression');
  });
  test('F3 attack: the same person approving twice does not make four eyes', () => {
    const { ledgerPath, logPath } = setup();
    const c = ctx({ action: 'deploy', callId: 'd-f3', estimatedUsd: 1 });
    const bobTwice = enforcer({
      loaded,
      context: c,
      ledgerPath,
      logPath,
      requester: 'dev-1',
      approvals: [{ by: 'bob' }, { by: 'bob' }, {}, { by: '' }],
    });
    assert.equal(bobTwice.acted, false);
    assert.equal(readLedger({ ledgerPath }).entries.length, 0);
  });
  test('unloggable decision → the enforcer refuses and the ledger stays untouched', () => {
    const { ledgerPath } = setup();
    const r = enforcer({
      loaded,
      context: ctx({ callId: 'log-1', estimatedUsd: 0.3 }),
      ledgerPath,
      logPath: tdir(), // a directory — logging must fail
    });
    assert.equal(r.acted, false);
    assert.equal(r.why, 'DECISION_UNLOGGABLE');
    assert.equal(readLedger({ ledgerPath }).entries.length, 0);
  });
});
