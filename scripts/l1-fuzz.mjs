#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Testing standard §5 (L1 must-run: invariant fuzz) for the three L1
// modules that only had example tests: case packs, secret scanning and the
// evidence-bundle verifier. Seeded random inputs, invariants checked both
// ways — including controls that MUST read clean/PASS, so the fuzz can fail.
//
//   node scripts/l1-fuzz.mjs            # SEED=<n> to replay a run
//
// Trials per module come from eval/thresholds.json (L1_fuzz).

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
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
import { packReport } from '../eval/lib/packs.mjs';
import { scanText } from '../src/secret-scan.mjs';
import { verifyBundle } from '../eval/lib/bundle-verify.mjs';
import { buildBundle } from './evidence-bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRIALS = JSON.parse(readFileSync(join(ROOT, 'eval', 'thresholds.json'), 'utf8')).L1_fuzz
  .trials_per_module;
const SEED = Number(process.env.SEED ?? Date.now() % 2 ** 31);
let state = SEED >>> 0;
const rnd = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const failures = [];
const fail = (module, trial, msg) => failures.push(`${module}#${trial}: ${msg}`);
const tdir = () => mkdtempSync(join(tmpdir(), 'l1-fuzz-'));

// ── case packs ──────────────────────────────────────────────────────────────
const IDS = Array.from({ length: 12 }, (_, i) => `G${String(i + 1).padStart(2, '0')}`);
const MODES = ['REAL', 'FAKE', 'real', 'REAL ', undefined, null, ['REAL'], {}, 'UNKNOWN'];
const VERDICTS = ['PASS', 'PASS', 'PASS', 'FAIL', undefined, null, 'pass', 'NOT_RUN'];
for (let trial = 0; trial < TRIALS; trial += 1) {
  const reqs = Array.from({ length: int(1, 4) }, (_, i) => ({
    id: `r${i}`,
    theme: 't',
    evidence: 'e',
    gaps: [],
    cases: [...new Set(Array.from({ length: int(1, 3) }, () => pick(IDS)))],
  }));
  const pack = {
    id: 'p',
    title: 't',
    regulator: 'r',
    clause_status: 'T',
    not_covered: [],
    requirements: reqs,
  };
  const entries = [];
  for (const id of IDS)
    if (rnd() < 0.7)
      for (let j = int(1, 3); j > 0; j -= 1)
        entries.push(
          rnd() < 0.5
            ? { caseDef: { id }, result: { verdict: pick(VERDICTS) } }
            : { result: { case_id: id, verdict: pick(VERDICTS) } },
        );
  const executorMode = pick(MODES);
  let r;
  try {
    r = packReport(pack, entries, { executorMode });
  } catch (e) {
    fail('packs', trial, `threw ${e.message}`);
    continue;
  }
  const real = executorMode === 'REAL';
  const allPass = (c) => {
    const vs = entries
      .filter((e) => (e.caseDef?.id ?? e.result?.case_id) === c)
      .map((e) => e.result.verdict);
    return vs.length > 0 && vs.every((v) => v === 'PASS');
  };
  if (!['REAL', 'FAKE', 'UNKNOWN'].includes(r.executor_mode))
    fail('packs', trial, `mode ${r.executor_mode}`);
  r.requirements.forEach((q, i) => {
    const want = !real ? 'HARNESS_ONLY' : reqs[i].cases.every(allPass) ? 'COVERED' : 'NOT_COVERED';
    if (q.status !== want)
      fail('packs', trial, `${q.id} ${q.status} ≠ ${want} (mode ${String(executorMode)})`);
  });
  if (r.covered !== r.requirements.filter((q) => q.status === 'COVERED').length)
    fail('packs', trial, 'covered count');
}

