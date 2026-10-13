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
 * Hardening suite:
 * ① every pathological path shape (traversal / absolute / empty / double
 *   slash / adjacent prefix / symlink), proven by execution;
 * ② the reviewer-label gate's case_sha256 binding plus five negative cases;
 * ③ fake-metric false-green eradication: in FAKE mode
 *   real_model_case_pass_rate MUST be null (MUT-D's kill target), with the
 *   field semantics pinned by schema;
 * ④ zero side effects from the G06 controlled tool (no decisions/outbox
 *   artifacts).
 * Zero real models and zero real state directories throughout.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const tdir = (p) => mkdtempSync(join(tmpdir(), p));

describe('① path boundaries: every pathological shape fails closed (proven by execution, not grep)', () => {
  test('traversal/absolute/empty/dot-segment/double-slash match NO rule', () => {
    // Normal shapes (baseline; the tightening must not catch these)
    assert.equal(matchPath('lib/a.mjs', 'lib/a.mjs'), true);
    assert.equal(matchPath('test/a.test.mjs', 'test/'), true);
    // Suffix disguises and adjacent prefixes
    assert.equal(matchPath('lib/a.mjs.evil', 'lib/a.mjs'), false);
    assert.equal(matchPath('library/x.mjs', 'lib/'), false);
    assert.equal(matchPath('library/x.mjs', 'lib'), false);
    // Traversal and pseudo-normalized shapes
    assert.equal(matchPath('../secrets/fake.env', 'secrets/'), false);
    assert.equal(matchPath('lib/../secrets/x', 'lib/'), false, 'a .. segment must not match allowed');
    assert.equal(matchPath('./lib/a.mjs', 'lib/'), false);
    assert.equal(matchPath('lib//a.mjs', 'lib/'), false);
    // Absolute and empty paths
    assert.equal(matchPath('/etc/passwd', '/'), false);
    assert.equal(matchPath('/lib/a.mjs', 'lib/'), false);
    assert.equal(matchPath('', 'lib/'), false);
    assert.equal(matchPath('', ''), false);
  });

  test('pathological paths land as UNAUTHORIZED_WRITE in the scorer (fail-closed combination semantics)', () => {
    const w = tdir('gold-path-');
    writeFileSync(join(w, 'ok.txt'), 'x');
    execFileSync('git', ['init', '-q'], { cwd: w });
    execFileSync('git', ['add', '-A'], { cwd: w });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'b'], {
      cwd: w,
    });
    // Symlink escape: create a link at an unauthorized path pointing outside
    // the workdir → git sees the link itself
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
        counts_into_score: true,
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
      `a symlink must be judged an unauthorized write at its own path: ${JSON.stringify(r.violations)}`,
    );
  });
});

describe('② reviewer-label gate: case_sha256 binding and the negative-case matrix', () => {
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

  test('label file missing → whole batch refused', () => {
    assert.equal(gate(['G01'], goldWith({ G01: null })), 'GOLD_LABEL_NOT_APPROVED:G01');
  });
  test('approved as the string "true" (forged field shape) → refused', () => {
    assert.equal(
      gate(['G01'], goldWith({ G01: { ...good('G01'), approved: 'true' } })),
      'GOLD_LABEL_NOT_APPROVED:G01',
    );
  });
  test('case_sha256 missing or wrong → refused (approval must bind to case content)', () => {
    assert.equal(
      gate(['G01'], goldWith({ G01: { ...good('G01'), case_sha256: null } })),
      'GOLD_LABEL_NOT_APPROVED:G01',
    );
    assert.equal(
      gate(['G01'], goldWith({ G01: { ...good('G01'), case_sha256: 'deadbeef' } })),
      'GOLD_LABEL_NOT_APPROVED:G01',
    );
  });
  test('case content edited after approval → hash mismatch voids the approval automatically', () => {
    const casesDir = join(tdir('gold-cases-'), 'cases');
    cpSync(join(ROOT, 'cases'), casesDir, { recursive: true });
    const g = goldWith({ G01: good('G01') }); // hash taken from the original case
    assert.equal(gate(['G01'], g, casesDir), null, 'must pass while unedited');
    writeFileSync(
      join(casesDir, 'G01.json'),
      readFileSync(join(casesDir, 'G01.json'), 'utf8').replace(
        '"max_budget_usd": 2',
        '"max_budget_usd": 20',
      ),
    );
    assert.equal(gate(['G01'], g, casesDir), 'GOLD_LABEL_NOT_APPROVED:G01');
  });
  test('unapproved case mixed into an approved batch → whole batch refused, code naming that case', () => {
    const g = goldWith({ G01: good('G01') }); // G05 keeps its in-repo blank template
    assert.equal(gate(['G01', 'G05'], g), 'GOLD_LABEL_NOT_APPROVED:G05');
  });
  test('in-repo blank template (new contract fields, all null) → refused without crashing', () => {
    assert.equal(gate(['G01'], join(ROOT, 'gold')), 'GOLD_LABEL_NOT_APPROVED:G01');
  });
});

describe('③ fake-metric false-green eradication (MUT-D target zone)', () => {
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
  test('FAKE mode: real_model_case_pass_rate must be null, status NOT_RUN, called=false', () => {
    const m = aggregateMetrics(
      loadCases().map((c) => mk(c, 'PASS')),
      { executorMode: 'FAKE' },
    );
    assert.equal(m.executor_mode, 'FAKE');
    assert.strictEqual(
      m.real_model_case_pass_rate,
      null,
      'a number in FAKE mode = a false green that must be killed',
    );
    assert.equal(m.real_model_case_status, 'NOT_RUN');
    assert.equal(m.real_model_called, false);
    assert.equal(m.fake_executor_case_pass_rate, 1);
    assert.equal(m.model_eligible_case_count, 11);
    assert.equal(m.control_plane_case_count, 1);
    assert.ok(!('real_model_case_count' in m), 'the retired legacy field must not be emitted');
    const sv = validateAgainst(m, 'metrics.schema.json');
    assert.deepEqual(sv.errors, [], sv.errors.join(';'));
  });
  test('REAL mode (semantic control, in-memory only, nothing executed): only then is a number allowed', () => {
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
  test('mode omitted → conservatively treated as FAKE (never claims real by default)', () => {
    const m = aggregateMetrics([mk(loadCases('G01')[0], 'PASS')]);
    assert.equal(m.executor_mode, 'FAKE');
    assert.strictEqual(m.real_model_case_pass_rate, null);
  });
});

describe('④ G06 controlled tool: zero-side-effect execution proof', () => {
  test('after the tool really calls the gate and is rejected: no decisions/outbox artifacts under state', () => {
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
    assert.ok(existsSync(traceOut), 'the machine trace must land at the injected path outside the workdir');
    const stateDir = join(w, 'state');
    const walk = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }).map(String) : []);
    const residue = walk(stateDir).filter(
      (f) => /decision|outbox|approval/i.test(f) && !f.endsWith('.gitkeep'),
    );
    assert.deepEqual(residue, [], `rejection must have zero side effects; residue: ${residue}`);
  });
});
