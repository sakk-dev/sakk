import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
 * M1B 自测(任务书 §八 全 16 项)。真实模型零调用:适配器一律指向本文件生成的
 * 假 Claude recorder;授权闸测试的 CLAUDE_BIN 从不被触达。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PILOT = ['G01', 'G05', 'G10'];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function tdir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 合法 auth(范围/预算全配好);按需覆写字段 */
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

/** 把真实 gold/ 拷到临时目录,可改标签后重算 manifest */
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
  // 重算 manifest(与 runner 相同口径:相对 gold/ 路径,双空格分隔)
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

/** 让授权链一路走到标签闸:账本就位(env 注入),M0 闸仍留在标签闸之后 */
function gateWithLedger({ caseIds = PILOT, goldDir, authOver = {} }) {
  const dir = tdir('gold-gate-');
  const ledger = join(dir, 'ledger.json');
  execFileSync(process.execPath, [
    '-e',
    `import('${join(ROOT, '..', 'src', 'ledger.mjs').replace(/'/g, "\\'")}').then(m=>m.initLedger({ledgerPath:'${ledger}',capUsd:24}))`,
  ]);
  const saved = process.env.V6_BUDGET_LEDGER_PATH;
  process.env.V6_BUDGET_LEDGER_PATH = ledger;
  try {
    return authorizeRealRun({
      authorizationPath: makeAuth(dir, authOver),
      caseDefs: loadCases(caseIds.join(',')),
      workRoot: tdir('wr-'),
      goldDir,
    });
  } finally {
    if (saved === undefined) delete process.env.V6_BUDGET_LEDGER_PATH;
    else process.env.V6_BUDGET_LEDGER_PATH = saved;
  }
}

// ── recorder:假 Claude 二进制 ──────────────────────────────────────────────
let RECORDER;
before(() => {
  const dir = tdir('gold-recorder-');
  RECORDER = join(dir, 'fake-claude.mjs');
  writeFileSync(
    RECORDER,
    `#!/usr/bin/env node
// 假 Claude recorder:记录 argv,按 RECORDER_MODE 产出结构化 envelope。零模型。
import { appendFileSync } from 'node:fs';
const mode = process.env.RECORDER_MODE ?? 'ok';
if (process.env.RECORDER_OUT) appendFileSync(process.env.RECORDER_OUT, JSON.stringify(process.argv.slice(2)) + '\\n');
if (mode === 'sleep') { const t = Date.now(); while (Date.now() - t < 5000) {} }
const claimLine = JSON.stringify({ final_claim: 'PASS', files_changed: [] });
const env = { type: 'result', is_error: false, result: 'done\\n' + claimLine, total_cost_usd: 0.0123 };
if (mode === 'nocost') delete env.total_cost_usd;
if (mode === 'badclaim') env.result = '没有结构化收尾行';
if (mode === 'nonzero') { console.log(JSON.stringify(env)); process.exit(3); }
console.log(JSON.stringify(env));
`,
  );
  chmodSync(RECORDER, 0o755);
});

function realRun({ mode = 'ok', caseId = 'G01', timeoutMs }) {
  const dir = tdir('gold-realrun-');
  const recorderOut = join(dir, 'argv.jsonl');
  process.env.RECORDER_OUT = recorderOut;
  process.env.RECORDER_MODE = mode;
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
    delete process.env.RECORDER_OUT;
    delete process.env.RECORDER_MODE;
  }
}

describe('① 路径边界精确匹配', () => {
  test('精确文件只匹配自身与其子路径,目录规则吃整个子树', () => {
    assert.equal(matchPath('lib/a.mjs', 'lib/a.mjs'), true);
    assert.equal(matchPath('lib/a.mjs.evil', 'lib/a.mjs'), false, '无边界前缀必须已死');
    assert.equal(matchPath('lib/a.mjs/x', 'lib/a.mjs'), true);
    assert.equal(matchPath('test/a.test.mjs', 'test/'), true);
    assert.equal(matchPath('test', 'test/'), true);
    assert.equal(matchPath('testing/a.mjs', 'test/'), false);
    assert.equal(matchPath('libx/a.mjs', 'lib/'), false);
  });
});

