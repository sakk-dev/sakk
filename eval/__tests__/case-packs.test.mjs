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
import { loadCases, authorizeRealRun } from '../bin/gold-runner.mjs';

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
  test('duplicate entries for one case: any non-PASS wins', () => {
    const r = packReport(pack, [entry('G05', 'FAIL'), entry('G05', 'PASS'), entry('G06', 'PASS')], {
      executorMode: 'REAL',
    });
    assert.equal(r.requirements[0].status, 'NOT_COVERED');
  });
});

describe('C-2: every shipped pack can produce REAL evidence', () => {
  test('a control-plane-only case in a pack is invalid', () => {
    const d = goodPack();
    d.requirements[0].cases = ['G12'];
    expectCode(() => validatePack(d, 'p.json', CASES), 'PACK_INVALID');
  });
  test('each shipped pack passes the real-run case-type gate', () => {
    const auth = join(tdir(), 'a.json');
    writeFileSync(
      auth,
      JSON.stringify({ approved: true, allow_real_model: true, approved_by: 'x' }),
    );
    for (const p of loadAllPacks(CASES)) {
      const gate = authorizeRealRun({
        authorizationPath: auth,
        caseDefs: loadCases(packCaseIds(p).join(',')),
        workRoot: tdir(),
      });
      assert.ok(
        !String(gate.code).startsWith('CASE_NOT_MODEL_EXECUTABLE'),
        `${p.id}: ${gate.code}`,
      );
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
