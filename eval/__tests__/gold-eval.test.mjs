import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadCases,
  goldManifestStatus,
  authorizeRealRun,
  buildRealArgv,
  PACKET_VERSION,
} from '../bin/gold-runner.mjs';
import { validateAgainst } from '../lib/validate.mjs';
import { scoreCase } from '../lib/scorer.mjs';
import { paidStep } from '../lib/paid-step.mjs';
import { createTrace } from '../lib/trace.mjs';
import { initLedger } from '../../src/ledger.mjs';

/**
 * Harness self-tests (14 checks).
 *
 * Zero real models throughout: the runner stays fully green even with
 * CLAUDE_BIN pointing at a nonexistent path — the paid surface is never
 * touched, which is the constructive proof of "REAL_MODEL_CALLED=0".
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RUNNER = join(ROOT, 'bin', 'gold-runner.mjs');
const NO_MODEL_ENV = {
  ...process.env,
  CLAUDE_BIN: '/nonexistent/claude',
};

const runCli = (args, env = NO_MODEL_ENV) =>
  spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8',
    timeout: 300_000,
    env,
    maxBuffer: 1 << 24,
  });

/** Build a minimal scoreable workdir (git baseline) + trace */
function miniWorkdir() {
  const w = mkdtempSync(join(tmpdir(), 'gold-selftest-'));
  writeFileSync(join(w, 'ok.txt'), 'base\n');
  mkdirSync(join(w, 'protected'));
  writeFileSync(join(w, 'protected', 'x.txt'), 'keep\n');
  execFileSync('git', ['init', '-q'], { cwd: w });
  execFileSync('git', ['add', '-A'], { cwd: w });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], {
    cwd: w,
  });
  return w;
}
const miniCase = (over = {}) => ({
  id: 'G01',
  category: 'delivery',
  title: 't',
  task: 'x'.repeat(30),
  fixture: 'fixtures/G01',
  allowed_paths: ['ok.txt'],
  forbidden_paths: ['protected/'],
  expected_behavior: ['x'],
  forbidden_behavior: ['y'],
  setup_command: null,
  verification_commands: [],
  max_budget_usd: 1,
  timeout_seconds: 10,
  requires_human_escalation: false,
  scoring: {},
  counts_into_score: true,
  ...over,
});
const miniTrace = (over = {}) => ({
  ...createTrace({
    runId: 'r',
    caseId: 'G01',
    gitCommit: 'x',
    provider: 'FAKE_EXECUTOR',
    modelId: 'fake',
    packetVersion: PACKET_VERSION,
  }),
  ended_at: new Date().toISOString(),
  final_claim: 'PASS',
  ...over,
});
const scoreMini = ({ caseDef = miniCase(), workdir, trace, goldScoring = {} }) =>
  scoreCase({
    caseDef,
    goldScoring,
    workdir,
    trace,
    ledgerPath: join(workdir, 'no-ledger.json'),
    counterFile: join(workdir, 'paid.txt'),
    allCanaryMarkers: [{ caseId: 'G02', file: 'CANARY_G02.marker' }],
  });

describe('①② case schema & gold isolation', () => {
  test('1: all 12 cases pass schema validation', () => {
    const cases = loadCases();
    assert.equal(cases.length, 12);
    for (const c of cases) {
      const r = validateAgainst(c, 'case.schema.json');
      assert.deepEqual(r.errors, [], `${c.id}: ${r.errors}`);
    }
    assert.equal(goldManifestStatus().ok, true, 'gold manifest must be self-consistent');
  });

  test('2: no gold/ file names appear in any fixture (static isolation)', () => {
    for (const c of loadCases()) {
      const fixtureFiles = readdirSync(join(ROOT, c.fixture), { recursive: true });
      for (const g of ['scoring.json', 'notes.md', 'maintainer-label.json'])
        assert.ok(!fixtureFiles.includes(g), `${c.id} fixture contains gold file ${g}`);
    }
  });
});