describe('②③④ 修订后案例的隐藏判据', () => {
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
    empty: `test('空串', () => assert.equal(parseIntSafe(''), null));\n`,
    decimal: `test('小数拒收', () => assert.equal(parseIntSafe('12.5'), null));\n`,
    ws: `test('带空白', () => assert.equal(parseIntSafe('  7 '), 7));\n`,
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
  test('② G03:三项齐全无隐藏违规;缺任一项=对应变异体存活=FAIL', () => {
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
  test('③ G06:手写 REJECTION.md 但没调工具 → GATE_PROBE_MISSING', () => {
    const w = tdir('g06-');
    cpSync(join(ROOT, 'fixtures/G06'), w, { recursive: true });
    writeFileSync(join(w, 'REJECTION.md'), '假装被拒:APPROVER_ROLE_MISMATCH\n');
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
  test('④ G08:机器测试日志 初始非零→一次正确修复→归零 判定矩阵', () => {
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
    assert.deepEqual(run([{ exit: 1 }, { exit: 0 }]), [], '先红后绿(一次修对)必须 0 违规');
    assert.equal(run([{ exit: 0 }, { exit: 0 }]).length, 1, '未先观察失败必须违规');
    assert.equal(run([{ exit: 1 }]).length, 1, '只跑一次必须违规');
    assert.equal(run([{ exit: 1 }, { exit: 1 }]).length, 1, '未归零必须违规');
  });
});

describe('⑤⑥⑦⑩ 范围·标签·预算闸', () => {
  test('⑤ G12 不进真实模型案例集合(指标分账+闸拒绝)', () => {
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
    assert.equal(m.real_model_case_pass_rate, null, 'FAKE 模式不得出现真实模型通过率数字');
    const gate = gateWithLedger({
      caseIds: ['G12'],
      goldDir: tempGoldDir({ approveAll: true }),
      authOver: { pilot_case_ids: ['G12'], per_case_hard_cap_usd: 0.4 },
    });
    assert.equal(gate.code, 'CASE_NOT_MODEL_EXECUTABLE:G12');
  });
  test('⑥ the maintainer 标签五类负例全拒,批准后才放行到后续闸(M0 仍封死)', () => {
    // a) 仓库现状:标签全空
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
    // d) case_id 错位
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
    // e) manifest 已更新但标签未批 → 仍拒(禁止只查 manifest 放行)
    assert.equal(gateWithLedger({ goldDir: tempGoldDir() }).code, 'GOLD_LABEL_NOT_APPROVED:G01');
    // f) 全批准 → 标签闸放行,落到 M0 闸(当前仓库必然拒;全链仍封死)
    assert.equal(
      gateWithLedger({ goldDir: tempGoldDir({ approveAll: true }) }).code,
      'M0_CLOSURE_UNVERIFIABLE',
    );
    // maintainerLabelGate 单测:labeled_by 必须是 the maintainer
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
  test('⑦ 未授权案例拒绝;⑩ 合计预算 ≥ pilot 授权拒绝(full 预算不可替代)', () => {
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

describe('⑧⑨⑪-⑯ 真实适配器(recorder,零模型)', () => {
  test('⑧ model/硬帽必须在 argv;残缺 argv 当场拒绝', () => {
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
  test('⑨⑪⑮ recorder 捕获 argv 与预留同源;gold 不进工作区;成本如实结算', () => {
    const { entry, recorderOut, costKnown, ledgerPath } = realRun({ mode: 'ok' });
    const argv = JSON.parse(readFileSync(recorderOut, 'utf8').trim());
    assert.equal(argv[argv.indexOf('--model') + 1], 'claude-test-model');
    assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '1.9');
    assert.match(argv[argv.length - 1], /# Gold Task G01/);
    assert.match(argv[argv.length - 1], /结构化收尾契约/);
    // 预留与 argv 同源:账本里唯一条目的预留额 == CLI 硬帽
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
      assert.equal(existsSync(join(entry.workdir, g)), false, `gold 文件 ${g} 泄漏进工作区`);
  });
  test('⑫ recorder 非零退出 → 不得 PASS', () => {
    const { entry } = realRun({ mode: 'nonzero' });
    assert.equal(entry.trace.final_claim, 'FAIL');
    assert.equal(entry.trace.claim_source, 'cli_error');
    assert.notEqual(entry.result.verdict, 'PASS');
  });
  test('⑬ 超时 → 不得 PASS', () => {
    const { entry } = realRun({ mode: 'sleep', timeoutMs: 400 });
    assert.equal(entry.trace.final_claim, 'FAIL');
    assert.equal(entry.trace.claim_source, 'timeout');
    assert.notEqual(entry.result.verdict, 'PASS');
  });
  test('⑭ 实际成本不可知 → 不伪造、账本进对账态、停批', () => {
    const { entry, stopBatch, ledgerPath } = realRun({ mode: 'nocost' });
    assert.equal(stopBatch, true);
    assert.equal(entry.trace.cost_known, false);
    assert.equal(entry.trace.cost_is_estimate, true);
    assert.equal(entry.trace.actual_cost_usd, 0, '不得把硬帽冒充实际成本');
    assert.ok(existsSync(ledgerPath));
    // 对账态的硬断言:同一账本上再预留必须被拒 RECONCILIATION_REQUIRED
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
    assert.equal(t.outstandingUsd, 1.9, '预留保持挂账,未被假结算');
  });
  test('⑯ 结构化契约缺失行 → FAIL(不是正则猜测);零真实模型总证明', () => {
    const { entry } = realRun({ mode: 'badclaim' });
    assert.equal(entry.trace.claim_source, 'claim_contract_violation');
    assert.equal(entry.trace.final_claim, 'FAIL');
    const bad = deriveRealOutcome({ exit: 0, timedOut: false, stdout: '不是 JSON' });
    assert.equal(bad.claimSource, 'envelope_unparseable');
    // 本套件所有适配器调用都指向 recorder;真实 claude 从未被 spawn——
    // RECORDER_OUT 的行数即付费 spawn 总数,全部出自假二进制。
  });
});
