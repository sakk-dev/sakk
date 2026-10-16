import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from '../scripts/evidence-bundle.mjs';
import { verifyBundle } from '../eval/lib/bundle-verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, '..', 'eval', 'bin', 'gold-runner.mjs');
const tdir = () => mkdtempSync(join(tmpdir(), 'evb-'));

let RUN; // one real fake-executor run shared by the suite
let PRISTINE; // an unpacked, verified bundle every test copies from

const unpack = (tgz) => {
  const d = tdir();
  execFileSync('tar', ['-xzf', tgz, '-C', d]);
  return join(d, readdirSync(d)[0]);
};
const copyOf = (dir) => {
  const d = join(tdir(), 'b');
  cpSync(dir, d, { recursive: true });
  return d;
};
/** A forger who edits files AND regenerates the manifest — integrity then
 * passes, so only the cross-file consistency checks can catch it. */
const reManifest = (b) => {
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n !== 'MANIFEST.sha256') files.push(relative(b, p));
    }
  };
  walk(b);
  const lines = files.sort().map(
    (f) =>
      `${createHash('sha256')
        .update(readFileSync(join(b, f)))
        .digest('hex')}  ${f}`,
  );
  writeFileSync(join(b, 'MANIFEST.sha256'), `${lines.join('\n')}\n`);
};
const editJson = (b, rel, fn) => {
  const p = join(b, rel);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  fn(j);
  writeFileSync(p, JSON.stringify(j));
};
const codes = (b) => verifyBundle(b).problems.map((p) => p.code);
const gaps = (b) => verifyBundle(b).incomplete.map((p) => p.code);
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const forge = (b, rel, fn) => {
  editJson(b, rel, fn);
  reManifest(b);
  return codes(b);
};
const hasShasum = spawnSync('shasum', ['--version']).status === 0;
/** A complete pack report (every key packReport writes); a test overrides what it forges. */
const packReportDoc = (b, over = {}) => {
  const meta = JSON.parse(readFileSync(join(b, 'bundle.json'), 'utf8'));
  const metrics = JSON.parse(readFileSync(join(b, 'run/metrics.json'), 'utf8'));
  return {
    pack: 'p',
    title: 't',
    regulator: 'r',
    clause_status: 'c',
    executor_mode: meta.executorMode,
    meaning: 'm',
    model: null,
    run_id: meta.runId,
    harness_commit: meta.harnessCommit,
    harness_dirty: metrics.harness_dirty,
    batch_stopped: metrics.stopped,
    covered: 0,
    total: 1,
    not_covered: [],
    not_covered_is_exhaustive: false,
    requirements: [
      {
        id: 'r',
        theme: 't',
        gaps: [],
        status: 'HARNESS_ONLY',
        cases: [{ case: 'G05', verdict: 'PASS' }],
      },
    ],
    ...over,
  };
};

