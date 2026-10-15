import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainst } from '../lib/validate.mjs';
import { loadPolicy, PolicyError } from '../../src/policy.mjs';

/**
 * Honest drift guard between the DOCUMENTED shape schema
 * (eval/schemas/policy.schema.json) and the kernel's own validation
 * (src/policy.mjs). Review finding F9: the first version of this file
 * claimed "any divergence shows up as red" while checking almost nothing —
 * a guard's self-description is a claim like any other. The truth:
 *
 *   The kernel is DELIBERATELY stricter than the shape schema. The schema
 *   answers "is this document shaped like a policy?"; the kernel
 *   additionally refuses semantic illegality. Every known divergence is
 *   cataloged below and asserted in BOTH directions, so a new divergence —
 *   or a silently healed one — turns this file red.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICIES = join(HERE, '..', '..', 'policies');
const tdir = () => mkdtempSync(join(tmpdir(), 'sakk-drift-'));
const load = (doc) => {
  const p = join(tdir(), 'p.json');
  writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return loadPolicy({ policyPath: p });
};
const kernelCode = (doc) => {
  try {
    load(doc);
    return null;
  } catch (e) {
    assert.ok(e instanceof PolicyError);
    return e.code;
  }
};

describe('policy schema ↔ kernel drift guard', () => {
  test('agreement: every shipped reference policy passes BOTH validators', () => {
    const files = readdirSync(POLICIES).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 2, 'reference policies missing');
    for (const f of files) {
      const p = join(POLICIES, f);
      const doc = JSON.parse(readFileSync(p, 'utf8'));
      const v = validateAgainst(doc, 'policy.schema.json');
      assert.ok(v.ok, `${f} vs documented schema: ${JSON.stringify(v.errors)}`);
      loadPolicy({ policyPath: p });
    }
  });
  test('agreement: what the schema rejects on shape, the kernel also refuses', () => {
    for (const doc of [
      { schema: 'nope', default_verdict: 'deny', rules: [] },
      { schema: 'sakk-policy.v1', rules: [] },
      {
        schema: 'sakk-policy.v1',
        default_verdict: 'deny',
        rules: [{ id: 'x', match: { max_estimated_usd: '2' }, verdict: 'deny' }],
      },
      {
        schema: 'sakk-policy.v1',
        default_verdict: 'deny',
        rules: [{ id: 'x', match: { scope: ['/etc'] }, verdict: 'deny' }],
      },
      {
        schema: 'sakk-policy.v1',
        default_verdict: 'deny',
        rules: [{ id: 'x', match: { scope: ['prod/**'] }, verdict: 'deny' }],
      },
    ]) {
      const v = validateAgainst(doc, 'policy.schema.json');
      assert.equal(v.ok, false, `schema accepted: ${JSON.stringify(doc).slice(0, 80)}`);
      assert.notEqual(kernelCode(doc), null, 'kernel must refuse what the schema rejects');
    }
  });
  test('cataloged divergences: shape-legal documents the kernel refuses SEMANTICALLY', () => {
    const CATALOG = [
      [{ schema: 'sakk-policy.v1', default_verdict: 'allow', rules: [] }, 'POLICY_VACUOUS_ALLOW'],
      [
        {
          schema: 'sakk-policy.v1',
          default_verdict: 'deny',
          rules: [{ id: 'x', match: {}, verdict: 'allow', approvers_min: 2 }],
        },
        'POLICY_SCHEMA_INVALID', // approvers_min only on require_approval
      ],
      [
        {
          schema: 'sakk-policy.v1',
          default_verdict: 'deny',
          rules: [
            { id: 'dup', match: { action: 'a' }, verdict: 'allow' },
            { id: 'dup', match: { action: 'b' }, verdict: 'deny' },
          ],
        },
        'POLICY_SCHEMA_INVALID', // duplicate rule ids
      ],
      [
        {
          schema: 'sakk-policy.v1',
          default_verdict: 'deny',
          rules: [
            { id: 'broad', match: { scope: ['docs/'] }, verdict: 'allow' },
            { id: 'dead', match: { scope: ['docs/api/'] }, verdict: 'deny' },
          ],
        },
        'POLICY_RULE_SHADOWED',
      ],
    ];
    for (const [doc, expected] of CATALOG) {
      const v = validateAgainst(doc, 'policy.schema.json');
      assert.ok(v.ok, `catalog entry should be shape-legal: ${JSON.stringify(v.errors)}`);
      assert.equal(kernelCode(doc), expected);
    }
    // parser-level divergences the shape schema can never see (it receives a
    // PARSED document): duplicate JSON keys → POLICY_SCHEMA_INVALID, and the
    // shadow-scan work budget → POLICY_TOO_COMPLEX. Both are covered by
    // attack tests in test/policy.test.mjs.
  });
});
