import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validatePack,
  loadPack,
  loadAllPacks,
  packCaseIds,
  packReport,
  PackError,
} from '../lib/packs.mjs';
import {
  loadCases,
  authorizeRealRun,
  checkArgv,
  realExitCode,
  SUPPORTED_PROVIDERS,
} from '../bin/gold-runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, '..', 'bin', 'gold-runner.mjs');
const CASES = new Map(loadCases().map((c) => [c.id, c]));
const run = (args) =>
  spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', timeout: 300_000 });
const tdir = () => mkdtempSync(join(tmpdir(), 'pack-'));

const goodPack = () => ({
  schema: 'sakk-case-pack.v1',
  id: 'p',
  title: 't',
  regulator: 'r',
  clause_status: 'THEMATIC',
  not_covered: [],
  requirements: [{ id: 'r1', theme: 'x', cases: ['G05'], evidence: 'e', gaps: [] }],
});
const expectCode = (fn, code) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof PackError, e.message);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected ${code}`);
};
const entry = (id, verdict) => ({ caseDef: { id }, result: { verdict } });

describe('C-1: a fake run can never read COVERED', () => {
  const pack = {
    ...goodPack(),
    requirements: [{ ...goodPack().requirements[0], cases: ['G05', 'G06'] }],
  };
  test('FAKE mode → HARNESS_ONLY for every requirement, even when every case passed', () => {
    const r = packReport(pack, [entry('G05', 'PASS'), entry('G06', 'PASS')], {
      executorMode: 'FAKE',
      runId: 'r',
    });
    assert.equal(r.requirements[0].status, 'HARNESS_ONLY');
    assert.equal(r.covered, 0);
    assert.match(r.meaning, /harness chain only/);
  });
  test('the report carries its provenance: mode, run id, harness commit, stop info', () => {
    const r = packReport(pack, [entry('G05', 'PASS')], {
      executorMode: 'REAL',
      runId: 'run-1',
      harnessCommit: 'abc',
      stopped: { at: 'G05', why: 'BUDGET' },
    });
    assert.equal(r.executor_mode, 'REAL');
    assert.equal(r.run_id, 'run-1');
    assert.equal(r.harness_commit, 'abc');
    assert.deepEqual(r.batch_stopped, { at: 'G05', why: 'BUDGET' });
  });
  test('REAL mode: COVERED only when every backing case ran and passed', () => {
    const real = { executorMode: 'REAL', runId: 'r' };
    assert.equal(
      packReport(pack, [entry('G05', 'PASS'), entry('G06', 'PASS')], real).requirements[0].status,
      'COVERED',
    );
    assert.equal(
      packReport(pack, [entry('G05', 'PASS'), entry('G06', 'FAIL')], real).requirements[0].status,
      'NOT_COVERED',
    );
    const notRun = packReport(pack, [entry('G05', 'PASS')], real).requirements[0];
    assert.equal(notRun.status, 'NOT_COVERED');
    assert.equal(notRun.cases[1].verdict, 'NOT_RUN');
  });
  test('duplicate entries for one case: any non-PASS wins, in either order', () => {
    for (const order of [
      ['FAIL', 'PASS'],
      ['PASS', 'FAIL'],
    ]) {
      const r = packReport(
        pack,
        [entry('G05', order[0]), entry('G05', order[1]), entry('G06', 'PASS')],
        { executorMode: 'REAL' },
      );
      assert.equal(r.requirements[0].status, 'NOT_COVERED', order.join(','));
    }
  });
  test('an entry without a verdict shows NO_VERDICT, not NOT_RUN', () => {
    const r = packReport(pack, [{ caseDef: { id: 'G05' }, result: {} }], { executorMode: 'REAL' });
    assert.equal(r.requirements[0].cases[0].verdict, 'NO_VERDICT');
  });
  test('an unknown or mis-cased mode never reads COVERED and never claims to be FAKE', () => {
    for (const executorMode of [undefined, 'real', 'Real']) {
      const r = packReport(pack, [entry('G05', 'PASS'), entry('G06', 'PASS')], { executorMode });
      assert.equal(r.executor_mode, 'UNKNOWN');
      assert.equal(r.covered, 0);
      assert.doesNotMatch(r.meaning, /FAKE/);
    }
  });
  test('review N-1: a REAL report names its model; a FAKE report has none', () => {
    const model = {
      provider: 'anthropic',
      model_id: 'm',
      executor_binary: '/stub',
      binary_overridden: true,
    };
    const real = packReport(pack, [entry('G05', 'PASS')], { executorMode: 'REAL', model });
    assert.deepEqual(real.model, model);
    assert.match(real.meaning, /model named in `model`/);
    const fake = packReport(pack, [entry('G05', 'PASS')], { executorMode: 'FAKE', model });
    assert.equal(fake.model, null);
    assert.equal(fake.not_covered_is_exhaustive, false);
  });
  test('review N-2: a REAL batch that stopped early is never exit 0', () => {
    const pass = [entry('G05', 'PASS')];
    assert.equal(realExitCode({ entries: pass, selected: 1, stopped: null }), 0);
    assert.equal(realExitCode({ entries: pass, selected: 2, stopped: null }), 1);
    assert.equal(realExitCode({ entries: pass, selected: 1, stopped: { at: 'G05' } }), 1);
    assert.equal(realExitCode({ entries: [entry('G05', 'FAIL')], selected: 1, stopped: null }), 1);
  });
});

describe('C-2: every shipped pack can produce REAL evidence', () => {
  test('a control-plane-only case in a pack is invalid', () => {
    const d = goodPack();
    d.requirements[0].cases = ['G12'];
    expectCode(() => validatePack(d, 'p.json', CASES), 'PACK_INVALID');
  });
  // Review N-3: the earlier fixture was refused at MODEL_PROVIDER_UNSUPPORTED
  // before the case-type gate, so this test could not fail. The fixture now
  // passes every gate up to the case loop, and the next refusal (no org
  // ledger) proves the loop was passed; the G12 control proves it is reached.
  const gateFixture = () => {
    const auth = join(tdir(), 'a.json');
    writeFileSync(
      auth,
      JSON.stringify({
        approved: true,
        allow_real_model: true,
        approved_by: 'x',
        model_provider: SUPPORTED_PROVIDERS[0],
        model_id: 'probe-model',
        pilot_total_budget_usd: 1000,
        full_total_budget_usd: 1000,
        default_case_budget_usd: 0.01,
        per_case_hard_cap_usd: 0.01,
        pilot_case_ids: [...CASES.keys()],
      }),
    );
    return auth;
  };
  const gateFor = (ids) => {
    const saved = process.env.SAKK_BUDGET_LEDGER_PATH;
    delete process.env.SAKK_BUDGET_LEDGER_PATH;
    try {
      return authorizeRealRun({
        authorizationPath: gateFixture(),
        caseDefs: loadCases(ids.join(',')),
        workRoot: tdir(),
      });
    } finally {
      if (saved !== undefined) process.env.SAKK_BUDGET_LEDGER_PATH = saved;
    }
  };
  test('control: the fixture reaches the case-type gate (G12 is refused there)', () => {
    assert.equal(gateFor(['G05', 'G12']).code, 'CASE_NOT_MODEL_EXECUTABLE:G12');
  });
  test('each shipped pack passes the real-run case-type gate', () => {
    for (const p of loadAllPacks(CASES))
      assert.match(
        String(gateFor(packCaseIds(p)).code),
        /^AUTHORITATIVE_LEDGER_UNREADABLE/,
        `${p.id}: refused before or at the case loop`,
      );
  });
  test('packs admit execution_mode "model" only (allowlist, not denylist)', () => {
    for (const mode of [undefined, 'Control_Plane_Only', 'agent']) {
      const cases = new Map(CASES);
      cases.set('G05', { ...CASES.get('G05'), execution_mode: mode });
      expectCode(() => validatePack(goodPack(), 'p.json', cases), 'PACK_INVALID');
    }
  });
});

describe('C-3: honesty fields are mandatory', () => {
  test('missing not_covered, or a requirement without gaps, is invalid', () => {
    const a = goodPack();
    delete a.not_covered;
    expectCode(() => validatePack(a, 'p.json', CASES), 'PACK_INVALID');
    const b = goodPack();
    delete b.requirements[0].gaps;
    expectCode(() => validatePack(b, 'p.json', CASES), 'PACK_INVALID');
  });
});

describe('malformed packs refuse with a name', () => {
  test('phantom case ids, empty requirements, empty cases, duplicate case ids', () => {
    const phantom = goodPack();
    phantom.requirements[0].cases = ['G99'];
    expectCode(() => validatePack(phantom, 'p.json', CASES), 'PACK_INVALID');
    const empty = goodPack();
    empty.requirements = [];
    expectCode(() => validatePack(empty, 'p.json', CASES), 'PACK_INVALID');
    const noCases = goodPack();
    noCases.requirements[0].cases = [];
    expectCode(() => validatePack(noCases, 'p.json', CASES), 'PACK_INVALID');
    const dupCase = goodPack();
    dupCase.requirements[0].cases = ['G05', 'G05'];
    expectCode(() => validatePack(dupCase, 'p.json', CASES), 'PACK_INVALID');
  });
  test('unknown keys, wrong schema, id/file mismatch, duplicate requirement ids', () => {
    expectCode(() => validatePack({ ...goodPack(), extra: 1 }, 'p.json', CASES), 'PACK_INVALID');
    expectCode(
      () => validatePack({ ...goodPack(), schema: 'nope' }, 'p.json', CASES),
      'PACK_INVALID',
    );
    expectCode(() => validatePack(goodPack(), 'other.json', CASES), 'PACK_INVALID');
    const dup = goodPack();
    dup.requirements.push({ ...dup.requirements[0] });
    expectCode(() => validatePack(dup, 'p.json', CASES), 'PACK_INVALID');
  });
  test('loadAllPacks reports EVERY broken pack, including unparsable JSON with its file name', () => {
    const d = tdir();
    writeFileSync(join(d, 'broken.json'), '{nope');
    writeFileSync(join(d, 'p.json'), JSON.stringify({ ...goodPack(), schema: 'nope' }));
    const e = expectCode(() => loadAllPacks(CASES, d), 'PACK_INVALID');
    assert.match(e.message, /broken\.json/);
    assert.match(e.message, /p\.json/);
    assert.equal(e.message.match(/PACK_INVALID/g).length, 1, 'one prefix, not one per pack');
  });
});

describe('selection is a whitelist', () => {
  test('traversal, empty, suffixed, flag-shaped and prototype ids all refuse PACK_UNKNOWN', () => {
    for (const id of [
      '../cases/G01',
      '',
      'dora-ict-change.json',
      '--x',
      '__proto__',
      'constructor',
      ' dora-ict-change',
    ])
      expectCode(() => loadPack(id, CASES), 'PACK_UNKNOWN');
  });
});

describe('runner CLI', () => {
  test('--pack runs exactly the pack cases; a fake run reports HARNESS_ONLY with its mode', () => {
    const out = join(tdir(), 'o');
    const r = run(['--fake-executor', '--pack', 'dora-ict-change', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(readFileSync(join(out, 'pack-report.json'), 'utf8'));
    assert.equal(report.executor_mode, 'FAKE');
    assert.equal(report.covered, 0);
    assert.ok(report.requirements.every((x) => x.status === 'HARNESS_ONLY'));
    assert.match(r.stdout, /mode FAKE/);
    const ran = r.stdout
      .match(/^G\d\d:/gm)
      .map((x) => x.slice(0, 3))
      .sort();
    assert.deepEqual(ran, packCaseIds(loadPack('dora-ict-change', CASES)));
  });
  test('unknown --pack exits 2; --case with --pack exits 2; --pack=x exits 2 instead of running everything', () => {
    assert.match(run(['--dry-run', '--pack', 'typo-pack']).stderr, /PACK_UNKNOWN/);
    const both = run(['--dry-run', '--case', 'G01', '--pack', 'dora-ict-change']);
    assert.equal(both.status, 2);
    assert.match(both.stderr, /SELECTOR_CONFLICT/);
    const eq = run(['--dry-run', '--pack=dora-ict-change']);
    assert.equal(eq.status, 2);
    assert.match(eq.stderr, /USAGE_EQUALS_FORM/);
  });
  test('--validate checks every shipped pack and reports packs_ok', () => {
    const r = run(['--validate']);
    assert.equal(r.status, 0, r.stdout);
    assert.match(
      r.stdout,
      /packs: OK \(cbuae-ai-oversight, difc-data-protection, dora-ict-change\)/,
    );
    assert.match(r.stdout, /"packs_ok":true/);
  });
});

describe('review N-4: the runner refuses arguments it does not know', () => {
  test('checkArgv: unknown, single-dash, positional, repeated, missing value, two modes', () => {
    for (const [args, code] of [
      [['--fake-executor', '--packs', 'dora-ict-change'], 'USAGE_UNKNOWN_ARGUMENT'],
      [['--dry-run', '--Pack', 'x'], 'USAGE_UNKNOWN_ARGUMENT'],
      [['--dry-run', '-pack=x'], 'USAGE_UNKNOWN_ARGUMENT'],
      [['--dry-run', 'dora-ict-change'], 'USAGE_UNKNOWN_ARGUMENT'],
      [['--dry-run', '--pack', 'a', '--pack', 'b'], 'USAGE_REPEATED_FLAG'],
      [['--dry-run', '--pack'], 'USAGE_MISSING_VALUE'],
      [['--dry-run', '--case', '--pack', 'x'], 'USAGE_MISSING_VALUE'],
      [['--fake-executor', '--real'], 'USAGE_MODE_CONFLICT'],
      [['--dry-run', '--pack=x'], 'USAGE_EQUALS_FORM'],
    ])
      assert.throws(
        () => checkArgv(args),
        (e) => e.message.startsWith(code),
        args.join(' '),
      );
    checkArgv(['--fake-executor', '--pack', 'dora-ict-change', '--out', '/tmp/x']);
  });
  test('a misspelled selector exits 2 instead of running every case', () => {
    const r = run(['--fake-executor', '--packs', 'cbuae-ai-oversight', '--out', join(tdir(), 'o')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /USAGE_UNKNOWN_ARGUMENT/);
    assert.doesNotMatch(r.stdout, /^G\d\d:/m, 'no case ran');
  });
});

describe('review N-5: documented pack coverage matches the packs', () => {
  test('eval/README states the true number of cases that appear in packs', () => {
    const union = new Set(loadAllPacks(CASES).flatMap((p) => packCaseIds(p)));
    const readme = readFileSync(join(HERE, '..', 'README.md'), 'utf8');
    const m = readme.match(/\((\d+) of the\s+(\d+) cases appear/);
    assert.ok(m, 'the README states the count');
    assert.equal(Number(m[1]), union.size);
    assert.equal(Number(m[2]), CASES.size);
    const absent = [...CASES.keys()].filter((id) => !union.has(id));
    for (const id of absent)
      assert.match(readme, new RegExp(`\\b${id}\\b`), `${id} named as absent`);
  });
});
