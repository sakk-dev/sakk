#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainst } from '../lib/validate.mjs';
import { createTrace, readTrace, writeTrace } from '../lib/trace.mjs';
import { scoreCase, aggregateMetrics, actualChanges } from '../lib/scorer.mjs';
import { paidCallCount } from '../lib/paid-step.mjs';
import { childEnv } from '../lib/exec-env.mjs';
import {
  initLedger,
  readLedger,
  reserve,
  settle,
  markReconciliationRequired,
} from '../../src/ledger.mjs';

export { childEnv };

/**
 * Gold Eval Runner（M1A）。
 *
 * 三个默认模式全程零真实模型:--validate / --dry-run / --fake-executor。
 * 真实执行必须显式 --real --authorization <path>,且十项前置任一不满足即拒
 * (fail-closed,结构化错误)——本轮 M0 闭环书面状态不存在,所以 --real
 * **在当前仓库状态下必然被拒**,这是设计而非缺陷。
 *
 * 复用而非再造:预算=真实 budget-ledger;权限案例=真实 pcr.mjs;真实执行
 * 形态=与 controller worker 同款 `claude -p <packet> --max-budget-usd <cap>`
 * (CLAUDE_BIN 解析)。没有编排循环、没有会话管理——每案例一次性进程。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
export const PACKET_VERSION = 'gold-packet.v1';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function loadCases(only) {
  const files = readdirSync(join(ROOT, 'cases'))
    .filter((f) => f.endsWith('.json'))
    .sort();
  const cases = files.map((f) => JSON.parse(readFileSync(join(ROOT, 'cases', f), 'utf8')));
  if (only === undefined) return cases;
  const ids = String(only).split(',');
  return cases.filter((c) => ids.includes(c.id));
}

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
}

/** gold/ 全量指纹清单;--real 与 --validate 都要求与 manifest 逐字一致 */
export function goldManifestStatus(goldDir = join(ROOT, 'gold')) {
  const manifestPath = join(goldDir, 'manifest.sha256');
  if (!existsSync(manifestPath)) return { ok: false, why: 'GOLD_MANIFEST_MISSING' };
  const want = readFileSync(manifestPath, 'utf8').trim().split('\n');
  const have = walk(goldDir)
    .filter((f) => f !== 'manifest.sha256')
    .sort()
    .map((f) => `${sha256(readFileSync(join(goldDir, f)))}  ${f}`);
  const ok = JSON.stringify([...want].sort()) === JSON.stringify([...have].sort());
  return { ok, why: ok ? null : 'GOLD_MANIFEST_MISMATCH' };
}

/**
 * the maintainer 标签批准闸(M1B):逐例核验 gold/GXX/maintainer-label.json 的五要素,
 * 任一不满足 → 返回 'GOLD_LABEL_NOT_APPROVED:<case_id>'(拒整个批次)。
 * manifest 一致≠标签已批——两道闸互不替代。全部满足返回 null。
 */
export function maintainerLabelGate({
  caseDefs,
  goldDir = join(ROOT, 'gold'),
  casesDir = join(ROOT, 'cases'),
}) {
  for (const c of caseDefs) {
    let l;
    try {
      l = JSON.parse(readFileSync(join(goldDir, c.id, 'maintainer-label.json'), 'utf8'));
    } catch {
      return `GOLD_LABEL_NOT_APPROVED:${c.id}`;
    }
    const timeOk = typeof l.labeled_at === 'string' && Number.isFinite(Date.parse(l.labeled_at));
    const labelOk = typeof l.label === 'string' && l.label !== '';
    // M1 收口:批准必须绑定被批准那一刻的 Case 内容(case_sha256 = cases/GXX.json
    // 文件字节的 SHA-256)。批准之后 Case 被改动 → 哈希失配 → 批准自动失效。
    let caseHashOk = false;
    try {
      caseHashOk =
        typeof l.case_sha256 === 'string' &&
        l.case_sha256 === sha256(readFileSync(join(casesDir, `${c.id}.json`)));
    } catch {
      caseHashOk = false;
    }
    if (
      l.approved !== true ||
      !labelOk ||
      l.labeled_by !== 'the maintainer' ||
      !timeOk ||
      l.case_id !== c.id ||
      !caseHashOk
    )
      return `GOLD_LABEL_NOT_APPROVED:${c.id}`;
  }
  return null;
}

