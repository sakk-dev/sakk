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
