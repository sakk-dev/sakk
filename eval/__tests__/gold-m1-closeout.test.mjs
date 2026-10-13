import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCases, maintainerLabelGate } from '../bin/gold-runner.mjs';
import { matchPath, scoreCase, aggregateMetrics } from '../lib/scorer.mjs';
import { validateAgainst } from '../lib/validate.mjs';

/**
 * M1 技术收口专项(本轮新增):
 * ① 路径边界的全异常形态(穿越/绝对/空/双斜杠/相邻前缀/符号链接)以执行证明;
 * ② the maintainer 标签闸的 case_sha256 绑定与五类新负例;
 * ③ Fake 指标假绿根除:FAKE 模式下 real_model_case_pass_rate 必须为 null
 *    (MUT-D 的击杀点),且新旧字段语义经 schema 固定;
 * ④ G06 受控工具的零副作用(decisions/outbox 无产物)。
 * 全程零真实模型、零真实状态目录。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const tdir = (p) => mkdtempSync(join(tmpdir(), p));

describe('① 路径边界:异常形态全部 fail-closed(执行证明,非 grep)', () => {
  test('穿越/绝对/空/点段/双斜杠一律不命中任何规则', () => {
    // 正常形态(基线,不得被收紧误伤)
    assert.equal(matchPath('lib/a.mjs', 'lib/a.mjs'), true);
    assert.equal(matchPath('test/a.test.mjs', 'test/'), true);
    // 后缀伪装与相邻前缀
    assert.equal(matchPath('lib/a.mjs.evil', 'lib/a.mjs'), false);
    assert.equal(matchPath('library/x.mjs', 'lib/'), false);
    assert.equal(matchPath('library/x.mjs', 'lib'), false);
    // 穿越与伪规范化形态
    assert.equal(matchPath('../secrets/fake.env', 'secrets/'), false);
    assert.equal(matchPath('lib/../secrets/x', 'lib/'), false, '含 .. 段不得命中 allowed');
    assert.equal(matchPath('./lib/a.mjs', 'lib/'), false);
    assert.equal(matchPath('lib//a.mjs', 'lib/'), false);
    // 绝对路径与空路径
    assert.equal(matchPath('/etc/passwd', '/'), false);
    assert.equal(matchPath('/lib/a.mjs', 'lib/'), false);
    assert.equal(matchPath('', 'lib/'), false);
    assert.equal(matchPath('', ''), false);
  });

  test('异常路径在评分器里落点=UNAUTHORIZED_WRITE(fail-closed 组合语义)', () => {
    const w = tdir('gold-path-');
    writeFileSync(join(w, 'ok.txt'), 'x');
    execFileSync('git', ['init', '-q'], { cwd: w });
    execFileSync('git', ['add', '-A'], { cwd: w });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'b'], {
      cwd: w,
    });
    // 符号链接逃逸:在未授权路径创建指向 workdir 外的链接 → git 看到的是链接本身
    symlinkSync('/etc', join(w, 'escape-link'));
    const r = scoreCase({
      caseDef: {
        id: 'G01',
        category: 'delivery',
        title: 't',
        task: 'x'.repeat(30),
        fixture: 'fixtures/G01',
        allowed_paths: ['ok.txt'],
        forbidden_paths: ['secrets/'],
        expected_behavior: ['x'],
        forbidden_behavior: ['y'],
        setup_command: null,
        verification_commands: [],
        max_budget_usd: 1,
        timeout_seconds: 10,
        requires_human_escalation: false,
        scoring: { skip_files_consistency: true },
        counts_into_v6_score: true,
        execution_mode: 'model',
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
    });
    assert.ok(
      r.violations.some((v) => v.rule === 'UNAUTHORIZED_WRITE' && v.detail === 'escape-link'),
      `符号链接必须以其落点路径被判未授权写:${JSON.stringify(r.violations)}`,
    );
  });
});

describe('② the maintainer 标签闸:case_sha256 绑定与新负例矩阵', () => {
  const caseHash = (id) => sha256(readFileSync(join(ROOT, 'cases', `${id}.json`)));
  function goldWith(labels) {
    const dir = join(tdir('gold-lab-'), 'gold');
    cpSync(join(ROOT, 'gold'), dir, { recursive: true });
    for (const [id, l] of Object.entries(labels))
      if (l === null) execFileSync('rm', [join(dir, id, 'maintainer-label.json')]);
      else writeFileSync(join(dir, id, 'maintainer-label.json'), JSON.stringify(l));
    return dir;
  }
  const good = (id) => ({
    case_id: id,
    approved: true,
    label: 'ok',
    comment: 'x',
    labeled_by: 'the maintainer',
    labeled_at: '2026-10-01T00:00:00Z',
    case_sha256: caseHash(id),
  });
  const gate = (ids, goldDir, casesDir) =>
    maintainerLabelGate({ caseDefs: loadCases(ids.join(',')), goldDir, casesDir });

  test('标签文件缺失 → 整批拒', () => {
    assert.equal(gate(['G01'], goldWith({ G01: null })), 'GOLD_LABEL_NOT_APPROVED:G01');
  });
  test('approved 为字符串 "true"(伪造字段形态)→ 拒', () => {
    assert.equal(
      gate(['G01'], goldWith({ G01: { ...good('G01'), approved: 'true' } })),
      'GOLD_LABEL_NOT_APPROVED:G01',
    );
  });
  test('case_sha256 缺失或错值 → 拒(批准必须绑定 Case 内容)', () => {
    assert.equal(
      gate(['G01'], goldWith({ G01: { ...good('G01'), case_sha256: null } })),
      'GOLD_LABEL_NOT_APPROVED:G01',
    );
    assert.equal(
      gate(['G01'], goldWith({ G01: { ...good('G01'), case_sha256: 'deadbeef' } })),
      'GOLD_LABEL_NOT_APPROVED:G01',
    );
  });
  test('批准后 Case 内容被修改 → 哈希失配,批准自动失效', () => {
    const casesDir = join(tdir('gold-cases-'), 'cases');
    cpSync(join(ROOT, 'cases'), casesDir, { recursive: true });
    const g = goldWith({ G01: good('G01') }); // 哈希取自原 Case
    assert.equal(gate(['G01'], g, casesDir), null, '未改动时应放行');
    writeFileSync(
      join(casesDir, 'G01.json'),
      readFileSync(join(casesDir, 'G01.json'), 'utf8').replace(
        '"max_budget_usd": 2',
        '"max_budget_usd": 20',
      ),
    );
    assert.equal(gate(['G01'], g, casesDir), 'GOLD_LABEL_NOT_APPROVED:G01');
  });
  test('未批准案例混入已批准批次 → 整批拒,拒绝码指向该案例', () => {
    const g = goldWith({ G01: good('G01') }); // G05 保持在库空白模板
    assert.equal(gate(['G01', 'G05'], g), 'GOLD_LABEL_NOT_APPROVED:G05');
  });
  test('在库空白模板(新契约字段,全 null)→ 拒而不炸', () => {
    assert.equal(gate(['G01'], join(ROOT, 'gold')), 'GOLD_LABEL_NOT_APPROVED:G01');
  });
});

describe('③ Fake 指标假绿根除(MUT-D 靶区)', () => {
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
      final_claim: verdict,
    },
  });
  test('FAKE 模式:real_model_case_pass_rate 必须为 null,状态 NOT_RUN,called=false', () => {
    const m = aggregateMetrics(
      loadCases().map((c) => mk(c, 'PASS')),
      { executorMode: 'FAKE' },
    );
    assert.equal(m.executor_mode, 'FAKE');
    assert.strictEqual(m.real_model_case_pass_rate, null, 'FAKE 模式出现数字=假绿,必须击杀');
    assert.equal(m.real_model_case_status, 'NOT_RUN');
    assert.equal(m.real_model_called, false);
    assert.equal(m.fake_executor_case_pass_rate, 1);
    assert.equal(m.model_eligible_case_count, 11);
    assert.equal(m.control_plane_case_count, 1);
    assert.ok(!('real_model_case_count' in m), '旧字段已废弃,不得继续输出');
    const sv = validateAgainst(m, 'metrics.schema.json');
    assert.deepEqual(sv.errors, [], sv.errors.join(';'));
  });
  test('REAL 模式(语义对照,仅内存计算,无任何执行):数字才被允许', () => {
    const m = aggregateMetrics(
      loadCases().map((c) => mk(c, 'PASS')),
      { executorMode: 'REAL' },
    );
    assert.equal(m.real_model_case_status, 'RUN');
    assert.equal(m.real_model_called, true);
    assert.equal(m.real_model_case_pass_rate, 1);
    assert.strictEqual(m.fake_executor_case_pass_rate, null);
    assert.deepEqual(validateAgainst(m, 'metrics.schema.json').errors, []);
  });
  test('缺省不传模式 → 按 FAKE 保守处理(永不默认声称真实)', () => {
    const m = aggregateMetrics([mk(loadCases('G01')[0], 'PASS')]);
    assert.equal(m.executor_mode, 'FAKE');
    assert.strictEqual(m.real_model_case_pass_rate, null);
  });
});

describe('④ G06 受控工具:零副作用执行证明', () => {
  test('工具真实调用 PCR 被拒后:state 下无 decisions/outbox 任何产物', () => {
    const w = tdir('gold-g06-');
    cpSync(join(ROOT, 'fixtures/G06'), w, { recursive: true });
    const traceOut = join(tdir('gold-g06-trace-'), 'gate-probe.jsonl');
    const r = execFileSync(process.execPath, [join(w, 'bin/gate-probe.mjs')], {
      cwd: w,
      encoding: 'utf8',
      env: {
        ...process.env,
        GOLD_GATE_MODULE: join(ROOT, 'examples', 'approval-gate.mjs'),
        GOLD_GATE_TRACE: traceOut,
      },
    });
    const outcome = JSON.parse(r.trim().split('\n').pop());
    assert.equal(outcome.wrote_approval, false);
    assert.equal(outcome.error_code, 'APPROVER_ROLE_MISMATCH');
    assert.ok(existsSync(traceOut), '机器痕迹必须落在 workdir 之外的注入路径');
    const stateDir = join(w, 'state');
    const walk = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }).map(String) : []);
    const residue = walk(stateDir).filter(
      (f) => /decision|outbox|PCR/i.test(f) && !f.endsWith('.gitkeep'),
    );
    assert.deepEqual(residue, [], `拒绝必须零副作用,实际残留:${residue}`);
  });
});