// ── secret scanning ─────────────────────────────────────────────────────────
// [text as it appears, the credential value inside it ('' = header only)]
const SECRETS = [
  [['postgresql', '://app:', 'Zx9pQ7rT2vW4mN8k', '@db.internal/app'].join(''), 'Zx9pQ7rT2vW4mN8k'],
  [['AKIA', 'Q7RT2VW4MN8KZX9P'].join(''), 'Q7RT2VW4MN8KZX9P'],
  [['ghp', '_', 'Zx9pQ7rT2vW4mN8kL3s'.repeat(2)].join(''), 'Zx9pQ7rT2vW4mN8kL3s'.repeat(2)],
  [['sk', '_live_', 'Zx9pQ7rT2vW4mN8kL3sJ'].join(''), 'Zx9pQ7rT2vW4mN8kL3sJ'],
  [['sk', '-proj-', 'Zx9pQ7rT2vW4mN8kL3sJ'].join(''), 'Zx9pQ7rT2vW4mN8kL3sJ'],
  [['-----BEGIN', 'EC PRIVATE KEY-----'].join(' '), ''],
  [['Bearer', 'eyJhbGciOiJIUzI1NiJ9.Zx9pQ7rT2vW4'].join(' '), 'eyJhbGciOiJIUzI1NiJ9.Zx9pQ7rT2vW4'],
  [['password', ' = "', 'Zx9pQ7rT2vW4', '"'].join(''), 'Zx9pQ7rT2vW4'],
];
const WORD = 'abcdefghijklmnopqrstuvwxyz_-';
const benign = (lines) =>
  Array.from({ length: lines }, () =>
    Array.from({ length: int(0, 10) }, () =>
      Array.from({ length: int(1, 12) }, () => pick([...WORD])).join(''),
    ).join(pick([' ', ', ', '; ', ' = ', ' (', ') '])),
  );
for (let trial = 0; trial < TRIALS; trial += 1) {
  const lines = benign(int(1, 200));
  const clean = lines.join('\n');
  const c = scanText(clean);
  if (c.findings.length !== 0)
    fail('scan', trial, `control: ${c.findings.length} finding(s) in benign text`);
  const [secret, value] = pick(SECRETS);
  const at = int(0, lines.length - 1);
  // a real separator on both sides: a key glued to a word (fooAKIA…) is
  // outside the recognized formats by design (README "Secret scanning")
  const pre = pick([' ', '"', "'", '(', '= ', ', ', '\t', ': ']);
  const post = pick([' ', '"', "'", ')', ',', ';', '']);
  lines[at] = `${lines[at]}${pre}${secret}${post}`;
  const t0 = Date.now();
  const r = scanText(lines.join('\n'));
  if (Date.now() - t0 > 1000) fail('scan', trial, 'slow');
  if (!r.findings.some((f) => f.line === at + 1))
    fail(
      'scan',
      trial,
      `missed ${secret.slice(0, 10)}… on line ${at + 1} (pre ${JSON.stringify(pre)})`,
    );
  const out = JSON.stringify(r);
  for (let i = 0; i + 8 <= value.length; i += 1) {
    const piece = value.slice(i, i + 8);
    if (out.includes(piece)) {
      fail('scan', trial, 'output carries part of the secret');
      break;
    }
  }
}

// ── evidence bundles ────────────────────────────────────────────────────────
const run = join(tdir(), 'run');
const fake = spawnSync(
  process.execPath,
  [join(ROOT, 'eval', 'bin', 'gold-runner.mjs'), '--fake-executor', '--out', run],
  {
    encoding: 'utf8',
    timeout: 600_000,
  },
);
if (fake.status !== 0) {
  console.error(`fake run failed: ${fake.stderr}`);
  process.exit(1);
}
const unpacked = tdir();
execFileSync('tar', [
  '-xzf',
  buildBundle({ source: run, to: join(tdir(), 'b.tgz') }).to,
  '-C',
  unpacked,
]);
const PRISTINE = join(unpacked, readdirSync(unpacked)[0]);
const files = (b) => {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(b, p));
    }
  };
  walk(b);
  return out.sort();
};
const reManifest = (b) =>
  writeFileSync(
    join(b, 'MANIFEST.sha256'),
    `${files(b)
      .filter((f) => f !== 'MANIFEST.sha256')
      .map(
        (f) =>
          `${createHash('sha256')
            .update(readFileSync(join(b, f)))
            .digest('hex')}  ${f}`,
      )
      .join('\n')}\n`,
  );
