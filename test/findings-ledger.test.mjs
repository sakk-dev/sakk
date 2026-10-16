import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Findings-ledger gate (testing standard §14.7). It checks meaning, not just
 * form: guards and mechanisms resolve to real tests, recurring root-cause
 * classes have a detector that runs, third occurrences have a stop-line
 * review. When it is red: add the missing field, detector or review — never
 * delete a finding or reclassify it to get past the gate.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const LEDGER = JSON.parse(read('findings/ledger.json'));
const FINDINGS = LEDGER.findings;
const IDS = new Set(FINDINGS.map((f) => f.id));
const LOCK = read('findings/taxonomy.lock.yaml');
const CANON = join(
  ROOT,
  '..',
  'agent-system',
  'standards',
  'ai-agent-testing',
  'rca',
  'TAXONOMY.yaml',
);
const CODES = new Set([...LOCK.matchAll(/^ {2}((?:DT|RC|ES)-[A-Z0-9]+):/gm)].map((m) => m[1]));
const REQUIRED = [
  'id',
  'date',
  'title',
  'symptom',
  'evidence',
  'found_by',
  'introduced_in',
  'direct_cause',
  'why',
  'root_cause',
  'dt',
  'rc',
  'es',
  'instance_fix',
  'guard',
  'sweep',
  'sweep_status',
  'status',
];
const FOUND_BY = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'human', 'prod', 'client', 'review'];
const STATUS = ['open', 'fixed', 'verified', 'class_closed'];
const SWEEP = ['done', 'partial', 'not_done'];
const NOT_MECHANISM =
  /forgot|careless|oversight|did not notice|human error|忘了|粗心|没注意|疏忽|大意/i;
const TEST_FILE = /^(test|eval\/__tests__)\/[\w.-]+\.test\.mjs$/;

/** `path::name` resolves when the file exists and names it (a test title, an R-xx row, a definition). */
const resolves = (ref) => {
  const [path, name] = ref.split('::');
  if (!existsSync(join(ROOT, path))) return false;
  if (!name) return true;
  const text = read(path);
  if (/^R-\d+$/.test(name)) return new RegExp(`^\\|\\s*${name}\\s*\\|`, 'm').test(text);
  return text.includes(name);
};
const rcCounts = () => {
  const c = {};
  for (const f of FINDINGS) for (const r of f.rc) c[r] = (c[r] ?? 0) + 1;
  return c;
};

describe('findings ledger gate', () => {
  test('the taxonomy lock equals the canonical taxonomy (when the canonical copy is present)', (t) => {
    if (!existsSync(CANON)) return t.skip('canonical taxonomy lives outside this repository');
    const h = (b) => createHash('sha256').update(b).digest('hex');
    assert.equal(
      h(readFileSync(CANON)),
      h(readFileSync(join(ROOT, 'findings/taxonomy.lock.yaml'))),
      'the standard changed: re-lock after its decision and reclassify',
    );
  });
  test('ids are unique', () => {
    assert.equal(IDS.size, FINDINGS.length);
  });
  for (const f of FINDINGS)
    test(`${f.id ?? '?'} is complete, classified and honest about its state`, () => {
      const required =
        f.status === 'open'
          ? REQUIRED.filter((k) => !['instance_fix', 'guard'].includes(k))
          : REQUIRED;
      const missing = required.filter(
        (k) =>
          f[k] === undefined ||
          f[k] === null ||
          f[k] === '' ||
          (Array.isArray(f[k]) && f[k].length === 0),
      );
      assert.deepEqual(missing, [], 'missing fields');
      assert.match(f.id, /^F-\d{2,}$/);
      assert.ok(FOUND_BY.includes(f.found_by), f.found_by);
      assert.ok(STATUS.includes(f.status), f.status);
      assert.ok(SWEEP.includes(f.sweep_status), f.sweep_status);
      assert.ok(Array.isArray(f.why) && f.why.length >= 2, 'why-chain needs at least two steps');
      assert.doesNotMatch(f.root_cause, NOT_MECHANISM, 'the root cause stops at a person (§14.3)');
      assert.ok(f.introduced_in === 'unknown' || /^[0-9a-f]{7,40}$/.test(f.introduced_in));
      for (const [key, prefix] of [
        ['dt', 'DT-'],
        ['rc', 'RC-'],
        ['es', 'ES-'],
      ])
        for (const c of f[key]) assert.ok(c.startsWith(prefix) && CODES.has(c), `${f.id}: ${c}`);
      if (f.status !== 'open')
        assert.match(f.instance_fix, /\b[0-9a-f]{7}\b|this commit/, 'closed without a commit');
      if (f.status === 'class_closed') {
        assert.ok(f.class_fix, 'class_closed needs a class fix');
        assert.equal(f.sweep_status, 'done', 'class_closed needs a finished sweep');
      }
      if (f.sweep_status !== 'done' && f.status !== 'open') {
        const follow = [...f.sweep.matchAll(/F-\d{2,}/g)]
          .map((m) => m[0])
          .filter((x) => x !== f.id);
        assert.ok(
          follow.some((x) => IDS.has(x)) || /no follow-up needed:/.test(f.sweep),
          'an unfinished sweep needs a follow-up finding',
        );
      }
      if (f.guard && f.guard.includes('/'))
        assert.ok(resolves(f.guard), `guard does not resolve: ${f.guard}`);
    });
  test('every root-cause class seen twice has a class mechanism with a detector that runs', () => {
    for (const [rc, n] of Object.entries(rcCounts())) {
      if (n < 2) continue;
      const m = LEDGER.class_mechanisms?.[rc];
      assert.ok(m && m.refs.length > 0, `${rc} occurs ${n} times and has no class mechanism`);
      const detectors = m.refs.filter((r) => r.kind === 'detector');
      assert.ok(
        detectors.some((r) => TEST_FILE.test(r.ref.split('::')[0]) && resolves(r.ref)),
        `${rc}: no detector that the test suite runs`,
      );
    }
  });
  test('every class-mechanism reference resolves', () => {
    for (const [rc, m] of Object.entries(LEDGER.class_mechanisms ?? {}))
      for (const r of m.refs) assert.ok(resolves(r.ref), `${rc}: ${r.ref}`);
  });
  test('every class or pattern seen three times has a stop-line review', () => {
    const reviews = readdirSync(join(ROOT, 'findings/reviews'))
      .map((f) => read(join('findings/reviews', f)))
      .join('\n');
    const patterns = {};
    for (const f of FINDINGS) if (f.pattern) patterns[f.pattern] = (patterns[f.pattern] ?? 0) + 1;
    for (const [key, n] of [...Object.entries(rcCounts()), ...Object.entries(patterns)])
      if (n >= 3)
        assert.ok(reviews.includes(key), `${key} occurs ${n} times: write the stop-line review`);
  });
});
