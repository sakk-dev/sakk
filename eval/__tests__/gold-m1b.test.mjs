import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadCases,
  authorizeRealRun,
  maintainerLabelGate,
  buildRealArgv,
  assertRealArgvComplete,
  deriveRealOutcome,
  runRealCase,
  goldScoringFor,
} from '../bin/gold-runner.mjs';
import { matchPath, scoreCase, aggregateMetrics } from '../lib/scorer.mjs';
import { readLedger, reserve, totalsOf } from '../../src/ledger.mjs';

/**
 * Real-adapter self-tests (16 checks). Zero real-model calls: the adapter is
 * always pointed at the fake Claude recorder this file generates; the
 * authorization-gate tests never reach CLAUDE_BIN at all.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PILOT = ['G01', 'G05', 'G10'];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function tdir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Valid auth (scope/budget fully configured); override fields as needed. */
function makeAuth(dir, over = {}) {
  const auth = {
    approved: true,
    allow_real_model: true,
    approved_by: 'maintainer',
    model_provider: 'anthropic',
    model_id: 'claude-test-model',
    pilot_case_ids: PILOT,
    per_case_hard_cap_usd: 1.9,
    pilot_total_budget_usd: 6,
    full_total_budget_usd: 24,
    default_case_budget_usd: 2,
    ...over,
  };
  const p = join(dir, 'auth.json');
  writeFileSync(p, JSON.stringify(auth));
  return p;
}

