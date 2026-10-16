#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Evidence-bundle verifier. This file is COPIED INTO every bundle as
// verify.mjs and must run there with nothing but Node ≥ 20: no imports
// beyond node:*, no repository, no network. An auditor runs
//
//     node verify.mjs            (inside the unpacked bundle)
//
// and gets PASS or a list of named problems. What it proves — and what it
// does not — is stated in the bundle README:
//   - integrity: every file matches MANIFEST.sha256; nothing added/removed
//   - internal consistency: verdicts agree with violations; per-case costs
//     agree with the per-case ledgers; every trace names the same run and
//     harness commit; metrics.json recomputes from the per-case files;
//     pack-report.json (if present) recomputes from the verdicts
//   - NOT authenticity: someone who regenerates the whole bundle including
//     the manifest passes this check. Compare the printed bundle
//     fingerprint with the one the issuer recorded separately; tamper
//     evidence against the issuer itself is the hash-chained ledger's job.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyBundle(root) {
  const problems = [];
  const bad = (code, detail) => problems.push({ code, detail });
  const read = (rel) => readFileSync(join(root, rel));
  const json = (rel) => {
    try {
      return JSON.parse(read(rel).toString('utf8'));
    } catch {
      bad('FILE_UNREADABLE', rel);
      return null;
    }
  };
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');

  // 1. integrity — every file listed, every listed file present and equal
  let manifestText;
  try {
    manifestText = read('MANIFEST.sha256').toString('utf8');
  } catch {
    bad('MANIFEST_MISSING', 'MANIFEST.sha256');
    return { ok: false, problems, fingerprint: null };
  }
  const listed = new Map();
  for (const line of manifestText.split('\n').filter(Boolean)) {
    const m = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!m) {
      bad('MANIFEST_MALFORMED', line.slice(0, 80));
      continue;
    }
    listed.set(m[2], m[1]);
  }
  const onDisk = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else onDisk.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(root);
  for (const f of onDisk) {
    if (f === 'MANIFEST.sha256') continue;
    if (!listed.has(f)) bad('FILE_NOT_IN_MANIFEST', f);
    else if (sha(read(f)) !== listed.get(f)) bad('FILE_MODIFIED', f);
  }
  for (const f of listed.keys()) if (!onDisk.includes(f)) bad('FILE_MISSING', f);

  // 2. consistency across files
  const meta = json('bundle.json');
  const metrics = json('run/metrics.json');
  const caseIds = (meta?.cases ?? []).slice().sort();
  if (!meta || caseIds.length === 0) bad('BUNDLE_META_INVALID', 'bundle.json lists no cases');
  const per = [];
  for (const id of caseIds) {
    const result = json(`run/${id}/result.json`);
    const trace = json(`run/${id}/trace.json`);
    const caseDef = json(`cases/${id}.json`);
    if (!result || !trace || !caseDef) continue;
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
    let settled = 0;
    if (onDisk.includes(`run/${id}/ledger.json`)) {
      const ledger = json(`run/${id}/ledger.json`);
      settled = (ledger?.entries ?? [])
        .filter((e) => e.status === 'SETTLED')
        .reduce((a, e) => a + e.actualUsd, 0);
      if (ledger && settled > ledger.capUsd + 1e-6)
        bad('LEDGER_OVER_CAP', `${id}: settled ${settled} > cap ${ledger.capUsd}`);
    }
    if (Math.abs(settled - (trace.actual_cost_usd ?? 0)) > 1e-6)
      bad('COST_MISMATCH', `${id}: trace says ${trace.actual_cost_usd}, ledger settled ${settled}`);
    per.push({ id, result, trace, caseDef });
  }

  // 3. metrics recompute from the per-case files (judgement fields only —
  //    durations are run bookkeeping and are not re-derived)
  if (metrics && per.length === caseIds.length) {
    const m = metrics.metrics;
    const n = per.length;
    const pass = (xs) => xs.filter((e) => e.result.verdict === 'PASS').length;
    const count = (rule) =>
      per.reduce((a, e) => a + e.result.violations.filter((v) => v.rule === rule).length, 0);
    const rate = (xs) => (xs.length === 0 ? null : pass(xs) / xs.length);
    const near = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);
    const expect = {
      case_pass_rate: n === 0 ? 0 : pass(per) / n,
      unauthorized_write_count: count('UNAUTHORIZED_WRITE') + count('FORBIDDEN_PATH_MODIFIED'),
      secret_leak_count: count('SECRET_LEAK'),
      false_completion_count: count('FALSE_COMPLETION'),
      cross_case_contamination_count: count('CROSS_CASE_CONTAMINATION'),
      total_cost_usd: per.reduce((a, e) => a + e.trace.actual_cost_usd, 0),
      recovery_rate: rate(per.filter((e) => e.caseDef.scoring?.require_fail_then_pass === true)),
      appropriate_escalation_rate: rate(
        per.filter((e) => e.caseDef.requires_human_escalation === true),
      ),
      control_plane_case_count: per.filter((e) => e.caseDef.execution_mode === 'control_plane_only')
        .length,
    };
    for (const [k, v] of Object.entries(expect))
      if (!near(m[k], v)) bad('METRIC_MISMATCH', `${k}: metrics.json says ${m[k]}, files say ${v}`);
  }

  // 4. pack report (optional) recomputes from verdicts
  if (onDisk.includes('run/pack-report.json')) {
    const pr = json('run/pack-report.json');
    const verdictOf = new Map(per.map((e) => [e.id, e.result.verdict]));
    for (const r of pr?.requirements ?? []) {
      const covered = r.cases.every((c) => verdictOf.get(c.case) === 'PASS');
      if ((r.status === 'COVERED') !== covered)
        bad(
          'PACK_STATUS_MISMATCH',
          `${r.id}: report says ${r.status}, verdicts say ${covered ? 'COVERED' : 'NOT_COVERED'}`,
        );
    }
  }

  return { ok: problems.length === 0, problems, fingerprint: sha(Buffer.from(manifestText)) };
}

const here = fileURLToPath(import.meta.url);
const invokedDirectly = (() => {
  try {
    return statSync(process.argv[1]).ino === statSync(here).ino;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const root = process.argv[2] ?? dirname(here);
  const r = verifyBundle(root);
  console.log(`bundle fingerprint: ${r.fingerprint ?? '(none)'}`);
  console.log('  compare it with the fingerprint the issuer recorded separately');
  if (r.ok) console.log('VERIFY PASS — integrity and internal consistency hold');
  else {
    for (const p of r.problems) console.log(`✗ ${p.code}  ${p.detail}`);
    console.log(`VERIFY FAIL — ${r.problems.length} problem(s)`);
  }
  process.exit(r.ok ? 0 : 1);
}
