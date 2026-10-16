import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initLedger,
  reserve,
  clearReconciliation,
  markReconciliationRequired,
  LedgerError,
} from '../src/ledger.mjs';
import {
  authorizeRealRun,
  loadCases,
  runCase,
  SUPPORTED_PROVIDERS,
} from '../eval/bin/gold-runner.mjs';
import { verifyBundle } from '../eval/lib/bundle-verify.mjs';
import { buildBundle } from '../scripts/evidence-bundle.mjs';

/**
 * Refusal paths that had no negative test (found by
 * test/claims-are-checked.test.mjs, which now keeps it that way): every
 * code a refusal path can emit is asserted somewhere.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const tdir = () => mkdtempSync(join(tmpdir(), 'refusal-'));
const ledgerCode = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof LedgerError, e.message);
    return e.code;
  }
  return null;
};

describe('ledger refusals', () => {
  test('CALL_ID_REQUIRED, ESTIMATE_INVALID, RECONCILE_BY_REQUIRED', () => {
    const ledgerPath = join(tdir(), 'l.json');
    initLedger({ ledgerPath, capUsd: 10 });
    assert.equal(
      ledgerCode(() => reserve({ ledgerPath, estimatedMaxUsd: 1 })),
      'CALL_ID_REQUIRED',
    );
    assert.equal(
      ledgerCode(() => reserve({ ledgerPath, callId: 'a', estimatedMaxUsd: 0 })),
      'ESTIMATE_INVALID',
    );
    markReconciliationRequired({ ledgerPath, reason: 'r' });
    assert.equal(
      ledgerCode(() => clearReconciliation({ ledgerPath })),
      'RECONCILE_BY_REQUIRED',
    );
  });
});

describe('real-run authorization refusals', () => {
  const gate = (auth) => {
    const p = join(tdir(), 'a.json');
    writeFileSync(p, typeof auth === 'string' ? auth : JSON.stringify(auth));
    return authorizeRealRun({ authorizationPath: p, caseDefs: loadCases('G05'), workRoot: tdir() })
      .code;
  };
  const base = {
    approved: true,
    allow_real_model: true,
    approved_by: 'x',
    model_provider: SUPPORTED_PROVIDERS[0],
    model_id: 'm',
    pilot_total_budget_usd: 100,
    full_total_budget_usd: 100,
    default_case_budget_usd: 0.01,
    pilot_case_ids: ['G05'],
  };
  test('AUTHORIZATION_FILE_MALFORMED, REAL_MODEL_NOT_ALLOWED, APPROVED_BY_EMPTY, BUDGET_INVALID, PILOT_SCOPE_INVALID', () => {
    assert.equal(gate('{nope'), 'AUTHORIZATION_FILE_MALFORMED');
    assert.equal(gate({ ...base, allow_real_model: false }), 'REAL_MODEL_NOT_ALLOWED');
    assert.equal(gate({ ...base, approved_by: '' }), 'APPROVED_BY_EMPTY');
    assert.equal(gate({ ...base, pilot_total_budget_usd: -1 }), 'BUDGET_INVALID');
    assert.equal(gate({ ...base, pilot_case_ids: [] }), 'PILOT_SCOPE_INVALID');
  });
  test('runCase refuses real mode: REAL_MODE_MUST_GO_THROUGH_runRealCase', () => {
    assert.throws(
      () =>
        runCase({ caseDef: loadCases('G05')[0], mode: 'real', workRoot: tdir(), outDir: tdir() }),
      /REAL_MODE_MUST_GO_THROUGH_runRealCase/,
    );
  });
});

describe('gold isolation', () => {
  test('GOLD_LEAK_INTO_WORKDIR: a fixture that would carry gold files into the workdir refuses', () => {
    const caseDef = { ...loadCases('G01')[0], fixture: 'gold/G01' };
    assert.throws(
      () => runCase({ caseDef, mode: 'fake', workRoot: tdir(), outDir: tdir(), runId: 'r' }),
      /GOLD_LEAK_INTO_WORKDIR/,
    );
  });
});

describe('bundle verifier and builder refusals', () => {
  let RUN;
  let PRISTINE;
  before(() => {
    RUN = join(tdir(), 'run');
    const r = spawnSync(
      process.execPath,
      [join(ROOT, 'eval', 'bin', 'gold-runner.mjs'), '--fake-executor', '--out', RUN],
      { encoding: 'utf8', timeout: 300_000 },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = tdir();
    execFileSync('tar', [
      '-xzf',
      buildBundle({ source: RUN, to: join(out, 'b.tgz') }).to,
      '-C',
      out,
    ]);
    PRISTINE = join(
      out,
      readdirSync(out).find((n) => n.startsWith('sakk-evidence-')),
    );
  });
  const copy = () => {
    const d = join(tdir(), 'b');
    cpSync(PRISTINE, d, { recursive: true });
    return d;
  };
  const codes = (b) => verifyBundle(b).problems.map((p) => p.code);
  const json = (b, rel, fn) => {
    const p = join(b, rel);
    const j = JSON.parse(readFileSync(p, 'utf8'));
    fn(j);
    writeFileSync(p, JSON.stringify(j));
  };
  test('MANIFEST_MISSING and MANIFEST_MALFORMED', () => {
    const a = copy();
    writeFileSync(join(a, 'MANIFEST.sha256'), 'garbage line\n');
    assert.ok(codes(a).includes('MANIFEST_MALFORMED'));
    const b = copy();
    execFileSync('rm', [join(b, 'MANIFEST.sha256')]);
    assert.deepEqual(codes(b), ['MANIFEST_MISSING']);
  });
  test('CASE_ID_MISMATCH, LEDGER_OVER_CAP, PACK_REPORT_INVALID (integrity aside)', () => {
    const b = copy();
    json(b, 'run/G01/result.json', (r) => (r.case_id = 'G02'));
    json(b, 'run/G12/ledger.json', (l) => {
      l.entries = [{ callId: 'x', estimatedMaxUsd: 0.9, status: 'SETTLED', actualUsd: 0.9 }];
    });
    json(b, 'run/G12/trace.json', (t) => (t.actual_cost_usd = 0.9));
    writeFileSync(join(b, 'run/pack-report.json'), JSON.stringify({ requirements: [] }));
    const c = codes(b);
    for (const code of ['CASE_ID_MISMATCH', 'LEDGER_OVER_CAP', 'PACK_REPORT_INVALID'])
      assert.ok(c.includes(code), `${code} in ${c.join()}`);
  });
  test('BUNDLE_WRITE_FAILED: a target in a directory that does not exist', () => {
    assert.throws(
      () => buildBundle({ source: RUN, to: join(tdir(), 'no', 'such', 'dir', 'b.tgz') }),
      (e) => e.code === 'BUNDLE_WRITE_FAILED',
    );
  });
  test('BUNDLE_VERIFIER_UNPINNED: a builder outside any git clone', () => {
    const copyRoot = join(tdir(), 'nogit');
    for (const part of ['eval', 'scripts', 'src', 'package.json'])
      cpSync(join(ROOT, part), join(copyRoot, part), { recursive: true });
    const r = spawnSync(
      process.execPath,
      [join(copyRoot, 'scripts', 'evidence-bundle.mjs'), RUN, '--to', join(tdir(), 'u.tgz')],
      {
        encoding: 'utf8',
        cwd: tmpdir(),
        env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
      },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /BUNDLE_VERIFIER_UNPINNED/);
  });
});
