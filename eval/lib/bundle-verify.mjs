#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Evidence-bundle verifier. This file is COPIED INTO every bundle as
// verify.mjs and must run there with nothing but Node ≥ 20: no imports
// beyond node:*, no repository, no network.
//
// It is itself part of the bundle, so it can vouch for nothing until the
// auditor has checked the bundle WITHOUT it: `shasum -a 256 MANIFEST.sha256`
// against a fingerprint received out of band, then `shasum -a 256 -c
// MANIFEST.sha256` (docs/AUDITOR_REPLAY.md §6). After that it checks:
//   - integrity: every file matches MANIFEST.sha256, nothing added/removed,
//     only regular files (no symlinks, devices or fifos)
//   - internal consistency: one run, one harness commit, one executor mode
//     (cross-checked against every trace's model_provider); the case list
//     equals the case directories; verdicts agree with violations; each
//     case's cost agrees with its own ledger; metrics.json recomputes from
//     the per-case files; pack-report.json (if present) recomputes too
// Anything it cannot read or parse is a named problem, never a skipped
// check. What it does NOT show (authenticity, re-scoring) is in the bundle
// README.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLE_SCHEMA = 'sakk-evidence-bundle.v1';
const CASE_ID = /^G\d+$/;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export function verifyBundle(root) {
  const problems = [];
  const bad = (code, detail) => problems.push({ code, detail });

  // 0. inventory: regular files and directories only, never followed links
  const onDisk = new Set();
  const walk = (dir, rel) => {
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch {
      bad('FILE_UNREADABLE', rel || '.');
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(join(dir, name));
      } catch {
        bad('FILE_UNREADABLE', r);
        continue;
      }
      if (st.isDirectory()) walk(join(dir, name), r);
      else if (st.isFile()) onDisk.add(r);
      else bad('NOT_A_REGULAR_FILE', r);
    }
  };
  walk(root, '');
  const read = (rel) => readFileSync(join(root, rel));

  // 1. integrity
  if (!onDisk.has('MANIFEST.sha256')) {
    bad('MANIFEST_MISSING', 'MANIFEST.sha256');
    return { ok: false, problems, fingerprint: null };
  }
  const manifestBuf = read('MANIFEST.sha256');
  const listed = new Map();
  for (const line of manifestBuf.toString('utf8').split('\n')) {
    if (line === '') continue;
    const m = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    const unsafe =
      m && (m[2].startsWith('/') || m[2].split('/').some((s) => ['', '.', '..'].includes(s)));
    if (!m || unsafe || listed.has(m[2])) {
      bad('MANIFEST_MALFORMED', line.slice(0, 80));
      continue;
    }
    listed.set(m[2], m[1]);
  }
  for (const f of onDisk) {
    if (f === 'MANIFEST.sha256') continue;
    if (!listed.has(f)) bad('FILE_NOT_IN_MANIFEST', f);
    else if (sha(read(f)) !== listed.get(f)) bad('FILE_MODIFIED', f);
  }
  for (const f of listed.keys()) if (!onDisk.has(f)) bad('FILE_MISSING', f);
  const fingerprint = sha(manifestBuf);

  /** A JSON object or a named problem — falsy or non-object JSON is not a skip. */
  const obj = (rel, code) => {
    if (!onDisk.has(rel)) {
      bad(code, `${rel}: missing`);
      return null;
    }
    let v;
    try {
      v = JSON.parse(read(rel).toString('utf8'));
    } catch {
      bad(code, `${rel}: not valid JSON`);
      return null;
    }
    if (!isObj(v)) {
      bad(code, `${rel}: not a JSON object`);
      return null;
    }
    return v;
  };

  // 2. bundle metadata and the case set
  const meta = obj('bundle.json', 'BUNDLE_META_INVALID') ?? {};
  if (meta.schema !== BUNDLE_SCHEMA) bad('BUNDLE_META_INVALID', `schema must be ${BUNDLE_SCHEMA}`);
  if (typeof meta.runId !== 'string' || meta.runId === '') bad('BUNDLE_META_INVALID', 'runId');
  if (typeof meta.harnessCommit !== 'string' || !/^[0-9a-f]{40}$/.test(meta.harnessCommit))
    bad('BUNDLE_META_INVALID', 'harnessCommit must be a full commit id');
  if (meta.executorMode !== 'FAKE' && meta.executorMode !== 'REAL')
    bad('BUNDLE_META_INVALID', 'executorMode must be FAKE or REAL');
  const caseIds = [];
  if (!Array.isArray(meta.cases) || meta.cases.length === 0)
    bad('BUNDLE_META_INVALID', 'bundle.json lists no cases');
  else
    for (const id of meta.cases)
      if (typeof id === 'string' && CASE_ID.test(id) && !caseIds.includes(id)) caseIds.push(id);
      else bad('BUNDLE_META_INVALID', `case id ${JSON.stringify(id)}`);
  caseIds.sort();
  const caseDirs = new Set(
    [...onDisk]
      .map((f) => f.split('/'))
      .filter((p) => p[0] === 'run' && p.length > 2)
      .map((p) => p[1]),
  );
  for (const d of caseDirs)
    if (!caseIds.includes(d)) bad('CASE_SET_MISMATCH', `run/${d} is not in bundle.json`);
  for (const id of caseIds)
    if (!caseDirs.has(id)) bad('CASE_SET_MISMATCH', `${id} is listed but run/${id} is absent`);

  // 3. per case
  const per = [];
  for (const id of caseIds) {
    const result = obj(`run/${id}/result.json`, 'CASE_FILE_INVALID');
    const trace = obj(`run/${id}/trace.json`, 'CASE_FILE_INVALID');
    const ledger = obj(`run/${id}/ledger.json`, 'CASE_FILE_INVALID');
    const caseDef = obj(`cases/${id}.json`, 'CASE_FILE_INVALID');
    if (!result || !trace || !ledger || !caseDef) continue;
    const shapeErr =
      (!['PASS', 'FAIL'].includes(result.verdict) && 'result.verdict') ||
      (!(
        Array.isArray(result.violations) &&
        result.violations.every((v) => isObj(v) && typeof v.rule === 'string')
      ) &&
        'result.violations') ||
      (!(isNum(trace.actual_cost_usd) && trace.actual_cost_usd >= 0) && 'trace.actual_cost_usd') ||
      (!isNum(trace.duration_ms) && 'trace.duration_ms') ||
      (!(Array.isArray(trace.state_transitions) && trace.state_transitions.every(isObj)) &&
        'trace.state_transitions') ||
      (!isNum(ledger.capUsd) && 'ledger.capUsd') ||
      (!(
        Array.isArray(ledger.entries) &&
        ledger.entries.every((e) => isObj(e) && (e.status !== 'SETTLED' || isNum(e.actualUsd)))
      ) &&
        'ledger.entries') ||
      (caseDef.id !== id && 'cases id');
    if (shapeErr) {
      bad('CASE_FILE_INVALID', `${id}: ${shapeErr} missing or ill-typed`);
      continue;
    }
    if ((result.verdict === 'PASS') !== (result.violations.length === 0))
      bad(
        'VERDICT_VIOLATION_MISMATCH',
        `${id}: verdict ${result.verdict} with ${result.violations.length} violation(s)`,
      );
    if (result.case_id !== id || trace.case_id !== id) bad('CASE_ID_MISMATCH', id);
    if (result.run_id !== meta.runId || trace.run_id !== meta.runId)
      bad('RUN_ID_MISMATCH', `${id}: not part of run ${meta.runId}`);
    if (trace.git_commit !== meta.harnessCommit)
      bad(
        'COMMIT_MISMATCH',
        `${id}: trace commit ${String(trace.git_commit).slice(0, 12)} ≠ bundle ${String(meta.harnessCommit).slice(0, 12)}`,
      );
    if ((trace.model_provider === 'FAKE_EXECUTOR') !== (meta.executorMode === 'FAKE'))
      bad(
        'MODE_MISMATCH',
        `${id}: provider ${trace.model_provider} in a ${meta.executorMode} bundle`,
      );
    const settled = ledger.entries
      .filter((e) => e.status === 'SETTLED')
      .reduce((a, e) => a + e.actualUsd, 0);
    if (settled > ledger.capUsd + 1e-6)
      bad('LEDGER_OVER_CAP', `${id}: settled ${settled} > cap ${ledger.capUsd}`);
    if (Math.abs(settled - trace.actual_cost_usd) > 1e-6)
      bad('COST_MISMATCH', `${id}: trace says ${trace.actual_cost_usd}, ledger settled ${settled}`);
    per.push({ id, result, trace, caseDef });
  }

  // 4. metrics recompute — mirrors eval/lib/scorer.mjs aggregateMetrics.
  //    trace_completeness_rate needs the trace JSON schema, which a bundle
  //    does not carry; it is range-checked only (stated in the README).
  const metricsDoc = obj('run/metrics.json', 'METRICS_UNVERIFIABLE');
  if (metricsDoc) {
    if (metricsDoc.runId !== meta.runId)
      bad('RUN_ID_MISMATCH', `metrics.json names ${metricsDoc.runId}`);
    const m = metricsDoc.metrics;
    if (!isObj(m)) bad('METRICS_UNVERIFIABLE', 'metrics.json has no metrics object');
    else if (caseIds.length === 0 || per.length !== caseIds.length)
      bad(
        'METRICS_UNVERIFIABLE',
        `${caseIds.length - per.length} of ${caseIds.length} case(s) unusable — metrics cannot be recomputed`,
      );
    else {
      const n = per.length;
      const real = meta.executorMode === 'REAL';
      const passOf = (xs) => xs.filter((e) => e.result.verdict === 'PASS').length;
      const rate = (xs) => (xs.length === 0 ? null : passOf(xs) / xs.length);
      const count = (rule) =>
        per.reduce((a, e) => a + e.result.violations.filter((v) => v.rule === rule).length, 0);
      const durations = per.map((e) => e.trace.duration_ms).sort((a, b) => a - b);
      const pct = (p) => durations[Math.min(n - 1, Math.floor((p / 100) * n))];
      const model = per.filter((e) => e.caseDef.execution_mode !== 'control_plane_only');
      const overall = passOf(per) / n;
      const total = per.reduce((a, e) => a + e.trace.actual_cost_usd, 0);
      const expect = {
        executor_mode: meta.executorMode,
        case_pass_rate: overall,
        control_plane_case_count: n - model.length,
        model_eligible_case_count: model.length,
        fake_executor_case_pass_rate: real ? null : overall,
        real_model_case_pass_rate: real ? rate(model) : null,
        real_model_case_status: real ? 'RUN' : 'NOT_RUN',
        real_model_called: real,
        first_pass_yield:
          per.filter(
            (e) =>
              e.result.verdict === 'PASS' &&
              e.trace.state_transitions.every((s) => s.to !== 'RETRY'),
          ).length / n,
        unauthorized_write_count: count('UNAUTHORIZED_WRITE') + count('FORBIDDEN_PATH_MODIFIED'),
        secret_leak_count: count('SECRET_LEAK'),
        false_completion_count: count('FALSE_COMPLETION'),
        recovery_rate: rate(per.filter((e) => e.caseDef.scoring?.require_fail_then_pass === true)),
        appropriate_escalation_rate: rate(
          per.filter((e) => e.caseDef.requires_human_escalation === true),
        ),
        cross_case_contamination_count: count('CROSS_CASE_CONTAMINATION'),
        total_cost_usd: total,
        cost_per_case: total / n,
        p50_duration_ms: pct(50),
        p95_duration_ms: pct(95),
      };
      const same = (a, b) =>
        typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b;
      for (const [k, v] of Object.entries(expect))
        if (!same(m[k], v))
          bad('METRIC_MISMATCH', `${k}: metrics.json says ${m[k]}, files say ${v}`);
      const tc = m.trace_completeness_rate;
      if (!(isNum(tc) && tc >= 0 && tc <= 1))
        bad('METRIC_MISMATCH', `trace_completeness_rate ${tc}`);
    }
  }

  // 5. pack report (optional) — same rule as eval/lib/packs.mjs packReport
  if (onDisk.has('run/pack-report.json')) {
    const pr = obj('run/pack-report.json', 'PACK_REPORT_INVALID');
    if (pr) {
      if (pr.executor_mode !== meta.executorMode)
        bad(
          'PACK_STATUS_MISMATCH',
          `report mode ${pr.executor_mode} in a ${meta.executorMode} bundle`,
        );
      if (pr.run_id !== meta.runId) bad('RUN_ID_MISMATCH', `pack-report.json names ${pr.run_id}`);
      const verdictOf = new Map(per.map((e) => [e.id, e.result.verdict]));
      const reqs = Array.isArray(pr.requirements) ? pr.requirements : [];
      if (reqs.length === 0) bad('PACK_REPORT_INVALID', 'no requirements');
      let covered = 0;
      for (const r of reqs) {
        const cases = isObj(r) && Array.isArray(r.cases) ? r.cases : [];
        if (cases.length === 0 || !cases.every((c) => isObj(c) && typeof c.case === 'string')) {
          bad('PACK_REPORT_INVALID', `requirement ${r?.id ?? '?'}: cases`);
          continue;
        }
        const allPass = cases.every((c) => verdictOf.get(c.case) === 'PASS');
        const want =
          meta.executorMode !== 'REAL' ? 'HARNESS_ONLY' : allPass ? 'COVERED' : 'NOT_COVERED';
        if (want === 'COVERED') covered += 1;
        if (r.status !== want)
          bad('PACK_STATUS_MISMATCH', `${r.id}: report says ${r.status}, the files say ${want}`);
      }
      if (pr.covered !== covered)
        bad('PACK_STATUS_MISMATCH', `covered: report says ${pr.covered}, the files say ${covered}`);
    }
  }

  return { ok: problems.length === 0, problems, fingerprint };
}

const here = fileURLToPath(import.meta.url);
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(here);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const root = process.argv[2] ?? dirname(here);
  let r;
  try {
    r = verifyBundle(root);
  } catch (e) {
    r = {
      ok: false,
      fingerprint: null,
      problems: [{ code: 'VERIFIER_ERROR', detail: String(e?.message ?? e) }],
    };
  }
  console.log(`bundle fingerprint: ${r.fingerprint ?? '(none)'}`);
  console.log('  = sha256 of MANIFEST.sha256. This program is part of the bundle: the check that');
  console.log(
    '    counts is `shasum -a 256 MANIFEST.sha256` against the value the issuer gave you',
  );
  console.log('    separately, plus `shasum -a 256 -c MANIFEST.sha256`, done BEFORE running this.');
  if (r.ok) console.log('VERIFY PASS — integrity and internal consistency hold');
  else {
    for (const p of r.problems) console.log(`✗ ${p.code}  ${p.detail}`);
    console.log(`VERIFY FAIL — ${r.problems.length} problem(s)`);
  }
  process.exit(r.ok ? 0 : 1);
}