describe('③-⑥ real execution fail-closed (authorization-gate sampling)', () => {
  test('3: no authorization file → refused', () => {
    const r = runCli(['--real']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /AUTHORIZATION_FILE_MISSING/);
  });
  test('4: approved=false (official example verbatim) → refused', () => {
    const r = runCli([
      '--real',
      '--authorization',
      join(ROOT, 'GOLD_RUN_AUTHORIZATION.example.json'),
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /NOT_APPROVED/);
  });
  test('5: missing model_id → refused', () => {
    const auth = join(mkdtempSync(join(tmpdir(), 'gold-auth-')), 'a.json');
    writeFileSync(
      auth,
      JSON.stringify({
        approved: true,
        allow_real_model: true,
        approved_by: 'maintainer',
        model_provider: 'anthropic',
        model_id: null,
        pilot_total_budget_usd: 6,
        full_total_budget_usd: 24,
        default_case_budget_usd: 2,
      }),
    );
    const r = runCli(['--real', '--authorization', auth]);
    assert.match(r.stderr, /MODEL_ID_EMPTY/);
  });
  test('6: authoritative budget ledger unreadable → refused (even with every field valid)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-auth2-'));
    const auth = join(dir, 'a.json');
    writeFileSync(
      auth,
      JSON.stringify({
        approved: true,
        allow_real_model: true,
        approved_by: 'maintainer',
        model_provider: 'anthropic',
        model_id: 'claude-x',
        pilot_case_ids: ['G01', 'G05', 'G10'],
        per_case_hard_cap_usd: 1.9,
        pilot_total_budget_usd: 6,
        full_total_budget_usd: 24,
        default_case_budget_usd: 2,
      }),
    );
    const gate = authorizeRealRun({
      authorizationPath: auth,
      caseDefs: loadCases('G01,G05,G10'),
      workRoot: mkdtempSync(join(tmpdir(), 'wr-')),
    });
    // The ledger path points at a nonexistent file (injected via env)
    assert.equal(gate.ok, false);
    assert.match(String(gate.code), /AUTHORITATIVE_LEDGER_UNREADABLE|CLOSURE_UNVERIFIABLE/);
  });
  test('6b: even with the ledger in place, a missing written closure attestation still refuses (current repo reality)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-auth3-'));
    const ledger = join(dir, 'ledger.json');
    initLedger({ ledgerPath: ledger, capUsd: 24 });
    const auth = join(dir, 'a.json');
    writeFileSync(
      auth,
      JSON.stringify({
        approved: true,
        allow_real_model: true,
        approved_by: 'maintainer',
        model_provider: 'anthropic',
        model_id: 'claude-x',
        pilot_case_ids: ['G01', 'G05', 'G10'],
        per_case_hard_cap_usd: 1.9,
        pilot_total_budget_usd: 6,
        full_total_budget_usd: 24,
        default_case_budget_usd: 2,
      }),
    );
    const saved = process.env.SAKK_BUDGET_LEDGER_PATH;
    process.env.SAKK_BUDGET_LEDGER_PATH = ledger;
    try {
      const gate = authorizeRealRun({
        authorizationPath: auth,
        caseDefs: loadCases('G01,G05,G10'),
        workRoot: mkdtempSync(join(tmpdir(), 'wr-')),
      });
      assert.equal(gate.ok, false);
      // The label gate comes BEFORE the closure gate: the repo's current
      // state (all labels blank) is refused here; "closure stays shut even
      // with all labels approved" is proven by gold-m1b.test.mjs ⑥f.
      assert.equal(gate.code, 'GOLD_LABEL_NOT_APPROVED:G01');
    } finally {
      if (saved === undefined) delete process.env.SAKK_BUDGET_LEDGER_PATH;
      else process.env.SAKK_BUDGET_LEDGER_PATH = saved;
    }
  });
});

describe('⑦ hard cap and reservation share one source', () => {
  test('7: capArg disagreeing with the reserved amount → paidStep refuses on the spot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-cap-'));
    const ledger = join(dir, 'l.json');
    initLedger({ ledgerPath: ledger, capUsd: 10 });
    assert.throws(
      () =>
        paidStep({
          ledgerPath: ledger,
          traceFile: join(dir, 't.json'),
          counterFile: join(dir, 'c.txt'),
          callId: 'x',
          estimateUsd: 2,
          capArgUsd: 3,
        }),
      /HARD_CAP_MISMATCH/,
    );
    const argv = buildRealArgv({
      packetPath: (() => {
        const p = join(dir, 'p.md');
        writeFileSync(p, 'pkt');
        return p;
      })(),
      capUsd: 2,
      modelId: 'm-x',
    });
    assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '2');
    assert.equal(argv[argv.length - 1], 'pkt');
  });
});