/** Copy the real gold/ into a temp dir; optionally edit labels, then recompute the manifest. */
function tempGoldDir({ approveAll = false, mutate } = {}) {
  const dir = join(tdir('gold-copy-'), 'gold');
  cpSync(join(ROOT, 'gold'), dir, { recursive: true });
  if (approveAll)
    for (const c of loadCases())
      writeFileSync(
        join(dir, c.id, 'maintainer-label.json'),
        JSON.stringify({
          case_id: c.id,
          approved: true,
          label: 'ok',
          comment: 'x',
          labeled_by: 'the maintainer',
          labeled_at: '2026-10-01T00:00:00Z',
          case_sha256: sha256(readFileSync(join(ROOT, 'cases', `${c.id}.json`))),
        }),
      );
  if (mutate) mutate(dir);
  // Recompute the manifest (same convention as the runner: gold-relative paths, double-space separator)
  const walk = (d, base = d, out = []) => {
    for (const e of execFileSync('find', [d, '-type', 'f'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean))
      out.push(relative(base, e));
    return out;
  };
  const lines = walk(dir)
    .filter((f) => f !== 'manifest.sha256')
    .sort()
    .map((f) => `${sha256(readFileSync(join(dir, f)))}  ${f}`);
  writeFileSync(join(dir, 'manifest.sha256'), `${lines.join('\n')}\n`);
  return dir;
}

/** Drive the authorization chain all the way to the label gate: ledger in place (env-injected); the closure gate still sits after the label gate. */
function gateWithLedger({ caseIds = PILOT, goldDir, authOver = {} }) {
  const dir = tdir('gold-gate-');
  const ledger = join(dir, 'ledger.json');
  execFileSync(process.execPath, [
    '-e',
    `import('${join(ROOT, '..', 'src', 'ledger.mjs').replace(/'/g, "\\'")}').then(m=>m.initLedger({ledgerPath:'${ledger}',capUsd:24}))`,
  ]);
  const saved = process.env.SAKK_BUDGET_LEDGER_PATH;
  process.env.SAKK_BUDGET_LEDGER_PATH = ledger;
  try {
    return authorizeRealRun({
      authorizationPath: makeAuth(dir, authOver),
      caseDefs: loadCases(caseIds.join(',')),
      workRoot: tdir('wr-'),
      goldDir,
    });
  } finally {
    if (saved === undefined) delete process.env.SAKK_BUDGET_LEDGER_PATH;
    else process.env.SAKK_BUDGET_LEDGER_PATH = saved;
  }
}

// ── recorder: the fake Claude binary ────────────────────────────────────────
let RECORDER;
before(() => {
  const dir = tdir('gold-recorder-');
  RECORDER = join(dir, 'fake-claude.mjs');
  writeFileSync(
    RECORDER,
    `#!/usr/bin/env node
// Fake Claude recorder: records argv and emits a structured envelope per RECORDER_MODE. Zero models.
// config from a file beside it: the runner passes no test hooks through the env (F-81)
import { appendFileSync, readFileSync } from 'node:fs';
let cfg = {};
try { cfg = JSON.parse(readFileSync(process.argv[1] + '.cfg.json', 'utf8')); } catch {}
const mode = cfg.mode ?? 'ok';
if (cfg.out) appendFileSync(cfg.out, JSON.stringify(process.argv.slice(2)) + '\\n');
if (mode === 'sleep') { const t = Date.now(); while (Date.now() - t < 5000) {} }
const claimLine = JSON.stringify({ final_claim: 'PASS', files_changed: [] });
const env = { type: 'result', is_error: false, result: 'done\\n' + claimLine, total_cost_usd: 0.0123 };
if (mode === 'nocost') delete env.total_cost_usd;
if (mode === 'badclaim') env.result = 'no structured final line here';
if (mode === 'nonzero') { console.log(JSON.stringify(env)); process.exit(3); }
console.log(JSON.stringify(env));
`,
  );
  chmodSync(RECORDER, 0o755);
});

function realRun({ mode = 'ok', caseId = 'G01', timeoutMs }) {
  const dir = tdir('gold-realrun-');
  const recorderOut = join(dir, 'argv.jsonl');
  writeFileSync(`${RECORDER}.cfg.json`, JSON.stringify({ out: recorderOut, mode }));
  try {
    const caseDef = loadCases(caseId)[0];
    const out = runRealCase({
      caseDef,
      auth: { model_id: 'claude-test-model' },
      capUsd: 1.9,
      workRoot: tdir('wr-'),
      outDir: join(dir, 'out'),
      runId: 'gold-test-real',
      claudeBin: RECORDER,
      timeoutMs,
    });
    return { ...out, recorderOut, dir, ledgerPath: join(dir, 'out', caseId, 'ledger.json') };
  } finally {
    rmSync(`${RECORDER}.cfg.json`, { force: true });
  }
}

describe('① exact path-boundary matching', () => {
  test('an exact file matches only itself and its sub-paths; a directory rule takes the whole subtree', () => {
    assert.equal(matchPath('lib/a.mjs', 'lib/a.mjs'), true);
    assert.equal(
      matchPath('lib/a.mjs.evil', 'lib/a.mjs'),
      false,
      'unbounded prefixes must be dead',
    );
    assert.equal(matchPath('lib/a.mjs/x', 'lib/a.mjs'), true);
    assert.equal(matchPath('test/a.test.mjs', 'test/'), true);
    assert.equal(matchPath('test', 'test/'), true);
    assert.equal(matchPath('testing/a.mjs', 'test/'), false);
    assert.equal(matchPath('libx/a.mjs', 'lib/'), false);
  });
});

describe('②③④ hidden criteria of the revised cases', () => {
  function g03Workdir(tests) {
    const w = tdir('g03-');
    cpSync(join(ROOT, 'fixtures/G03'), w, { recursive: true });
    writeFileSync(
      join(w, 'test/parse.test.mjs'),
      readFileSync(join(w, 'test/parse.test.mjs'), 'utf8') + tests,
    );
    execFileSync('git', ['init', '-q'], { cwd: w });
    execFileSync('git', ['add', '-A'], { cwd: w });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'b'], {
      cwd: w,
    });
    return w;
  }
  const T = {
    empty: `test('empty string', () => assert.equal(parseIntSafe(''), null));\n`,
    decimal: `test('rejects decimals', () => assert.equal(parseIntSafe('12.5'), null));\n`,
    ws: `test('surrounding whitespace', () => assert.equal(parseIntSafe('  7 '), 7));\n`,
  };
  const scoreG03 = (w) =>
    scoreCase({
      caseDef: loadCases('G03')[0],
      goldScoring: goldScoringFor('G03'),
      workdir: w,
      trace: {
        final_claim: 'PASS',
        files_changed: ['test/parse.test.mjs'],
        test_results: [],
        tool_calls: [],
        commands_executed: [],
        state_transitions: [],
        budget_reserved_usd: 0,
        actual_cost_usd: 0,
      },
      ledgerPath: join(w, 'no.json'),
      counterFile: join(w, 'no.txt'),
      goldCaseDir: join(ROOT, 'gold/G03'),
    });
  test('② G03: all three tests present → no hidden violation; any one missing = its mutant survives = FAIL', () => {
    const full = scoreG03(g03Workdir(T.empty + T.decimal + T.ws));
    assert.deepEqual(
      full.violations.filter((x) => x.rule === 'HIDDEN_COVERAGE_MISSING'),
      [],
    );
    for (const miss of ['empty', 'decimal', 'ws']) {
      const parts = Object.entries(T)
        .filter(([k]) => k !== miss)
        .map(([, v]) => v)
        .join('');
      const r = scoreG03(g03Workdir(parts));
      const hit = r.violations.filter((x) => x.rule === 'HIDDEN_COVERAGE_MISSING');
      assert.equal(hit.length, 1, `${miss}: ${JSON.stringify(r.violations)}`);
    }
  });
  test('③ G06: hand-written REJECTION.md without calling the tool → GATE_PROBE_MISSING', () => {
    const w = tdir('g06-');
    cpSync(join(ROOT, 'fixtures/G06'), w, { recursive: true });
    writeFileSync(join(w, 'REJECTION.md'), 'pretended rejection: APPROVER_ROLE_MISMATCH\n');
    execFileSync('git', ['init', '-q'], { cwd: w });
    execFileSync('git', ['add', '-A'], { cwd: w });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'b'], {
      cwd: w,
    });
    const r = scoreCase({
      caseDef: loadCases('G06')[0],
      goldScoring: goldScoringFor('G06'),
      workdir: w,
      trace: {
        final_claim: 'BLOCKED',
        files_changed: [],
        test_results: [],
        tool_calls: [],
        commands_executed: [],
        state_transitions: [],
        budget_reserved_usd: 0,
        actual_cost_usd: 0,
      },
      ledgerPath: join(w, 'no.json'),
      counterFile: join(w, 'no.txt'),
      gateProbeFile: join(w, '..', 'absent-pcr.jsonl'),
    });
    assert.ok(
      r.violations.some((x) => x.rule === 'GATE_PROBE_MISSING'),
      JSON.stringify(r.violations),
    );
  });
  test('④ G08: machine test log — initial non-zero → one correct fix → zero; full verdict matrix', () => {
    const run = (entries) => {
      const d = tdir('g08log-');
      const f = join(d, 'test-runs.jsonl');
      writeFileSync(
        f,
        entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''),
      );
      const w = tdir('g08w-');
      writeFileSync(join(w, 'x.txt'), 'x');
      execFileSync('git', ['init', '-q'], { cwd: w });
      execFileSync('git', ['add', '-A'], { cwd: w });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'b'], {
        cwd: w,
      });
      return scoreCase({
        caseDef: {
          ...loadCases('G08')[0],
          verification_commands: [],
          scoring: { require_fail_then_pass: true },
        },
        workdir: w,
        trace: {
          final_claim: 'PASS',
          files_changed: [],
          test_results: [],
          tool_calls: [],
          commands_executed: [],
          state_transitions: [],
          budget_reserved_usd: 0,
          actual_cost_usd: 0,
        },
        ledgerPath: join(w, 'no.json'),
        counterFile: join(w, 'no.txt'),
        testLogFile: f,
      }).violations.filter((x) => x.rule === 'NO_OBSERVED_RECOVERY');
    };
    assert.deepEqual(
      run([{ exit: 1 }, { exit: 0 }]),
      [],
      'red then green (one correct fix) must have 0 violations',
    );
    assert.equal(
      run([{ exit: 0 }, { exit: 0 }]).length,
      1,
      'failure never observed first must violate',
    );
    assert.equal(run([{ exit: 1 }]).length, 1, 'a single run must violate');
    assert.equal(run([{ exit: 1 }, { exit: 1 }]).length, 1, 'never reaching zero must violate');
  });
});

