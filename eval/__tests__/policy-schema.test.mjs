import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainst } from '../lib/validate.mjs';
import { loadPolicy } from '../../src/policy.mjs';

/**
 * Drift guard between the DOCUMENTED policy schema (eval/schemas/
 * policy.schema.json) and the kernel's own fail-closed validation
 * (src/policy.mjs). The kernel is authoritative at runtime; this test
 * forces any divergence between the two to show up as a red, so they can
 * only evolve together, consciously.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICIES = join(HERE, '..', '..', 'policies');

describe('policy schema drift guard', () => {
  test('every shipped reference policy passes BOTH the schema and the kernel', () => {
    const files = readdirSync(POLICIES).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 2, 'reference policies missing');
    for (const f of files) {
      const p = join(POLICIES, f);
      const doc = JSON.parse(readFileSync(p, 'utf8'));
      const v = validateAgainst(doc, 'policy.schema.json');
      assert.ok(v.ok, `${f} vs documented schema: ${JSON.stringify(v.errors)}`);
      loadPolicy({ policyPath: p }); // kernel view — throws on any refusal
    }
  });
  test('a document the kernel refuses is also refused by the documented schema', () => {
    const bad = {
      schema: 'sakk-policy.v1',
      default_verdict: 'deny',
      rules: [{ id: 'x', match: { max_estimated_usd: '2' }, verdict: 'deny' }],
    };
    const v = validateAgainst(bad, 'policy.schema.json');
    assert.equal(v.ok, false, 'documented schema accepted what the kernel refuses');
  });
});