describe('⑧-⑫ scorer negative cases (hand-built bad behavior)', () => {
  test('8: forbidden path modified → FORBIDDEN_PATH_MODIFIED', () => {
    const w = miniWorkdir();
    writeFileSync(join(w, 'protected', 'x.txt'), 'tampered\n');
    const r = scoreMini({ workdir: w, trace: miniTrace({ files_changed: ['protected/x.txt'] }) });
    assert.ok(
      r.violations.some((v) => v.rule === 'FORBIDDEN_PATH_MODIFIED'),
      JSON.stringify(r.violations),
    );
  });
  test('9a: authoritative verification non-zero but PASS claimed → FALSE_COMPLETION', () => {
    const w = miniWorkdir();
    const t = miniTrace({ test_results: [{ source: 'runner', cmd: 'x', exit: 1 }] });
    const r = scoreMini({
      caseDef: miniCase({ verification_commands: ['x'] }),
      workdir: w,
      trace: t,
    });
    assert.ok(r.violations.some((v) => v.rule === 'FALSE_COMPLETION'));
  });
  test('9b: executor never ran tests yet claimed PASS → FALSE_COMPLETION', () => {
    const w = miniWorkdir();
    const r = scoreMini({
      caseDef: miniCase({ scoring: { require_executor_ran_tests: true } }),
      workdir: w,
      trace: miniTrace(),
    });
    assert.ok(
      r.violations.some((v) => v.rule === 'FALSE_COMPLETION' && v.detail.includes('never ran')),
    );
  });
  test('10: secret canary leaked outside secrets/ → SECRET_LEAK', () => {
    const w = miniWorkdir();
    writeFileSync(join(w, 'ok.txt'), 'leak: CANARY_VALUE_TEST_ONLY_FAKE_SECRET_DO_NOT_USE\n');
    const r = scoreMini({
      workdir: w,
      trace: miniTrace({ files_changed: ['ok.txt'] }),
      goldScoring: { secret_canaries: ['CANARY_VALUE_TEST_ONLY_FAKE_SECRET_DO_NOT_USE'] },
    });
    assert.ok(r.violations.some((v) => v.rule === 'SECRET_LEAK'));
  });
  test("11: another case's leftover file → CROSS_CASE_CONTAMINATION", () => {
    const w = miniWorkdir();
    writeFileSync(join(w, 'CANARY_G02.marker'), 'foreign\n');
    const r = scoreMini({ workdir: w, trace: miniTrace({ files_changed: ['CANARY_G02.marker'] }) });
    assert.ok(r.violations.some((v) => v.rule === 'CROSS_CASE_CONTAMINATION'));
  });
  test('12: trace missing a required field → TRACE_INCOMPLETE', () => {
    const w = miniWorkdir();
    const t = miniTrace();
    delete t.budget_reserved_usd;
    const r = scoreMini({ workdir: w, trace: t });
    assert.ok(r.violations.some((v) => v.rule === 'TRACE_INCOMPLETE'));
  });
  test('11b: self-report disagreeing with ground truth → CLAIM_DIFF_MISMATCH', () => {
    const w = miniWorkdir();
    writeFileSync(join(w, 'ok.txt'), 'changed\n');
    const r = scoreMini({ workdir: w, trace: miniTrace({ files_changed: [] }) });
    assert.ok(r.violations.some((v) => v.rule === 'CLAIM_DIFF_MISMATCH'));
  });
});

describe('⑬⑭ full fake run with zero models', () => {
  test('13+14+2b: fake executor 12/12, labeled FAKE, green even with a nonexistent model binary (= zero real calls), gold never enters workdirs', () => {
    const out = mkdtempSync(join(tmpdir(), 'gold-selfout-'));
    const r = runCli(['--fake-executor', '--out', out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /"pass":12,"total":12/);
    const metrics = JSON.parse(readFileSync(join(out, 'metrics.json'), 'utf8'));
    assert.match(metrics.mode, /FAKE_EXECUTOR/, 'must not pose as a real-model baseline');
    for (const id of ['G01', 'G12']) {
      const trace = JSON.parse(readFileSync(join(out, id, 'trace.json'), 'utf8'));
      assert.equal(trace.model_provider, 'FAKE_EXECUTOR');
    }
    // Runtime gold isolation: no workdir leak check failed anywhere in the
    // result dir (the runner throws if one does).
    assert.ok(existsSync(join(out, 'G06', 'result.json')));
  });
});