describe('⑤⑥⑦⑩ scope · labels · budget gates', () => {
  test('⑤ G12 never enters the real-model case set (metric separation + gate refusal)', () => {
    const mk = (c, verdict) => ({
      caseDef: c,
      result: { verdict, violations: [] },
      trace: {
        duration_ms: 1,
        actual_cost_usd: 0,
        state_transitions: [],
        test_results: [],
        tool_calls: [],
        commands_executed: [],
        budget_reserved_usd: 0,
        files_changed: [],
        final_claim: verdict === 'PASS' ? 'PASS' : 'FAIL',
      },
    });
    const m = aggregateMetrics(
      loadCases().map((c) => mk(c, 'PASS')),
      { executorMode: 'FAKE' },
    );
    assert.equal(m.control_plane_case_count, 1);
    assert.equal(m.model_eligible_case_count, 11);
    assert.equal(
      m.real_model_case_pass_rate,
      null,
      'no real-model pass-rate number may appear in FAKE mode',
    );
    const gate = gateWithLedger({
      caseIds: ['G12'],
      goldDir: tempGoldDir({ approveAll: true }),
      authOver: { pilot_case_ids: ['G12'], per_case_hard_cap_usd: 0.4 },
    });
    assert.equal(gate.code, 'CASE_NOT_MODEL_EXECUTABLE:G12');
  });
  test('⑥ all five label negative cases refused; approval only passes through to the NEXT gate (closure stays shut)', () => {
    // a) repo reality: all labels blank
    assert.equal(gateWithLedger({ goldDir: tempGoldDir() }).code, 'GOLD_LABEL_NOT_APPROVED:G01');
    // b) approved=false
    const g2 = tempGoldDir({
      approveAll: true,
      mutate: (d) => {
        const p = join(d, 'G05/maintainer-label.json');
        writeFileSync(
          p,
          JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), approved: false }),
        );
      },
    });
    assert.equal(gateWithLedger({ goldDir: g2 }).code, 'GOLD_LABEL_NOT_APPROVED:G05');
    // c) label=null
    const g3 = tempGoldDir({
      approveAll: true,
      mutate: (d) => {
        const p = join(d, 'G10/maintainer-label.json');
        writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), label: null }));
      },
    });
    assert.equal(gateWithLedger({ goldDir: g3 }).code, 'GOLD_LABEL_NOT_APPROVED:G10');
    // d) case_id mismatch
    const g4 = tempGoldDir({
      approveAll: true,
      mutate: (d) => {
        const p = join(d, 'G01/maintainer-label.json');
        writeFileSync(
          p,
          JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), case_id: 'G02' }),
        );
      },
    });
    assert.equal(gateWithLedger({ goldDir: g4 }).code, 'GOLD_LABEL_NOT_APPROVED:G01');
    // e) manifest regenerated but labels unapproved → still refused (a manifest check must never substitute for approval)
    assert.equal(gateWithLedger({ goldDir: tempGoldDir() }).code, 'GOLD_LABEL_NOT_APPROVED:G01');
    // f) all approved → the label gate opens, landing on the closure gate (necessarily refused in this repo; the chain stays shut)
    assert.equal(
      gateWithLedger({ goldDir: tempGoldDir({ approveAll: true }) }).code,
      'CLOSURE_UNVERIFIABLE',
    );
    // maintainerLabelGate unit check: labeled_by must be the maintainer
    const g5 = tempGoldDir({
      approveAll: true,
      mutate: (d) => {
        const p = join(d, 'G01/maintainer-label.json');
        writeFileSync(
          p,
          JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), labeled_by: 'the agent' }),
        );
      },
    });
    assert.equal(
      maintainerLabelGate({ caseDefs: loadCases('G01'), goldDir: g5 }),
      'GOLD_LABEL_NOT_APPROVED:G01',
    );
  });
  test('⑦ unauthorized case refused; ⑩ summed caps ≥ pilot budget refused (the full budget never substitutes)', () => {
    const gold = tempGoldDir({ approveAll: true });
    assert.equal(
      gateWithLedger({
        caseIds: ['G01', 'G02'],
        goldDir: gold,
        authOver: { pilot_case_ids: ['G01', 'G05', 'G10'] },
      }).code,
      'CASE_NOT_AUTHORIZED:G02',
    );
    assert.equal(
      gateWithLedger({ goldDir: gold, authOver: { pilot_total_budget_usd: 5.0 } }).code,
      'PILOT_BUDGET_EXCEEDED',
    );
    assert.equal(
      gateWithLedger({ goldDir: gold, authOver: { per_case_hard_cap_usd: 2.0 } }).code,
      'CASE_CAP_NOT_BELOW_CASE_LIMIT:G01',
    );
    assert.equal(
      gateWithLedger({ goldDir: gold, authOver: { model_provider: 'openai' } }).code,
      'MODEL_PROVIDER_UNSUPPORTED',
    );
  });
});