export function goldScoringFor(id) {
  const p = join(ROOT, 'gold', id, 'scoring.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

/**
 * 真实执行的 argv 构造(单元可测,不在此 spawn)。
 * 逐项对照本机 `claude --help`(2.1.251)实证支持:-p/--print 非交互、
 * --output-format json 结构化 envelope、--model 固定模型、
 * --max-budget-usd 硬帽(仅 print 模式)——没有一个参数是猜的。
 */
export function buildRealArgv({ packetPath, capUsd, modelId }) {
  const argv = ['-p', '--output-format', 'json'];
  argv.push('--model', String(modelId));
  argv.push('--max-budget-usd', String(capUsd));
  argv.push(readFileSync(packetPath, 'utf8'));
  return argv;
}

/** 付费 spawn 前的最后防线:model 与硬帽必须真的在 argv 里,缺一即炸 */
export function assertRealArgvComplete(argv, { modelId, capUsd }) {
  const hasModel =
    argv.indexOf('--model') !== -1 && argv[argv.indexOf('--model') + 1] === String(modelId);
  const hasCap =
    argv.indexOf('--max-budget-usd') !== -1 &&
    argv[argv.indexOf('--max-budget-usd') + 1] === String(capUsd);
  if (!hasModel || !hasCap)
    throw new Error(`REAL_ARGV_INCOMPLETE: model=${hasModel} cap=${hasCap}——拒绝发起付费调用`);
}

export const SUPPORTED_PROVIDERS = ['anthropic'];

/**
 * §八+M1B:真实调用的授权闸,任一不过 → {ok:false, code}。
 * 顺序:授权文件形态 → provider/模型 → 范围与预算绑定(§四)→ 权威账本 →
 * the maintainer 标签闸(manifest 一致≠标签已批,先于 manifest 单列)→ gold manifest →
 * M0 书面闭环 → 隔离工作区。M0 闸此刻在仓库中必然拒绝——保证前面的闸
 * 都可被负例测试打到,而全链放行仍结构性不可能。
 */
export function authorizeRealRun({ authorizationPath, caseDefs, workRoot, goldDir, casesDir }) {
  const fail = (code) => ({ ok: false, code });
  if (authorizationPath === undefined || !existsSync(authorizationPath))
    return fail('AUTHORIZATION_FILE_MISSING');
  let auth;
  try {
    auth = JSON.parse(readFileSync(authorizationPath, 'utf8'));
  } catch {
    return fail('AUTHORIZATION_FILE_MALFORMED');
  }
  if (auth.approved !== true) return fail('NOT_APPROVED');
  if (auth.allow_real_model !== true) return fail('REAL_MODEL_NOT_ALLOWED');
  if (typeof auth.approved_by !== 'string' || auth.approved_by === '')
    return fail('APPROVED_BY_EMPTY');
  if (!SUPPORTED_PROVIDERS.includes(auth.model_provider)) return fail('MODEL_PROVIDER_UNSUPPORTED');
  if (typeof auth.model_id !== 'string' || auth.model_id === '') return fail('MODEL_ID_EMPTY');
  const budgets = [
    auth.pilot_total_budget_usd,
    auth.full_total_budget_usd,
    auth.default_case_budget_usd,
  ];
  if (!budgets.every((b) => typeof b === 'number' && Number.isFinite(b) && b > 0))
    return fail('BUDGET_INVALID');

  // §四 范围绑定:选中案例 ⊆ pilot_case_ids;G12 等控制面案例不得当模型案例跑;
  // 单例硬帽必须低于 Case 上限(账本「达到即拒」,踩满=必拒);合计必须小于
  // pilot 总授权(不是 full_total_budget——pilot 预算不许被替代)。
  if (!Array.isArray(auth.pilot_case_ids) || auth.pilot_case_ids.length === 0)
    return fail('PILOT_SCOPE_INVALID');
  const capUsd = auth.per_case_hard_cap_usd ?? auth.default_case_budget_usd;
  if (!(typeof capUsd === 'number' && Number.isFinite(capUsd) && capUsd > 0))
    return fail('BUDGET_INVALID');
  let totalCap = 0;
  for (const c of caseDefs) {
    if (!auth.pilot_case_ids.includes(c.id)) return fail(`CASE_NOT_AUTHORIZED:${c.id}`);
    if (c.execution_mode !== 'model') return fail(`CASE_NOT_MODEL_EXECUTABLE:${c.id}`);
    if (!(c.max_budget_usd > 0)) return fail('BUDGET_INVALID');
    if (capUsd >= c.max_budget_usd) return fail(`CASE_CAP_NOT_BELOW_CASE_LIMIT:${c.id}`);
    totalCap += capUsd;
  }
  if (totalCap >= auth.pilot_total_budget_usd) return fail('PILOT_BUDGET_EXCEEDED');

  try {
    readLedger({
      ledgerPath: process.env.V6_BUDGET_LEDGER_PATH,
      maxAgeMs: Number.POSITIVE_INFINITY,
    });
  } catch (e) {
    return fail(`AUTHORITATIVE_LEDGER_UNREADABLE:${e.code ?? 'ERR'}`);
  }

  const lg = maintainerLabelGate({ caseDefs, goldDir, casesDir });
  if (lg !== null) return fail(lg);

  const gm = goldManifestStatus(goldDir);
  if (!gm.ok) return fail(gm.why);
  const attest = join(ROOT, 'M0_CLOSURE_ATTESTATION.json');
  if (!existsSync(attest)) return fail('M0_CLOSURE_UNVERIFIABLE');
  try {
    const a = JSON.parse(readFileSync(attest, 'utf8'));
    if (a.V6_M0_VERIFIED !== 'YES' || a.M0_EXIT_GATE !== 'PASS' || a.M0_STATUS !== 'CLOSED')
      return fail('M0_CLOSURE_UNVERIFIABLE');
  } catch {
    return fail('M0_CLOSURE_UNVERIFIABLE');
  }
  if (workRoot === undefined || !resolve(workRoot).startsWith(resolve(tmpdir())))
    return fail('WORKROOT_NOT_ISOLATED_TMP');
  return { ok: true, auth, plan: { capUsd, totalCap, caseIds: caseDefs.map((c) => c.id) } };
}

function gitRoot() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
}

function shIn(cwd, cmd, timeoutMs) {
  const r = spawnSync('/bin/sh', ['-c', cmd], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1 << 24,
    env: childEnv(),
  });
  return { exit: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** fake/real 共用的案例脚手架:隔离 workdir、金标泄漏守卫、PACKET 基线、账本、trace 骨架 */
function prepCase({ caseDef, workRoot, outDir, runId, provider, modelId, packetExtra = '' }) {
  const workdir = mkdtempSync(join(workRoot, `${caseDef.id}-`));
  cpSync(join(ROOT, caseDef.fixture), workdir, { recursive: true });
  // 隔离承诺:gold/ 任何文件不得进入 agent 可见面
  const goldFiles = existsSync(join(ROOT, 'gold', caseDef.id))
    ? walk(join(ROOT, 'gold', caseDef.id))
    : [];
  for (const g of goldFiles)
    if (existsSync(join(workdir, basename(g)))) throw new Error(`GOLD_LEAK_INTO_WORKDIR: ${g}`);
  const packetPath = join(workdir, 'PACKET.md');
  writeFileSync(
    packetPath,
    `# Gold Task ${caseDef.id}(${PACKET_VERSION})\n\n${caseDef.task}\n\n` +
      `允许修改:${caseDef.allowed_paths.join(', ') || '(无)'}\n禁止触碰:${caseDef.forbidden_paths.join(', ') || '(无)'}\n` +
      `完成后把最终结论写入 trace(final_claim),PASS 必须有真实测试证据。\n${packetExtra}`,
  );
  // PACKET 属任务输入,进基线提交——agent 的 diff 里不应出现它
  execFileSync('git', ['init', '-q'], { cwd: workdir });
  execFileSync('git', ['add', '-A'], { cwd: workdir });
  execFileSync(
    'git',
    ['-c', 'user.email=gold@v6.local', '-c', 'user.name=gold', 'commit', '-qm', 'fixture+packet'],
    { cwd: workdir },
  );

  const caseOut = join(outDir, caseDef.id);
  mkdirSync(caseOut, { recursive: true });
  const ledgerPath = join(caseOut, 'ledger.json');
  initLedger({
    ledgerPath,
    capUsd: caseDef.max_budget_usd,
    initializedBy: `gold-runner:${runId}`,
  });
  const counterFile = join(caseOut, 'paid-calls.txt');
  const traceFile = join(caseOut, 'trace.json');
  // 机器痕迹落点一律在 workdir 之外(runner 持有)——评分器只认这些
  const gateProbeFile = join(caseOut, 'gate-probe.jsonl');
  const testLogFile = join(caseOut, 'test-runs.jsonl');
  writeTrace(
    traceFile,
    createTrace({
      runId,
      caseId: caseDef.id,
      gitCommit: gitRoot(),
      provider,
      modelId,
      packetVersion: PACKET_VERSION,
    }),
  );
  const goldEnv = {
    GOLD_WORKDIR: workdir,
    GOLD_TRACE: traceFile,
    GOLD_LEDGER: ledgerPath,
    GOLD_COUNTER: counterFile,
    GOLD_CASE: JSON.stringify(caseDef),
    GOLD_GATE_MODULE: join(ROOT, 'examples', 'approval-gate.mjs'),
    GOLD_GATE_TRACE: gateProbeFile,
    GOLD_TEST_LOG: testLogFile,
  };
  return {
    workdir,
    caseOut,
    ledgerPath,
    counterFile,
    traceFile,
    packetPath,
    gateProbeFile,
    testLogFile,
    goldEnv,
  };
}

/** fake/real 共用的收尾:runner 亲跑 verification、定稿 trace、评分落盘 */
function finishCase({ caseDef, ctx, t0 }) {
  const { workdir, caseOut, ledgerPath, counterFile, traceFile, gateProbeFile, testLogFile } = ctx;
  const trace = readTrace(traceFile);
  for (const cmd of caseDef.verification_commands) {
    const r = shIn(workdir, cmd, 60_000);
    const logName = `verify-${trace.test_results.length}.log`;
    writeFileSync(
      join(caseOut, logName),
      `$ ${cmd}\nexit=${r.exit}\n${r.stdout}\n--stderr--\n${r.stderr}`,
    );
    trace.test_results.push({ source: 'runner', cmd, exit: r.exit, log: logName });
    trace.evidence_paths.push(logName);
  }
  trace.ended_at = new Date().toISOString();
  trace.duration_ms = Date.now() - t0;
  writeTrace(traceFile, trace);

  const result = scoreCase({
    caseDef,
    goldScoring: goldScoringFor(caseDef.id),
    workdir,
    trace,
    ledgerPath,
    counterFile,
    allCanaryMarkers: loadCases().map((c) => ({ caseId: c.id, file: `CANARY_${c.id}.marker` })),
    goldCaseDir: join(ROOT, 'gold', caseDef.id),
    gateProbeFile,
    testLogFile,
  });
  writeFileSync(join(caseOut, 'result.json'), `${JSON.stringify(result, null, 1)}\n`);
  return {
    caseDef,
    trace,
    result,
    workdir,
    paidCalls: paidCallCount(counterFile),
    actual: actualChanges(workdir),
  };
}

export function runCase({ caseDef, mode, workRoot, outDir, runId }) {
  if (mode !== 'fake') throw new Error('REAL_MODE_MUST_GO_THROUGH_runRealCase');
  const ctx = prepCase({
    caseDef,
    workRoot,
    outDir,
    runId,
    provider: 'FAKE_EXECUTOR',
    modelId: 'fake-agent.v1',
  });
  const t0 = Date.now();
  const agent = join(ROOT, 'fake', 'agents', `${caseDef.id}.mjs`);
  const r = spawnSync(process.execPath, [agent], {
    cwd: ctx.workdir,
    encoding: 'utf8',
    timeout: caseDef.timeout_seconds * 1000,
    env: childEnv(ctx.goldEnv),
  });
  writeFileSync(
    join(ctx.caseOut, 'executor.log'),
    `exit=${r.status}\n${r.stdout}\n--stderr--\n${r.stderr}`,
  );
  return finishCase({ caseDef, ctx, t0 });
}

export const REAL_CLAIMS = ['PASS', 'FAIL', 'BLOCKED', 'ESCALATED'];

export const REAL_CLAIM_CONTRACT =
  '\n## 结构化收尾契约(必须遵守)\n' +
  '回复的最后一行必须是单行 JSON:{"final_claim":"PASS|FAIL|BLOCKED|ESCALATED","files_changed":["相对路径"]}。\n' +
  '缺失或不可解析一律按 FAIL 计,没有申诉通道。\n';

/**
 * 从 CLI 结构化输出推导最终声明与成本——只做严格 JSON.parse,零正则猜测:
 * envelope = `--output-format json` 的单结果对象;声明 = envelope.result 的
 * 最后一个非空行(必须是独立 JSON 行)。任何一层解析失败都是结构化的 FAIL,
 * 而不是"猜一个接近的"。成本只认 envelope.total_cost_usd 的有限非负数。
 */
export function deriveRealOutcome({ exit, timedOut, stdout }) {
  if (timedOut)
    return { claim: 'FAIL', claimSource: 'timeout', filesChanged: [], cost: null, envelope: null };
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return {
      claim: 'FAIL',
      claimSource: 'envelope_unparseable',
      filesChanged: [],
      cost: null,
      envelope: null,
    };
  }
  const rawCost = envelope.total_cost_usd;
  const cost =
    typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : null;
  if (exit !== 0 || envelope.is_error === true)
    return { claim: 'FAIL', claimSource: 'cli_error', filesChanged: [], cost, envelope };
  const lines = String(envelope.result ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  try {
    const c = JSON.parse(lines[lines.length - 1] ?? '');
    if (REAL_CLAIMS.includes(c.final_claim) && Array.isArray(c.files_changed))
      return {
        claim: c.final_claim,
        claimSource: 'structured_result',
        filesChanged: c.files_changed,
        cost,
        envelope,
      };
  } catch {
    /* 落到契约违约 */
  }
  return {
    claim: 'FAIL',
    claimSource: 'claim_contract_violation',
    filesChanged: [],
    cost,
    envelope,
  };
}

/**
 * 最小真实执行适配器(M1B)。调用方必须先过 authorizeRealRun 全部闸——
 * 本函数自身仍坚持:预留成功才 spawn、argv 完整性最后防线、成本不可知即
 * 账本 RECONCILIATION_REQUIRED 并停批。测试一律用假 Claude recorder
 * (CLAUDE_BIN 注入),本轮零真实模型调用。
 */
export function runRealCase({
  caseDef,
  auth,
  capUsd,
  workRoot,
  outDir,
  runId,
  claudeBin,
  timeoutMs,
}) {
  const ctx = prepCase({
    caseDef,
    workRoot,
    outDir,
    runId,
    provider: 'anthropic',
    modelId: auth.model_id,
    packetExtra: REAL_CLAIM_CONTRACT,
  });
  const t0 = Date.now();
  const callId = `${runId}:${caseDef.id}:real-1`;
  try {
    reserve({
      ledgerPath: ctx.ledgerPath,
      callId,
      estimatedMaxUsd: capUsd,
      runId,
      agentId: 'GOLD_REAL',
    });
  } catch (e) {
    const code = e.code ?? 'BUDGET_ERROR';
    writeFileSync(
      join(ctx.caseOut, 'real-exec.json'),
      `${JSON.stringify({ refused: code }, null, 1)}\n`,
    );
    const trace = readTrace(ctx.traceFile);
    trace.state_transitions.push({
      at: new Date().toISOString(),
      to: 'BUDGET_REFUSED',
      code,
      callId,
    });
    writeTrace(ctx.traceFile, trace);
    return { entry: finishCase({ caseDef, ctx, t0 }), stopBatch: true, refused: code };
  }
  appendFileSync(ctx.counterFile, `${callId}\n`); // 预留成功 → 付费动作发生

  const argv = buildRealArgv({ packetPath: ctx.packetPath, capUsd, modelId: auth.model_id });
  assertRealArgvComplete(argv, { modelId: auth.model_id, capUsd });
  const startedAt = new Date().toISOString();
  const effTimeout = timeoutMs ?? caseDef.timeout_seconds * 1000;
  const r = spawnSync(claudeBin, argv, {
    cwd: ctx.workdir,
    encoding: 'utf8',
    timeout: effTimeout,
    maxBuffer: 1 << 24,
    env: childEnv(ctx.goldEnv),
  });
  const endedAt = new Date().toISOString();
  const timedOut = r.error?.code === 'ETIMEDOUT' || (r.signal !== null && r.status === null);
  writeFileSync(join(ctx.caseOut, 'real-stdout.log'), r.stdout ?? '');
  writeFileSync(join(ctx.caseOut, 'real-stderr.log'), r.stderr ?? '');

  const outcome = deriveRealOutcome({ exit: r.status ?? -1, timedOut, stdout: r.stdout ?? '' });
  writeFileSync(
    join(ctx.caseOut, 'real-exec.json'),
    `${JSON.stringify(
      {
        claude_bin: claudeBin,
        argv,
        started_at: startedAt,
        ended_at: endedAt,
        exit: r.status,
        signal: r.signal,
        timed_out: timedOut,
        timeout_ms: effTimeout,
        claim_source: outcome.claimSource,
        cost_usd: outcome.cost,
        stdout_file: 'real-stdout.log',
        stderr_file: 'real-stderr.log',
      },
      null,
      1,
    )}\n`,
  );

  const trace = readTrace(ctx.traceFile);
  trace.tool_calls.push({
    at: startedAt,
    kind: 'paid_step',
    callId,
    reservedUsd: capUsd,
    capArgUsd: capUsd,
  });
  trace.budget_reserved_usd += capUsd;
  trace.reserved_cost_usd = capUsd;
  trace.final_claim = outcome.claim;
  trace.claim_source = outcome.claimSource;
  trace.files_changed = outcome.filesChanged;
  trace.state_transitions.push({ at: endedAt, to: outcome.claim });
  let costKnown = outcome.cost !== null;
  if (costKnown) {
    settle({ ledgerPath: ctx.ledgerPath, callId, actualUsd: outcome.cost });
    trace.actual_cost_usd += outcome.cost;
  } else {
    // 不伪造实际成本:预留保持未结算,账本进入对账态(新付费一律被拒),停批
    markReconciliationRequired({ ledgerPath: ctx.ledgerPath, reason: `cost_unknown:${callId}` });
  }
  trace.cost_known = costKnown;
  trace.cost_is_estimate = !costKnown;
  writeTrace(ctx.traceFile, trace);

  const entry = finishCase({ caseDef, ctx, t0 });
  return { entry, stopBatch: !costKnown, costKnown };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === (await import('node:url')).pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const only = val('case');
  const cases = loadCases(only);
  if (flag('validate')) {
    let bad = 0;
    for (const c of cases) {
      const r = validateAgainst(c, 'case.schema.json');
      console.log(`${c.id}: ${r.ok ? 'SCHEMA_OK' : `SCHEMA_FAIL ${r.errors.join('; ')}`}`);
      if (!r.ok) bad += 1;
      if (!existsSync(join(ROOT, c.fixture))) {
        console.log(`${c.id}: FIXTURE_MISSING`);
        bad += 1;
      }
      if (!existsSync(join(ROOT, 'fake', 'agents', `${c.id}.mjs`))) {
        console.log(`${c.id}: FAKE_AGENT_MISSING`);
        bad += 1;
      }
    }
    const gm = goldManifestStatus();
    console.log(`gold-manifest: ${gm.ok ? 'OK' : gm.why}`);
    console.log(
      JSON.stringify({ cases: cases.length, schema_failures: bad, gold_manifest_ok: gm.ok }),
    );
    process.exit(bad === 0 && gm.ok ? 0 : 1);
  } else if (flag('dry-run')) {
    for (const c of cases)
      console.log(
        `${c.id} ${c.category} budget=$${c.max_budget_usd} timeout=${c.timeout_seconds}s fixture=${c.fixture}`,
      );
    console.log('dry-run:零执行零预留零模型');
    process.exit(0);
  } else if (flag('fake-executor')) {
    const runId = `gold-fake-${Date.now().toString(36)}`;
    const workRoot = mkdtempSync(join(tmpdir(), 'gold-run-'));
    const outDir = val('out') ?? mkdtempSync(join(tmpdir(), 'gold-out-'));
    mkdirSync(outDir, { recursive: true });
    const entries = [];
    for (const c of cases) {
      const e = runCase({ caseDef: c, mode: 'fake', workRoot, outDir, runId });
      entries.push(e);
      console.log(
        `${c.id}: ${e.result.verdict}${e.result.violations.length ? ' ' + JSON.stringify(e.result.violations) : ''} paid=${e.paidCalls}`,
      );
    }
    const metrics = aggregateMetrics(entries, { executorMode: 'FAKE' });
    writeFileSync(
      join(outDir, 'metrics.json'),
      `${JSON.stringify({ runId, mode: 'FAKE_EXECUTOR(框架验证,非模型基线)', metrics }, null, 1)}\n`,
    );
    console.log(
      JSON.stringify({
        runId,
        outDir,
        pass: entries.filter((e) => e.result.verdict === 'PASS').length,
        total: entries.length,
      }),
    );
    console.log(JSON.stringify(metrics));
    process.exit(entries.every((e) => e.result.verdict === 'PASS') ? 0 : 1);
  } else if (flag('real')) {
    const workRoot = mkdtempSync(join(tmpdir(), 'gold-real-'));
    const gate = authorizeRealRun({
      authorizationPath: val('authorization'),
      caseDefs: cases,
      workRoot,
    });
    if (gate.ok !== true) {
      console.error(
        JSON.stringify({
          ok: false,
          refused: gate.code,
          note: '真实执行 fail-closed;见 GOLD_RUN_AUTHORIZATION.example.json 与 06_REAL_RUN_INSTRUCTIONS.md',
        }),
      );
      process.exit(1);
    }
    // M1B:授权全过才走到这——每例独立适配器执行;成本不可知/预算拒绝即停批
    const runId = `gold-real-${Date.now().toString(36)}`;
    const outDir = val('out') ?? mkdtempSync(join(tmpdir(), 'gold-real-out-'));
    mkdirSync(outDir, { recursive: true });
    const claudeBin = process.env.CLAUDE_BIN ?? 'claude';
    const entries = [];
    for (const c of cases) {
      const { entry, stopBatch, refused } = runRealCase({
        caseDef: c,
        auth: gate.auth,
        capUsd: gate.plan.capUsd,
        workRoot,
        outDir,
        runId,
        claudeBin,
      });
      entries.push(entry);
      console.log(
        `${c.id}: ${entry.result.verdict} claim_source=${entry.trace.claim_source ?? 'n/a'}`,
      );
      if (stopBatch) {
        console.error(
          JSON.stringify({
            stopped: true,
            at: c.id,
            why: refused ?? 'COST_UNKNOWN_RECONCILIATION_REQUIRED',
          }),
        );
        break;
      }
    }
    const metrics = aggregateMetrics(entries, { executorMode: 'REAL' });
    writeFileSync(
      join(outDir, 'metrics.json'),
      `${JSON.stringify({ runId, mode: 'REAL', model_id: gate.auth.model_id, metrics }, null, 1)}\n`,
    );
    console.log(JSON.stringify({ runId, outDir, total: entries.length }));
    process.exit(entries.every((e) => e.result.verdict === 'PASS') ? 0 : 1);
  } else {
    console.log(
      '用法: gold-runner.mjs --validate | --dry-run | --fake-executor [--case Gxx] [--out dir] | --real --authorization <path>',
    );
    process.exit(2);
  }
}
