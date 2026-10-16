import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
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
const forge = (b, rel, fn) => {
  editJson(b, rel, fn);
  reManifest(b);
  return codes(b);
};
const hasShasum = spawnSync('shasum', ['--version']).status === 0;

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
      assert.ok(forge(b, rel, fn).includes('CASE_FILE_INVALID'), rel);
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
  test('a FAKE run relabelled REAL with a real-model pass rate → MODE_MISMATCH', () => {
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