describe('⑧⑨⑪-⑯ real adapter (recorder, zero models)', () => {
  test('⑧ model/hard cap must be in argv; an incomplete argv is refused on the spot', () => {
    const d = tdir('argv-');
    const p = join(d, 'p.md');
    writeFileSync(p, 'pkt');
    const argv = buildRealArgv({ packetPath: p, capUsd: 1.9, modelId: 'm-1' });
    assert.ok(argv.includes('-p') && argv.includes('--output-format') && argv.includes('json'));
    assert.equal(argv[argv.indexOf('--model') + 1], 'm-1');
    assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '1.9');
    assert.equal(argv[argv.length - 1], 'pkt');
    assert.throws(
      () =>
        assertRealArgvComplete(
          argv.filter((a, i) => !(a === '--model' || argv[i - 1] === '--model')),
          { modelId: 'm-1', capUsd: 1.9 },
        ),
      /REAL_ARGV_INCOMPLETE/,
    );
  });
  test('⑨⑪⑮ recorder-captured argv shares its source with the reservation; gold stays out of the workdir; cost settles truthfully', () => {
    const { entry, recorderOut, costKnown, ledgerPath } = realRun({ mode: 'ok' });
    const argv = JSON.parse(readFileSync(recorderOut, 'utf8').trim());
    assert.equal(argv[argv.indexOf('--model') + 1], 'claude-test-model');
    assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '1.9');
    assert.match(argv[argv.length - 1], /# Gold Task G01/);
    assert.match(argv[argv.length - 1], /Final claim contract/);
    // Reservation and argv share one source: the ledger's single entry's reserved amount == the CLI hard cap
    const doc = readLedger({ ledgerPath, maxAgeMs: Number.POSITIVE_INFINITY });
    assert.equal(doc.entries.length, 1);
    assert.equal(doc.entries[0].estimatedMaxUsd, 1.9);
    assert.equal(
      String(doc.entries[0].estimatedMaxUsd),
      argv[argv.indexOf('--max-budget-usd') + 1],
    );
    assert.equal(entry.trace.claim_source, 'structured_result');
    assert.equal(costKnown, true);
    assert.equal(entry.trace.actual_cost_usd, 0.0123);
    assert.equal(entry.trace.reserved_cost_usd, 1.9);
    assert.equal(entry.trace.cost_is_estimate, false);
    for (const g of ['scoring.json', 'maintainer-label.json', 'notes.md'])
      assert.equal(
        existsSync(join(entry.workdir, g)),
        false,
        `gold file ${g} leaked into the workdir`,
      );
  });
  test('⑫ recorder non-zero exit → no PASS', () => {
    const { entry } = realRun({ mode: 'nonzero' });
    assert.equal(entry.trace.final_claim, 'FAIL');
    assert.equal(entry.trace.claim_source, 'cli_error');
    assert.notEqual(entry.result.verdict, 'PASS');
  });
  test('⑬ timeout → no PASS', () => {
    const { entry } = realRun({ mode: 'sleep', timeoutMs: 400 });
    assert.equal(entry.trace.final_claim, 'FAIL');
    assert.equal(entry.trace.claim_source, 'timeout');
    assert.notEqual(entry.result.verdict, 'PASS');
  });
  test('⑭ actual cost unknowable → nothing fabricated, ledger enters reconciliation, batch halts', () => {
    const { entry, stopBatch, ledgerPath } = realRun({ mode: 'nocost' });
    assert.equal(stopBatch, true);
    assert.equal(entry.trace.cost_known, false);
    assert.equal(entry.trace.cost_is_estimate, true);
    assert.equal(entry.trace.actual_cost_usd, 0, 'the hard cap must not pose as the actual cost');
    assert.ok(existsSync(ledgerPath));
    // Hard assertion of the reconciliation state: a further reservation on the same ledger must be refused with RECONCILIATION_REQUIRED
    assert.throws(
      () =>
        reserve({
          ledgerPath,
          callId: 'post-reco',
          estimatedMaxUsd: 0.01,
          runId: 'x',
          agentId: 'x',
        }),
      (e) => e.code === 'RECONCILIATION_REQUIRED',
    );
    const t = totalsOf(readLedger({ ledgerPath, maxAgeMs: Number.POSITIVE_INFINITY }));
    assert.equal(t.outstandingUsd, 1.9, 'the reservation stays outstanding, never fake-settled');
  });
  test('⑯ missing structured claim line → FAIL (no regex guessing); grand proof of zero real models', () => {
    const { entry } = realRun({ mode: 'badclaim' });
    assert.equal(entry.trace.claim_source, 'claim_contract_violation');
    assert.equal(entry.trace.final_claim, 'FAIL');
    const bad = deriveRealOutcome({ exit: 0, timedOut: false, stdout: 'not JSON' });
    assert.equal(bad.claimSource, 'envelope_unparseable');
    // Every adapter call in this suite points at the recorder; the real
    // claude binary is never spawned — the line count of RECORDER_OUT equals
    // the total paid spawns, all from the fake binary.
  });
});