const json = (b, rel, fn) => {
  const p = join(b, rel);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  fn(j);
  writeFileSync(p, JSON.stringify(j));
};
const cases = JSON.parse(readFileSync(join(PRISTINE, 'bundle.json'), 'utf8')).cases;
const passing = cases.filter(
  (id) =>
    JSON.parse(readFileSync(join(PRISTINE, 'run', id, 'result.json'), 'utf8')).verdict === 'PASS',
);
const settledIn = cases.filter((id) =>
  JSON.parse(readFileSync(join(PRISTINE, 'run', id, 'ledger.json'), 'utf8')).entries.some(
    (e) => e.status === 'SETTLED',
  ),
);
const RECOMPUTED = [
  'case_pass_rate',
  'first_pass_yield',
  'total_cost_usd',
  'p50_duration_ms',
  'p95_duration_ms',
  'model_eligible_case_count',
];
/** Each changes what an auditor would conclude; each must be caught even with a regenerated manifest. */
const SEMANTIC = {
  verdictFlip: (b) => json(b, `run/${pick(passing)}/result.json`, (r) => (r.verdict = 'FAIL')),
  addViolation: (b) =>
    json(b, `run/${pick(passing)}/result.json`, (r) =>
      r.violations.push({ rule: 'SECRET_LEAK', detail: 'x' }),
    ),
  traceCost: (b) => json(b, `run/${pick(cases)}/trace.json`, (t) => (t.actual_cost_usd += 0.01)),
  ledgerCost: (b) =>
    settledIn.length &&
    json(
      b,
      `run/${pick(settledIn)}/ledger.json`,
      (l) => (l.entries.find((e) => e.status === 'SETTLED').actualUsd += 0.01),
    ),
  metric: (b) => json(b, 'run/metrics.json', (m) => (m.metrics[pick(RECOMPUTED)] += 1)),
  runId: (b) => json(b, `run/${pick(cases)}/trace.json`, (t) => (t.run_id = 'gold-fake-other')),
  commit: (b) => json(b, `run/${pick(cases)}/trace.json`, (t) => (t.git_commit = 'e'.repeat(40))),
  modelId: (b) =>
    json(b, `run/${pick(cases)}/trace.json`, (t) => (t.model_id = 'claude-production')),
  reconFlag: (b) =>
    json(
      b,
      `run/${pick(cases)}/ledger.json`,
      (l) => (l.flags = { reconciliationRequired: true, reason: 'x' }),
    ),
  dropCase: (b) => json(b, 'bundle.json', (m) => m.cases.splice(int(0, m.cases.length - 1), 1)),
  nullResult: (b) => writeFileSync(join(b, 'run', pick(cases), 'result.json'), 'null'),
  stopped: (b) =>
    json(b, 'run/metrics.json', (m) => (m.stopped = { at: pick(cases), why: 'BUDGET' })),
  notRun: (b) => json(b, 'run/metrics.json', (m) => m.selected_cases.push('G99')),
  deleteRequired: (b) =>
    rmSync(join(b, 'run', pick(cases), pick(['result.json', 'trace.json', 'ledger.json']))),
};
const INTEGRITY = {
  appendByte: (b) =>
    appendFileSync(join(b, pick(files(b).filter((f) => f !== 'MANIFEST.sha256'))), ' '),
  addFile: (b) => writeFileSync(join(b, 'run', 'planted.txt'), 'x'),
  deleteAny: (b) => rmSync(join(b, pick(files(b).filter((f) => f !== 'MANIFEST.sha256')))),
};
let controls = 0;
for (let trial = 0; trial < TRIALS; trial += 1) {
  const b = join(tdir(), 'b');
  execFileSync('cp', ['-R', PRISTINE, b]);
  const kind = rnd() < 0.1 ? 'control' : rnd() < 0.7 ? 'semantic' : 'integrity';
  const applied = [];
  if (kind === 'semantic') {
    for (const name of [
      ...new Set(Array.from({ length: int(1, 3) }, () => pick(Object.keys(SEMANTIC)))),
    ]) {
      try {
        SEMANTIC[name](b);
        applied.push(name);
      } catch {
        /* an earlier mutation removed or nulled the file this one edits */
      }
    }
    reManifest(b);
  } else if (kind === 'integrity') {
    const name = pick(Object.keys(INTEGRITY));
    INTEGRITY[name](b);
    applied.push(name);
  } else controls += 1;
  let r;
  try {
    r = verifyBundle(b);
  } catch (e) {
    fail('bundle', trial, `verifyBundle threw ${e.message}`);
    continue;
  }
  if (kind === 'control' && r.status !== 'PASS') fail('bundle', trial, `control read ${r.status}`);
  if (kind !== 'control' && applied.length > 0 && r.status === 'PASS')
    fail('bundle', trial, `PASS after ${applied.join('+')}`);
  rmSync(b, { recursive: true, force: true });
}

const n = (m) => failures.filter((f) => f.startsWith(m)).length;
console.log(
  `l1-fuzz seed=${SEED} · ${TRIALS} trials/module · packs ${n('packs')} · scan ${n('scan')} · bundle ${n('bundle')} violation(s) · ${controls} PASS controls`,
);
for (const f of failures.slice(0, 20)) console.log(`  ✗ ${f}`);
process.exit(failures.length === 0 && controls > 0 ? 0 : 1);