before(() => {
  RUN = join(tdir(), 'run');
  const r = spawnSync(process.execPath, [RUNNER, '--fake-executor', '--out', RUN], {
    encoding: 'utf8',
    timeout: 300_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const tgz = join(tdir(), 'b.tgz');
  buildBundle({ source: RUN, to: tgz });
  PRISTINE = unpack(tgz);
});

describe('the bundle stands alone', () => {
  test('unpacked anywhere, `node verify.mjs` passes with no repository present', () => {
    const away = copyOf(PRISTINE);
    const r = spawnSync(process.execPath, ['verify.mjs'], { cwd: away, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /VERIFY PASS/);
    assert.match(r.stdout, /bundle fingerprint: [0-9a-f]{64}/);
  });
});

describe('integrity: any edit, addition or removal is caught', () => {
  test('one changed byte in a result → FILE_MODIFIED naming the file', () => {
    const b = copyOf(PRISTINE);
    writeFileSync(
      join(b, 'run/G06/result.json'),
      `${readFileSync(join(b, 'run/G06/result.json'), 'utf8')} `,
    );
    const p = verifyBundle(b).problems;
    assert.ok(p.some((x) => x.code === 'FILE_MODIFIED' && x.detail === 'run/G06/result.json'));
  });
  test('an added file → FILE_NOT_IN_MANIFEST; a removed file → FILE_MISSING', () => {
    const b = copyOf(PRISTINE);
    writeFileSync(join(b, 'run/extra.txt'), 'planted');
    rmSync(join(b, 'run/G01/trace.json'));
    const c = codes(b);
    assert.ok(c.includes('FILE_NOT_IN_MANIFEST'));
    assert.ok(c.includes('FILE_MISSING'));
  });
});

describe('consistency: a forger who also rewrites the manifest is still caught', () => {
  test('inflated pass rate in metrics.json → METRIC_MISMATCH', () => {
    const b = copyOf(PRISTINE);
    editJson(b, 'run/G05/result.json', (r) => {
      r.verdict = 'FAIL';
      r.violations = [{ rule: 'UNAUTHORIZED_WRITE', detail: 'x' }];
    });
    reManifest(b); // metrics.json still claims 100% — the files now say otherwise
    const c = codes(b);
    assert.ok(!c.includes('FILE_MODIFIED'), 'integrity passes for the forger');
    assert.ok(c.includes('METRIC_MISMATCH'));
  });
  test('a PASS verdict carrying violations → VERDICT_VIOLATION_MISMATCH', () => {
    const b = copyOf(PRISTINE);
    editJson(b, 'run/G07/result.json', (r) => {
      r.violations = [{ rule: 'SECRET_LEAK', detail: 'canary' }];
    });
    reManifest(b);
    assert.ok(codes(b).includes('VERDICT_VIOLATION_MISMATCH'));
  });
  test('a hidden cost (trace says 0, ledger settled money) → COST_MISMATCH', () => {
    const b = copyOf(PRISTINE);
    editJson(b, 'run/G12/trace.json', (t) => {
      t.actual_cost_usd = 0;
    });
    reManifest(b);
    assert.ok(codes(b).includes('COST_MISMATCH'));
  });
  test('a case from another run or another commit → RUN_ID_MISMATCH / COMMIT_MISMATCH', () => {
    const b = copyOf(PRISTINE);
    editJson(b, 'run/G02/trace.json', (t) => {
      t.run_id = 'gold-fake-someotherrun';
      t.git_commit = 'f'.repeat(40);
    });
    reManifest(b);
    const c = codes(b);
    assert.ok(c.includes('RUN_ID_MISMATCH'));
    assert.ok(c.includes('COMMIT_MISMATCH'));
  });
  test('a pack report claiming COVERED over a failed case → PACK_STATUS_MISMATCH', () => {
    const b = copyOf(PRISTINE);
    editJson(b, 'run/G06/result.json', (r) => {
      r.verdict = 'FAIL';
      r.violations = [{ rule: 'X', detail: 'y' }];
    });
    writeFileSync(
      join(b, 'run/pack-report.json'),
      JSON.stringify({
        requirements: [{ id: 'oversight', status: 'COVERED', cases: [{ case: 'G06' }] }],
      }),
    );
    reManifest(b);
    assert.ok(codes(b).includes('PACK_STATUS_MISMATCH'));
  });
});

describe('building refuses rather than ships something unverifiable', () => {
  test('target exists / source is not a run → typed refusals, nothing written', () => {
    const exists = join(tdir(), 'x.tgz');
    writeFileSync(exists, 'keep me');
    assert.throws(
      () => buildBundle({ source: RUN, to: exists }),
      (e) => e.code === 'BUNDLE_TARGET_EXISTS',
    );
    assert.equal(readFileSync(exists, 'utf8'), 'keep me');
    assert.throws(
      () => buildBundle({ source: tdir(), to: join(tdir(), 'y.tgz') }),
      (e) => e.code === 'BUNDLE_SOURCE_INVALID',
    );
  });
  test('a source mixing two runs → BUNDLE_SOURCE_INVALID (one bundle, one run)', () => {
    const mixed = join(tdir(), 'mixed');
    cpSync(RUN, mixed, { recursive: true });
    const t = JSON.parse(readFileSync(join(mixed, 'G03', 'trace.json'), 'utf8'));
    t.run_id = 'gold-fake-different';
    writeFileSync(join(mixed, 'G03', 'trace.json'), JSON.stringify(t));
    assert.throws(
      () => buildBundle({ source: mixed, to: join(tdir(), 'm.tgz') }),
      (e) => e.code === 'BUNDLE_SOURCE_INVALID',
    );
  });
  test('a source the verifier rejects is never shipped → BUNDLE_SELF_CHECK_FAILED', () => {
    const lying = join(tdir(), 'lying');
    cpSync(RUN, lying, { recursive: true });
    const m = JSON.parse(readFileSync(join(lying, 'metrics.json'), 'utf8'));
    m.metrics.secret_leak_count = 0;
    m.metrics.case_pass_rate = 0.5; // the files say 1.0
    writeFileSync(join(lying, 'metrics.json'), JSON.stringify(m));
    const to = join(tdir(), 'l.tgz');
    assert.throws(
      () => buildBundle({ source: lying, to }),
      (e) => e.code === 'BUNDLE_SELF_CHECK_FAILED',
    );
    assert.equal(spawnSync('test', ['-e', to]).status, 1, 'no bundle file was written');
  });
});

describe('review B1: falsy or non-object JSON is a failure, never a skipped check', () => {
  for (const planted of ['null', '0', 'false', '[]', '"x"']) {
    test(`run/G05/result.json = ${planted} → CASE_FILE_INVALID + METRICS_UNVERIFIABLE`, () => {
      const b = copyOf(PRISTINE);
      writeFileSync(join(b, 'run/G05/result.json'), planted);
      reManifest(b);
      const r = verifyBundle(b);
      assert.equal(r.ok, false);
      const c = r.problems.map((p) => p.code);
      assert.ok(c.includes('CASE_FILE_INVALID'), c.join());
      assert.ok(c.includes('METRICS_UNVERIFIABLE'), c.join());
    });
  }
  test('metrics.json = null → METRICS_UNVERIFIABLE', () => {
    const b = copyOf(PRISTINE);
    writeFileSync(join(b, 'run/metrics.json'), 'null');
    reManifest(b);
    assert.ok(codes(b).includes('METRICS_UNVERIFIABLE'));
  });
  test('ill-typed fields are named problems, and the verifier never throws', () => {
    for (const [rel, fn] of [
      ['run/G03/result.json', (r) => (r.violations = 'none')],
      ['run/G03/trace.json', (t) => (t.actual_cost_usd = '0')],
      ['run/G03/trace.json', (t) => delete t.state_transitions],
      ['run/G03/ledger.json', (l) => (l.entries = [{ status: 'SETTLED' }])],
    ]) {
      const b = copyOf(PRISTINE);
      const c = forge(b, rel, fn);
      const want = rel.endsWith('ledger.json') ? 'LEDGER_INVALID' : 'CASE_FILE_INVALID';
      assert.ok(c.includes(want), `${rel}: ${c.join()}`);
    }
  });
  test('a case without its ledger.json → CASE_FILE_INVALID (cost cannot be checked)', () => {
    const b = copyOf(PRISTINE);
    rmSync(join(b, 'run/G04/ledger.json'));
    reManifest(b);
    assert.ok(codes(b).includes('CASE_FILE_INVALID'));
  });
});

describe('review B2: the auditor can check the bundle without running its code', () => {
  test('the fingerprint is exactly sha256(MANIFEST.sha256)', () => {
    const fp = createHash('sha256')
      .update(readFileSync(join(PRISTINE, 'MANIFEST.sha256')))
      .digest('hex');
    assert.equal(verifyBundle(PRISTINE).fingerprint, fp);
  });
  test(
    '`shasum -a 256 -c MANIFEST.sha256` passes on a pristine bundle and fails on a swapped verify.mjs',
    { skip: !hasShasum },
    () => {
      const ok = spawnSync('shasum', ['-a', '256', '-c', 'MANIFEST.sha256'], {
        cwd: PRISTINE,
        encoding: 'utf8',
      });
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      const b = copyOf(PRISTINE);
      writeFileSync(join(b, 'verify.mjs'), 'console.log("VERIFY PASS"); process.exit(0);\n');
      assert.notEqual(
        spawnSync('shasum', ['-a', '256', '-c', 'MANIFEST.sha256'], { cwd: b }).status,
        0,
      );
    },
  );
  test('the bundle README orders the independent checks BEFORE running verify.mjs', () => {
    const readme = readFileSync(join(PRISTINE, 'README.md'), 'utf8');
    const fp = readme.indexOf('shasum -a 256 MANIFEST.sha256');
    const all = readme.indexOf('shasum -a 256 -c MANIFEST.sha256');
    const run = readme.indexOf('node verify.mjs');
    assert.ok(fp > 0 && all > fp && run > all, 'fingerprint → manifest check → run');
    assert.match(readme, /What a PASS does not show/);
    assert.match(readme, /secrets/);
  });
});

describe('review B3: links and archives', () => {
  test('a symlink in the run directory → BUNDLE_SOURCE_INVALID, nothing written', () => {
    const src = join(tdir(), 'run');
    cpSync(RUN, src, { recursive: true });
    symlinkSync('/etc/hosts', join(src, 'G01', 'evidence.log'));
    const to = join(tdir(), 's.tgz');
    assert.throws(
      () => buildBundle({ source: src, to }),
      (e) => e.code === 'BUNDLE_SOURCE_INVALID' && /evidence\.log/.test(e.message),
    );
    assert.equal(spawnSync('test', ['-e', to]).status, 1);
  });
  test('a symlink planted in an unpacked bundle → NOT_A_REGULAR_FILE (never followed)', () => {
    const b = copyOf(PRISTINE);
    symlinkSync('/etc/hosts', join(b, 'run', 'planted.log'));
    assert.ok(codes(b).includes('NOT_A_REGULAR_FILE'));
  });
  test('a successful build leaves exactly the target — no partial files beside it', () => {
    const dir = tdir();
    buildBundle({ source: RUN, to: join(dir, 'ok.tgz') });
    assert.deepEqual(readdirSync(dir), ['ok.tgz']);
  });
  test('the archive lists one top-level directory and no absolute or parent paths', () => {
    const dir = tdir();
    buildBundle({ source: RUN, to: join(dir, 'ok.tgz') });
    const names = execFileSync('tar', ['-tzf', join(dir, 'ok.tgz')], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    const tops = new Set(names.map((n) => n.split('/')[0]));
    assert.equal(tops.size, 1);
    assert.ok(names.every((n) => !n.startsWith('/') && !n.split('/').includes('..')));
  });
});

describe('review B4: the claims in the README are the checks in the code', () => {
  for (const [field, value] of [
    ['first_pass_yield', 0.123],
    ['cost_per_case', 9],
    ['p95_duration_ms', 1],
    ['p50_duration_ms', 1],
    ['model_eligible_case_count', 12],
    ['control_plane_case_count', 0],
    ['fake_executor_case_pass_rate', null],
  ])
    test(`a forged ${field} → METRIC_MISMATCH`, () => {
      const b = copyOf(PRISTINE);
      assert.ok(
        forge(b, 'run/metrics.json', (m) => (m.metrics[field] = value)).includes('METRIC_MISMATCH'),
      );
    });
  test('metrics and bundle.json relabelled REAL while the traces still say FAKE → MODE_MISMATCH', () => {
    const b = copyOf(PRISTINE);
    editJson(b, 'run/metrics.json', (m) => {
      m.metrics.executor_mode = 'REAL';
      m.metrics.real_model_case_pass_rate = 1;
      m.metrics.real_model_case_status = 'RUN';
      m.metrics.real_model_called = true;
      m.metrics.fake_executor_case_pass_rate = null;
    });
    const c = forge(b, 'bundle.json', (x) => (x.executorMode = 'REAL'));
    assert.ok(c.includes('MODE_MISMATCH'), c.join());
  });
  test('metrics.json from another run → RUN_ID_MISMATCH', () => {
    const b = copyOf(PRISTINE);
    assert.ok(
      forge(b, 'run/metrics.json', (m) => (m.runId = 'gold-fake-other')).includes(
        'RUN_ID_MISMATCH',
      ),
    );
  });
  test('case list and case directories must agree → CASE_SET_MISMATCH', () => {
    const b = copyOf(PRISTINE);
    assert.ok(forge(b, 'bundle.json', (x) => x.cases.pop()).includes('CASE_SET_MISMATCH'));
    const c = copyOf(PRISTINE);
    assert.ok(forge(c, 'bundle.json', (x) => x.cases.push('G99')).includes('CASE_SET_MISMATCH'));
  });
  test('a traversal case id in bundle.json is refused, not read', () => {
    const b = copyOf(PRISTINE);
    assert.ok(
      forge(b, 'bundle.json', (x) => x.cases.push('../../etc')).includes('BUNDLE_META_INVALID'),
    );
  });
  test('a pack report may not read COVERED in a FAKE bundle → PACK_STATUS_MISMATCH', () => {
    const b = copyOf(PRISTINE);
    const runId = JSON.parse(readFileSync(join(b, 'bundle.json'), 'utf8')).runId;
    writeFileSync(
      join(b, 'run/pack-report.json'),
      JSON.stringify({
        executor_mode: 'FAKE',
        run_id: runId,
        covered: 1,
        requirements: [{ id: 'r', status: 'COVERED', cases: [{ case: 'G05' }] }],
      }),
    );
    reManifest(b);
    assert.ok(codes(b).includes('PACK_STATUS_MISMATCH'));
  });
});

describe("building: case definitions come from the run's own commit", () => {
  test('a commit this repository does not have → BUNDLE_SOURCE_INVALID', () => {
    const src = join(tdir(), 'run');
    cpSync(RUN, src, { recursive: true });
    for (const id of readdirSync(src).filter((d) => /^G\d+$/.test(d))) {
      const p = join(src, id, 'trace.json');
      const t = JSON.parse(readFileSync(p, 'utf8'));
      t.git_commit = 'e'.repeat(40);
      writeFileSync(p, JSON.stringify(t));
    }
    assert.throws(
      () => buildBundle({ source: src, to: join(tdir(), 'c.tgz') }),
      (e) => e.code === 'BUNDLE_SOURCE_INVALID' && /harness commit/.test(e.message),
    );
  });
  test("the bundled case definitions are byte-identical to the commit's", () => {
    const meta = JSON.parse(readFileSync(join(PRISTINE, 'bundle.json'), 'utf8'));
    for (const id of meta.cases)
      assert.equal(
        readFileSync(join(PRISTINE, 'cases', `${id}.json`), 'utf8'),
        execFileSync('git', ['show', `${meta.harnessCommit}:eval/cases/${id}.json`], {
          cwd: join(HERE, '..'),
          encoding: 'utf8',
        }),
      );
  });
  test('a run id that is not a plain name → BUNDLE_SOURCE_INVALID', () => {
    const src = join(tdir(), 'run');
    cpSync(RUN, src, { recursive: true });
    for (const id of readdirSync(src).filter((d) => /^G\d+$/.test(d))) {
      const p = join(src, id, 'trace.json');
      const t = JSON.parse(readFileSync(p, 'utf8'));
      t.run_id = '../escape';
      writeFileSync(p, JSON.stringify(t));
    }
    assert.throws(
      () => buildBundle({ source: src, to: join(tdir(), 'r.tgz') }),
      (e) => e.code === 'BUNDLE_SOURCE_INVALID',
    );
  });
});

describe('verify pass N1: unresolved spend is never a PASS', () => {
  const unresolved = (b) => {
    editJson(b, 'run/G03/ledger.json', (l) => {
      l.flags = {
        reconciliationRequired: true,
        reason: 'call x failed with unknowable actual cost',
      };
      l.entries.push({
        callId: 'x',
        runId: null,
        taskId: null,
        agentId: null,
        estimatedMaxUsd: 1.9,
        createdAt: new Date().toISOString(),
        status: 'RECONCILIATION_REQUIRED',
      });
    });
    editJson(b, 'run/G03/trace.json', (t) => {
      t.cost_known = false;
      t.tool_calls.push({ kind: 'paid_step', callId: 'x', reservedUsd: 1.9 });
    });
    reManifest(b);
  };
  test('a reconciliation flag / unknown cost → INCOMPLETE with SPEND_UNRESOLVED, CLI exit 3', () => {
    const b = copyOf(PRISTINE);
    unresolved(b);
    const r = verifyBundle(b);
    assert.equal(r.status, 'INCOMPLETE');
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems, []);
    assert.ok(r.incomplete.some((p) => p.code === 'SPEND_UNRESOLVED'));
    const cli = spawnSync(process.execPath, ['verify.mjs'], { cwd: b, encoding: 'utf8' });
    assert.equal(cli.status, 3, cli.stdout);
    assert.match(cli.stdout, /VERIFY INCOMPLETE/);
  });
  test('a RESERVED entry left open is unresolved spend too', () => {
    const b = copyOf(PRISTINE);
    editJson(b, 'run/G04/ledger.json', (l) =>
      l.entries.push({ callId: 'open', estimatedMaxUsd: 1, createdAt: 'x', status: 'RESERVED' }),
    );
    reManifest(b);
    assert.ok(gaps(b).includes('SPEND_UNRESOLVED'));
  });
  test('a stopped batch → BATCH_STOPPED; a selected case that never ran → CASES_NOT_RUN', () => {
    const b = copyOf(PRISTINE);
    editJson(b, 'run/metrics.json', (m) => {
      m.stopped = { at: 'G12', why: 'COST_UNKNOWN_RECONCILIATION_REQUIRED' };
      m.selected_cases.push('G13');
    });
    reManifest(b);
    const g = gaps(b);
    assert.ok(g.includes('BATCH_STOPPED') && g.includes('CASES_NOT_RUN'), g.join());
  });
  test('an INCOMPLETE run still builds — labelled, never PASS', () => {
    const src = join(tdir(), 'run');
    cpSync(RUN, src, { recursive: true });
    const m = JSON.parse(readFileSync(join(src, 'metrics.json'), 'utf8'));
    m.stopped = { at: 'G12', why: 'BUDGET' };
    writeFileSync(join(src, 'metrics.json'), JSON.stringify(m));
    const r = buildBundle({ source: src, to: join(tdir(), 'i.tgz') });
    assert.equal(r.status, 'INCOMPLETE');
    const b = unpack(r.to);
    assert.match(readFileSync(join(b, 'README.md'), 'utf8'), /INCOMPLETE run/);
    assert.equal(verifyBundle(b).status, 'INCOMPLETE');
  });
  test('a run dir from an older runner (no selected_cases/stopped) is refused at build', () => {
    const src = join(tdir(), 'run');
    cpSync(RUN, src, { recursive: true });
    const m = JSON.parse(readFileSync(join(src, 'metrics.json'), 'utf8'));
    delete m.selected_cases;
    writeFileSync(join(src, 'metrics.json'), JSON.stringify(m));
    assert.throws(
      () => buildBundle({ source: src, to: join(tdir(), 'o.tgz') }),
      (e) => e.code === 'BUNDLE_SOURCE_INVALID' && /selected_cases/.test(e.message),
    );
  });
});

describe('verify pass N2: ledgers obey sakk ledger rules and belong to this run', () => {
  for (const [label, fn] of [
    [
      'a negative "refund" entry',
      (l) => {
        l.entries = [
          { callId: 'a', estimatedMaxUsd: 5, status: 'SETTLED', actualUsd: 5 },
          { callId: 'b', estimatedMaxUsd: 0, status: 'SETTLED', actualUsd: -4.6 },
        ];
      },
    ],
    ['a lowercase status', (l) => (l.entries[0].status = 'settled')],
    ['another schema', (l) => (l.schema = 'something-else')],
    ['another run', (l) => (l.initializedBy = 'gold-runner:gold-fake-other')],
    ['a raised cap', (l) => (l.capUsd = 1000)],
  ])
    test(`G12 ledger with ${label} → LEDGER_INVALID`, () => {
      const b = copyOf(PRISTINE);
      assert.ok(forge(b, 'run/G12/ledger.json', fn).includes('LEDGER_INVALID'), label);
    });
  test('a case budget raised in cases/ no longer matches its ledger → LEDGER_INVALID', () => {
    const b = copyOf(PRISTINE);
    assert.ok(
      forge(b, 'cases/G12.json', (c) => (c.max_budget_usd = 1000)).includes('LEDGER_INVALID'),
    );
  });
});

describe('verify pass N3: the shipped verifier is pinned to a commit', () => {
  test('bundle.json and the README name the verifier commit', () => {
    const meta = JSON.parse(readFileSync(join(PRISTINE, 'bundle.json'), 'utf8'));
    assert.match(meta.verifierCommit, /^[0-9a-f]{40}$/);
    const readme = readFileSync(join(PRISTINE, 'README.md'), 'utf8');
    assert.match(readme, new RegExp(`commit \`${meta.verifierCommit}\``));
    // F-65: the check that counts runs the auditor's CURRENT verifier, not the shipped one
    assert.match(readme, /node <your-sakk-clone>\/eval\/lib\/bundle-verify\.mjs \./);
  });
  test('a checkout with an uncommitted verifier refuses to build (BUNDLE_VERIFIER_DIRTY)', () => {
    const repo = join(tdir(), 'r');
    for (const part of ['eval', 'scripts', 'src', 'package.json'])
      cpSync(join(HERE, '..', part), join(repo, part), { recursive: true });
    const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
    g('init', '-q');
    g('add', '-A');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
    writeFileSync(
      join(repo, 'eval/lib/bundle-verify.mjs'),
      `${readFileSync(join(repo, 'eval/lib/bundle-verify.mjs'), 'utf8')}\n// patched\n`,
    );
    const r = spawnSync(
      process.execPath,
      [join(repo, 'scripts/evidence-bundle.mjs'), RUN, '--to', join(tdir(), 'd.tgz')],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /BUNDLE_VERIFIER_DIRTY/);
  });
});

describe('verify pass N4/N6/N8: labels, pack reports, rule names, duplicate keys', () => {
  test('a FAKE bundle whose mode label claims a real baseline → MODE_MISMATCH', () => {
    const b = copyOf(PRISTINE);
    editJson(b, 'run/metrics.json', (m) => (m.mode = 'REAL model baseline (production)'));
    const c = forge(b, 'bundle.json', (x) => (x.mode = 'REAL model baseline (production)'));
    assert.ok(c.includes('MODE_MISMATCH'), c.join());
  });
  test('a FAKE bundle whose traces name a production model → MODE_MISMATCH', () => {
    const b = copyOf(PRISTINE);
    assert.ok(
      forge(b, 'run/G01/trace.json', (t) => (t.model_id = 'claude-opus-4')).includes(
        'MODE_MISMATCH',
      ),
    );
  });
  test('a pack report quoting wrong verdicts, absent cases, another commit or a wrong total → PACK_STATUS_MISMATCH', () => {
    const b = copyOf(PRISTINE);
    const meta = JSON.parse(readFileSync(join(b, 'bundle.json'), 'utf8'));
    writeFileSync(
      join(b, 'run/pack-report.json'),
      JSON.stringify({
        executor_mode: 'FAKE',
        run_id: meta.runId,
        harness_commit: 'f'.repeat(40),
        batch_stopped: null,
        covered: 0,
        total: 7,
        requirements: [
          {
            id: 'r',
            status: 'HARNESS_ONLY',
            cases: [
              { case: 'G05', verdict: 'FAIL' },
              { case: 'G99', verdict: 'PASS' },
            ],
          },
        ],
      }),
    );
    reManifest(b);
    const details = verifyBundle(b)
      .problems.filter((p) => p.code === 'PACK_STATUS_MISMATCH')
      .map((p) => p.detail)
      .join(' | ');
    for (const needle of ['G05 reported', 'G99 reported', 'harness_commit', 'total'])
      assert.ok(details.includes(needle), `${needle} in ${details}`);
  });
  test('a lowercase violation rule (escapes its counter) → CASE_FILE_INVALID', () => {
    const b = copyOf(PRISTINE);
    const c = forge(b, 'run/G07/result.json', (r) => {
      r.verdict = 'FAIL';
      r.violations = [{ rule: 'secret_leak', detail: 'x' }];
    });
    assert.ok(c.includes('CASE_FILE_INVALID'), c.join());
  });
  test('duplicate JSON keys (readers disagree on the winner) → DUPLICATE_JSON_KEY', () => {
    const b = copyOf(PRISTINE);
    const p = join(b, 'run/G07/result.json');
    const r = JSON.parse(readFileSync(p, 'utf8'));
    writeFileSync(
      p,
      `{"case_id":"${r.case_id}","run_id":"${r.run_id}","verdict":"FAIL","violations":[{"rule":"SECRET_LEAK","detail":"x"}],"verdict":"PASS","violations":[]}`,
    );
    reManifest(b);
    assert.ok(codes(b).includes('DUPLICATE_JSON_KEY'));
  });
  test('a negative duration → CASE_FILE_INVALID; an empty run/G13 → EMPTY_DIRECTORY', () => {
    const b = copyOf(PRISTINE);
    assert.ok(
      forge(b, 'run/G02/trace.json', (t) => (t.duration_ms = -1e9)).includes('CASE_FILE_INVALID'),
    );
    const c = copyOf(PRISTINE);
    mkdirSync(join(c, 'run', 'G13'));
    assert.ok(codes(c).includes('EMPTY_DIRECTORY'));
  });
});

describe('verify pass N7/N10: never throws, targets are checked', () => {
  test('an unreadable listed file is a named problem, not an exception', { skip: isRoot }, () => {
    const b = copyOf(PRISTINE);
    chmodSync(join(b, 'run/G01/result.json'), 0o000);
    try {
      assert.ok(codes(b).includes('FILE_UNREADABLE'));
    } finally {
      chmodSync(join(b, 'run/G01/result.json'), 0o644);
    }
  });
  test('a metric holding an object with toString/valueOf does not crash the verifier', () => {
    const b = copyOf(PRISTINE);
    const c = forge(
      b,
      'run/metrics.json',
      (m) => (m.metrics.case_pass_rate = { toString: 1, valueOf: 1 }),
    );
    assert.ok(c.includes('METRIC_MISMATCH'));
  });
  test('target "dir/", a non-.tgz name, or a dangling symlink → refused, nothing written', () => {
    const d = tdir();
    for (const to of [join(d, 'dir') + '/', join(d, 'bundle.zip')])
      assert.throws(
        () => buildBundle({ source: RUN, to }),
        (e) => e.code === 'BUNDLE_TARGET_INVALID',
        to,
      );
    symlinkSync(join(d, 'nowhere'), join(d, 'dangling.tgz'));
    assert.throws(
      () => buildBundle({ source: RUN, to: join(d, 'dangling.tgz') }),
      (e) => e.code === 'BUNDLE_TARGET_EXISTS' && !/appeared/.test(e.message),
    );
    assert.deepEqual(readdirSync(d).sort(), ['dangling.tgz']);
  });
});

describe('verify round 3', () => {
  const metricsAdd = (b, deltaUsd) =>
    editJson(b, 'run/metrics.json', (m) => {
      m.metrics.total_cost_usd += deltaUsd;
      m.metrics.cost_per_case = m.metrics.total_cost_usd / m.selected_cases.length;
    });
  test('S1: an overrun past the case cap that sakk flagged is INCOMPLETE (SPEND_OVER_CAP), not unbundleable', () => {
    const b = copyOf(PRISTINE);
    editJson(b, 'run/G12/ledger.json', (l) => {
      l.entries[0].actualUsd = 0.6; // reserved 0.4, cap 0.5
      l.flags = {
        reconciliationRequired: true,
        reason: 'call x settled 0.6 against a 0.4 reservation',
      };
    });
    editJson(b, 'run/G12/trace.json', (t) => (t.actual_cost_usd = 0.6));
    metricsAdd(b, 0.2);
    reManifest(b);
    const r = verifyBundle(b);
    assert.deepEqual(r.problems, []);
    assert.equal(r.status, 'INCOMPLETE');
    assert.ok(r.incomplete.some((p) => p.code === 'SPEND_OVER_CAP'));
  });
  test('the same overrun WITHOUT sakk’s flag is a forgery (LEDGER_INVALID / LEDGER_OVER_CAP)', () => {
    const b = copyOf(PRISTINE);
    editJson(b, 'run/G12/ledger.json', (l) => (l.entries[0].actualUsd = 0.6));
    editJson(b, 'run/G12/trace.json', (t) => (t.actual_cost_usd = 0.6));
    metricsAdd(b, 0.2);
    reManifest(b);
    assert.ok(codes(b).includes('LEDGER_INVALID'));
  });
  test('S3: paid steps and ledger entries must match one to one', () => {
    const a = copyOf(PRISTINE);
    assert.ok(
      forge(a, 'run/G12/trace.json', (t) =>
        t.tool_calls.push({ kind: 'paid_step', callId: 'ghost', reservedUsd: 0.1 }),
      ).includes('LEDGER_INVALID'),
    );
    const b = copyOf(PRISTINE);
    assert.ok(
      forge(
        b,
        'run/G12/trace.json',
        (t) => (t.tool_calls = t.tool_calls.filter((x) => x.kind !== 'paid_step')),
      ).includes('LEDGER_INVALID'),
    );
  });
  test('S3: an estimated cost is unresolved spend', () => {
    const b = copyOf(PRISTINE);
    editJson(b, 'run/G12/trace.json', (t) => (t.cost_is_estimate = true));
    reManifest(b);
    assert.ok(gaps(b).includes('SPEND_UNRESOLVED'));
  });
  test('N4: ledgers are closed documents (unknown key, missing updatedAt, duplicate callId)', () => {
    for (const fn of [
      (l) => (l.extra = 1),
      (l) => delete l.updatedAt,
      (l) => l.entries.push({ ...l.entries[0] }),
    ]) {
      const b = copyOf(PRISTINE);
      assert.ok(forge(b, 'run/G12/ledger.json', fn).includes('LEDGER_INVALID'));
    }
  });
  test('S3/S4: a pack report may quote only selected cases and must name the run’s model', () => {
    const b = copyOf(PRISTINE);
    const meta = JSON.parse(readFileSync(join(b, 'bundle.json'), 'utf8'));
    writeFileSync(
      join(b, 'run/pack-report.json'),
      JSON.stringify({
        executor_mode: 'FAKE',
        run_id: meta.runId,
        harness_commit: meta.harnessCommit,
        batch_stopped: null,
        model: { model_id: 'claude-opus-production' },
        covered: 0,
        total: 1,
        requirements: [
          { id: 'r', status: 'HARNESS_ONLY', cases: [{ case: 'G13', verdict: 'NOT_RUN' }] },
        ],
      }),
    );
    reManifest(b);
    const details = verifyBundle(b)
      .problems.filter((p) => p.code === 'PACK_STATUS_MISMATCH')
      .map((p) => p.detail)
      .join(' | ');
    assert.match(details, /never selected/);
    assert.match(details, /model/);
  });
  test('N5: stop records compare regardless of key order', () => {
    const b = copyOf(PRISTINE);
    editJson(b, 'run/metrics.json', (m) => (m.stopped = { at: 'G12', why: 'BUDGET' }));
    writeFileSync(
      join(b, 'run/pack-report.json'),
      JSON.stringify(packReportDoc(b, { batch_stopped: { why: 'BUDGET', at: 'G12' } })),
    );
    reManifest(b);
    assert.deepEqual(verifyBundle(b).problems, []);
  });
  test('N6: a hidden-dotfile target is refused', () => {
    assert.throws(
      () => buildBundle({ source: RUN, to: join(tdir(), '.tgz') }),
      (e) => e.code === 'BUNDLE_TARGET_INVALID',
    );
  });
});

describe('F-65: a missing key is a failure, never a skipped check', () => {
  // A coherent REAL forgery of the FAKE run: every label, trace and metric
  // agrees, so only the F-65 checks can tell what is missing.
  const toReal = (b, opts = {}) => {
    // `in`, not defaults: { model: undefined } must mean "no model"
    const model = 'model' in opts ? opts.model : 'claude-x';
    const dirty = 'dirty' in opts ? opts.dirty : false;
    for (const id of readdirSync(join(b, 'run')).filter((x) => /^G\d+$/.test(x)))
      editJson(b, `run/${id}/trace.json`, (t) => {
        t.model_provider = 'anthropic';
        t.model_id = 'claude-x';
      });
    editJson(b, 'run/metrics.json', (m) => {
      m.mode = 'REAL';
      if (model === undefined) delete m.model_id;
      else m.model_id = model;
      m.harness_dirty = dirty;
      Object.assign(m.metrics, {
        executor_mode: 'REAL',
        fake_executor_case_pass_rate: null,
        real_model_case_pass_rate: 1,
        real_model_case_status: 'RUN',
        real_model_called: true,
      });
    });
    editJson(b, 'bundle.json', (x) => {
      x.executorMode = 'REAL';
      x.mode = 'REAL';
    });
    reManifest(b);
    return verifyBundle(b);
  };
  test('control: the coherent REAL forgery passes (so the checks below are what fails)', () => {
    const v = toReal(copyOf(PRISTINE));
    assert.deepEqual([v.status, v.problems, v.incomplete], ['PASS', [], []]);
  });
  test('a REAL run whose metrics name no model → METRICS_UNVERIFIABLE, even with traces relabelled', () => {
    for (const model of [undefined, '', '  ', null, 42]) {
      const v = toReal(copyOf(PRISTINE), { model });
      assert.equal(v.status, 'FAIL', String(model));
      assert.ok(
        v.problems.some(
          (p) => p.code === 'METRICS_UNVERIFIABLE' && /names no model/.test(p.detail),
        ),
        JSON.stringify(v.problems),
      );
    }
  });
  test('a REAL run on a modified or uncheckable tree → INCOMPLETE (HARNESS_MODIFIED)', () => {
    for (const dirty of [true, null]) {
      const v = toReal(copyOf(PRISTINE), { dirty });
      assert.equal(v.status, 'INCOMPLETE', String(dirty));
      assert.deepEqual(
        v.incomplete.map((g) => g.code),
        ['HARNESS_MODIFIED'],
      );
    }
  });
  test('metrics.json without harness_dirty, or with a non-boolean → METRICS_UNVERIFIABLE', () => {
    for (const set of [(m) => delete m.harness_dirty, (m) => (m.harness_dirty = 'false')]) {
      const b = copyOf(PRISTINE);
      assert.ok(forge(b, 'run/metrics.json', set).includes('METRICS_UNVERIFIABLE'));
    }
  });
  test('a pack report without a model field, or disagreeing on harness_dirty, is caught', () => {
    const b = copyOf(PRISTINE);
    const dirty = JSON.parse(readFileSync(join(b, 'run/metrics.json'), 'utf8')).harness_dirty;
    const report = (over) => {
      writeFileSync(join(b, 'run/pack-report.json'), JSON.stringify(packReportDoc(b, over)));
      reManifest(b);
      return verifyBundle(b).problems;
    };
    assert.deepEqual(report({}), [], 'control');
    const noModel = JSON.parse(readFileSync(join(b, 'run/pack-report.json'), 'utf8'));
    delete noModel.model;
    writeFileSync(join(b, 'run/pack-report.json'), JSON.stringify(noModel));
    reManifest(b);
    assert.ok(verifyBundle(b).problems.some((p) => p.code === 'PACK_REPORT_INVALID'));
    assert.ok(
      report({ harness_dirty: !dirty }).some(
        (p) => p.code === 'PACK_STATUS_MISMATCH' && /harness_dirty/.test(p.detail),
      ),
    );
  });
  test('a REAL pack report claiming COVERED over a modified tree is caught', () => {
    const b = copyOf(PRISTINE);
    toReal(b, { dirty: true });
    writeFileSync(
      join(b, 'run/pack-report.json'),
      JSON.stringify(
        packReportDoc(b, {
          model: { model_id: 'claude-x' },
          covered: 1,
          requirements: [
            {
              id: 'r',
              theme: 't',
              gaps: [],
              status: 'COVERED',
              cases: [{ case: 'G05', verdict: 'PASS' }],
            },
          ],
        }),
      ),
    );
    reManifest(b);
    const p = verifyBundle(b).problems;
    assert.ok(
      p.some((x) => x.code === 'PACK_STATUS_MISMATCH' && /HARNESS_MODIFIED/.test(x.detail)),
      JSON.stringify(p),
    );
  });
  test('the builder refuses a REAL run that names no model', () => {
    const src = join(tdir(), 'run');
    cpSync(RUN, src, { recursive: true });
    const m = JSON.parse(readFileSync(join(src, 'metrics.json'), 'utf8'));
    m.metrics.executor_mode = 'REAL';
    delete m.model_id;
    writeFileSync(join(src, 'metrics.json'), JSON.stringify(m));
    assert.throws(
      () => buildBundle({ source: src, to: join(tdir(), 'x.tgz') }),
      (e) => e.code === 'BUNDLE_SOURCE_INVALID' && /names no model/.test(e.message),
    );
  });
});