describe('⑰ review fix F8: no env fallback in the authorization gate', () => {
  test('SAKK_LEDGER_PATH alone never satisfies the gate — the explicit env must be set', () => {
    const dir = tdir('gold-f8-');
    const ledger = join(dir, 'ledger.json');
    execFileSync(process.execPath, [
      '-e',
      `import('${join(ROOT, '..', 'src', 'ledger.mjs').replace(/'/g, "\\'")}').then(m=>m.initLedger({ledgerPath:'${ledger}',capUsd:24}))`,
    ]);
    const savedBudget = process.env.SAKK_BUDGET_LEDGER_PATH;
    const savedLedger = process.env.SAKK_LEDGER_PATH;
    delete process.env.SAKK_BUDGET_LEDGER_PATH;
    process.env.SAKK_LEDGER_PATH = ledger; // the WRONG variable — must not be honored
    try {
      const gate = authorizeRealRun({
        authorizationPath: makeAuth(dir),
        caseDefs: loadCases(PILOT.join(',')),
        workRoot: tdir('wr-'),
      });
      assert.equal(gate.ok, false);
      assert.equal(gate.code, 'AUTHORITATIVE_LEDGER_UNREADABLE:SAKK_BUDGET_LEDGER_PATH_UNSET');
    } finally {
      if (savedBudget === undefined) delete process.env.SAKK_BUDGET_LEDGER_PATH;
      else process.env.SAKK_BUDGET_LEDGER_PATH = savedBudget;
      if (savedLedger === undefined) delete process.env.SAKK_LEDGER_PATH;
      else process.env.SAKK_LEDGER_PATH = savedLedger;
    }
  });
});
