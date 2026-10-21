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
  // Never skipped: the certificate engine treats a skipped test as a hole
  // (a clone without the shared standard beside it is the normal case).
  test('the taxonomy lock is well-formed, and equals the canonical taxonomy wherever that is present', () => {
    for (const prefix of ['DT-', 'RC-', 'ES-'])
      assert.ok(
        [...CODES].some((c) => c.startsWith(prefix)),
        `the lock defines no ${prefix} codes`,
      );
    if (!existsSync(CANON)) return;
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
      // worktree: caught before it was committed (by review or a gate) — standard §14.7
      assert.ok(
        ['unknown', 'worktree'].includes(f.introduced_in) ||
          /^[0-9a-f]{7,40}$/.test(f.introduced_in),
      );
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

/**
 * Self-evolution gate (docs/SELF_EVOLUTION.md). The ledger only prevents
 * what a developer can find before building (`areas` → `npm run brief`), and
 * it only evolves if every escape past an existing class detector says why
 * the detector missed it and what now catches that shape.
 */
const REGISTRY = JSON.parse(read('findings/classes.json'));
const num = (id) => Number(id.slice(2));
/** The classes whose detector already existed when this finding was logged. */
const escapedPast = (f, mechanisms = LEDGER.class_mechanisms ?? {}) =>
  f.rc.filter((rc) =>
    (mechanisms[rc]?.refs ?? []).some((r) => r.kind === 'detector' && num(r.since) < num(f.id)),
  );

describe('self-evolution gate', () => {
  test('every finding names the code areas it is about, and they exist', () => {
    for (const f of FINDINGS) {
      assert.ok(Array.isArray(f.areas) && f.areas.length > 0, `${f.id}: areas`);
      for (const a of f.areas)
        assert.ok(existsSync(join(ROOT, a)), `${f.id}: area ${a} does not exist`);
    }
  });
  test('every class-mechanism reference says since which finding it existed', () => {
    for (const [rc, m] of Object.entries(LEDGER.class_mechanisms ?? {}))
      for (const r of m.refs) {
        assert.match(String(r.since), /^F-\d{2,}$/, `${rc}: ${r.ref} has no since`);
        assert.ok(
          num(r.since) <= Math.max(...FINDINGS.map((f) => num(f.id))),
          `${rc}: since ${r.since}`,
        );
      }
  });
  test('control: the escape rule sees a known escape and a known first occurrence', () => {
    const byId = Object.fromEntries(FINDINGS.map((f) => [f.id, f]));
    assert.deepEqual(escapedPast(byId['F-65']), ['RC-01'], 'F-65 slipped past the RC-01 detectors');
    assert.deepEqual(escapedPast(byId['F-11']), [], 'F-11 came before any RC-03 detector');
  });
  for (const f of FINDINGS)
    test(`${f.id}: an escape past a class detector says why and what now catches it`, () => {
      const esc = escapedPast(f);
      if (esc.length === 0) {
        assert.ok(!('mechanism_gap' in f), 'not an escape: remove mechanism_gap');
        return;
      }
      assert.ok(f.mechanism_gap?.trim(), `escaped past ${esc.join(',')}: mechanism_gap required`);
      assert.doesNotMatch(f.mechanism_gap, NOT_MECHANISM, 'the gap stops at a person (§14.3)');
      const up = f.mechanism_upgrade ?? '';
      assert.ok(
        /^none: .{10,}/.test(up) || (up.includes('::') && resolves(up)),
        `mechanism_upgrade must resolve, or be "none: <reason>" — got ${JSON.stringify(up)}`,
      );
    });
  test('a class whose last two escapes upgraded nothing has a stop-line review naming both (§15.4)', () => {
    const reviews = readdirSync(join(ROOT, 'findings/reviews'))
      .map((f) => read(join('findings/reviews', f)))
      .join('\n');
    for (const rc of Object.keys(rcCounts())) {
      const esc = FINDINGS.filter((f) => escapedPast(f).includes(rc)).sort(
        (a, b) => num(a.id) - num(b.id),
      );
      const last = esc.slice(-2);
      if (last.length === 2 && last.every((f) => String(f.mechanism_upgrade).startsWith('none:')))
        for (const f of last)
          assert.ok(
            reviews.includes(rc) && reviews.includes(f.id),
            `${rc}: escapes ${last.map((x) => x.id).join(', ')} upgraded no check — the stop-line review must name ${f.id}`,
          );
    }
  });
});

/**
 * Problem classes (docs/SELF_EVOLUTION.md). A finding is an instance of one
 * class; a new instance of a known problem is an occurrence of its class —
 * never a renamed new entry. Text similarity cannot tell instances apart
 * (measured 2026-10-17: for 76 of 115 findings the nearest text neighbour is
 * in another class), so the rules are structural: a class is registered
 * with its definition, questions and detectors; a new class must say why it
 * is none of the existing ones and carry an approval; a new finding next to
 * an open one of the same class must say whether it is the same problem.
 */
const BASELINE_LAST = 115; // findings up to here were classified in one pass, together
describe('problem classes', () => {
  const classes = REGISTRY.classes ?? [];
  const byClass = Object.fromEntries(classes.map((c) => [c.id, c]));
  const baseline = new Set(REGISTRY.baseline ?? []);
  test('every finding belongs to exactly one registered class', () => {
    for (const f of FINDINGS)
      assert.ok(byClass[f.class], `${f.id}: class ${f.class} is not in findings/classes.json`);
  });
  test('every class has a definition, a root-cause axis and questions learned from its own findings', () => {
    const qids = new Set();
    for (const c of classes) {
      assert.match(c.id, /^C-\d{2,}$/);
      assert.ok(
        c.name?.trim() && c.definition?.trim().length >= 40,
        `${c.id}: name and definition`,
      );
      assert.ok(CODES.has(c.rc), `${c.id}: rc ${c.rc}`);
      assert.ok(c.questions?.length > 0, `${c.id}: no question to ask before a change`);
      for (const q of c.questions) {
        assert.match(q.id, new RegExp(`^${c.id}\\.\\d+$`), `${c.id}: question id ${q.id}`);
        assert.ok(!qids.has(q.id), `duplicate question id ${q.id}`);
        qids.add(q.id);
        assert.ok(q.ask?.trim().length >= 20, `${q.id}: ask`);
        for (const id of q.learned_from ?? [])
          assert.equal(
            FINDINGS.find((f) => f.id === id)?.class,
            c.id,
            `${q.id}: ${id} is not of ${c.id}`,
          );
      }
    }
  });
  test('a class with two closed findings has a detector the suite runs', () => {
    for (const c of classes) {
      const closed = FINDINGS.filter((f) => f.class === c.id && f.status !== 'open').length;
      if (closed < 2) continue;
      assert.ok(
        (c.detectors ?? []).some((r) => TEST_FILE.test(r.split('::')[0]) && resolves(r)),
        `${c.id} has ${closed} closed findings and no detector that runs`,
      );
    }
    for (const c of classes)
      for (const r of c.detectors ?? []) assert.ok(resolves(r), `${c.id}: ${r}`);
  });
  test('a class added after the baseline says why it is none of the others, and was approved', () => {
    for (const c of classes) {
      if (baseline.has(c.id)) continue;
      for (const o of classes)
        if (o.id !== c.id)
          assert.ok(
            (c.distinct_from?.[o.id] ?? '').trim().length >= 30,
            `${c.id}: say why it is not ${o.id} (${o.name}) — or log the finding under ${o.id}`,
          );
      assert.ok(
        c.approved?.by && c.approved?.on && c.approved?.record,
        `${c.id}: approval {by, on, record}`,
      );
      assert.equal(FINDINGS.find((f) => f.id === c.created_by)?.class, c.id, `${c.id}: created_by`);
    }
  });
  test('a new finding next to an open one of the same class says whether it is the same problem', () => {
    for (const f of FINDINGS) {
      if (num(f.id) <= BASELINE_LAST) continue;
      for (const g of FINDINGS) {
        if (g.id === f.id || g.status !== 'open' || g.class !== f.class) continue;
        if (
          !(g.areas ?? []).some((a) =>
            (f.areas ?? []).some((b) => a === b || a.startsWith(b) || b.startsWith(a)),
          )
        )
          continue;
        assert.ok(
          (f.distinct_from?.[g.id] ?? '').trim().length >= 30,
          `${f.id} is in ${f.class} next to open ${g.id} (${g.title}): if it is the same problem, add the evidence to ${g.id} instead; if not, say why in distinct_from`,
        );
      }
    }
  });
  test('a miss under an answered question names a question of its own class, and why (R4)', () => {
    const qids = new Set(classes.flatMap((c) => c.questions.map((q) => q.id)));
    for (const f of FINDINGS) {
      if (f.answer_failed === undefined) continue;
      const { qid, why } = f.answer_failed ?? {};
      assert.ok(qids.has(qid), `${f.id}: answer_failed.qid ${qid} is not a registered question`);
      assert.ok(
        String(qid).startsWith(`${f.class}.`),
        `${f.id}: ${qid} is not a question of ${f.class}`,
      );
      assert.ok(typeof why === 'string' && why.trim().length >= 20, `${f.id}: answer_failed.why`);
    }
  });
  test('a stopline record releases only its own latest escape, by one named means (R5)', () => {
    for (const c of classes) {
      const s = c.stopline;
      if (s === undefined) continue;
      const esc = FINDINGS.filter((f) => f.class === c.id && f.mechanism_gap).map((f) => f.id);
      assert.ok(
        esc.includes(s.after),
        `${c.id}: stopline.after ${s.after} is not an escape of ${c.id}`,
      );
      const means = ['detector', 'waiver', 'debt'].filter((k) => s[k] !== undefined);
      assert.equal(
        means.length,
        1,
        `${c.id}: stopline names exactly one of detector, waiver, debt`,
      );
      if (s.detector !== undefined) {
        assert.ok(
          (c.detectors ?? []).includes(s.detector),
          `${c.id}: stopline.detector is a class detector`,
        );
        assert.ok(resolves(s.detector), `${c.id}: ${s.detector}`);
      }
      if (s.waiver !== undefined)
        assert.ok(
          s.waiver.by && /^\d{4}-\d{2}-\d{2}$/.test(s.waiver.on) && s.waiver.record?.length >= 20,
          `${c.id}: waiver`,
        );
      if (s.debt !== undefined)
        assert.ok(
          s.debt.plan?.length >= 20 && /^\d{4}-\d{2}-\d{2}$/.test(s.debt.until),
          `${c.id}: debt`,
        );
    }
  });
  test('control: the same-problem rule fires on a planted duplicate', () => {
    const open = FINDINGS.find((f) => f.status === 'open' && f.areas?.length);
    const twin = { ...open, id: 'F-9999', status: 'open', distinct_from: undefined };
    const fires = FINDINGS.some(
      (g) =>
        g.id !== twin.id &&
        g.status === 'open' &&
        g.class === twin.class &&
        (g.areas ?? []).some((a) => twin.areas.includes(a)) &&
        !(twin.distinct_from?.[g.id] ?? ''),
    );
    assert.ok(fires, 'a twin of an open finding must trip the rule');
  });
});
