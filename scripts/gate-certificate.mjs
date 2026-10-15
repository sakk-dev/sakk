// SPDX-License-Identifier: AGPL-3.0-only
//
// Gate non-regression certificate (blueprint P3). This script is a WITNESS,
// not a reporter: it runs every gate itself, verifies the mutation-drill
// evidence against the CURRENT bytes (the F8 lesson, machine-enforced), and
// only then renders CERTIFICATE.md. Any red, any staleness, any dirty tree →
// structured refusal, no certificate. A certificate that can be emitted over
// a failure is not a certificate.
//
//   npm run certificate            # full run (several minutes — drill included)
//
// Exit codes: 0 certificate written · 2 refused (reason on stderr).

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

export class CertError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.code = code;
    this.details = details;
  }
}

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** node --test prints `# pass 103` (TAP) on some setups and `\u2139 pass 103`
 * (spec reporter) on others — the first real certificate run discovered the
 * second form the hard way (summary parsed to 0/0 and the gate still
 * signed: R-04). Both prefixes parse; an unparsable or zero-test summary
 * REFUSES upstream, never a "0/0 pass" line on a certificate. */
export function parseSuiteSummary(out) {
  const pick = (field) => {
    const m = [...out.matchAll(new RegExp(`[#\u2139] ${field} (\\d+)`, 'g'))].at(-1);
    return m ? Number(m[1]) : null;
  };
  return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail') };
}

/** F8, machine-enforced: every `sha256 before=` the drill report testifies
 * about must equal the file's CURRENT hash — a drill that ran on different
 * bytes is a testimony about someone else's code. */
export function verifyDrillFreshness({ reportText, fileHashOf }) {
  const stale = [];
  const kills = (reportText.match(/MUTANT KILLED/g) ?? []).length;
  let checked = 0;
  const blocks = [
    ...reportText.matchAll(
      /\[(MUT-[A-Z])\] file=(\S+)\n(?:.*\n)?\[\1\] sha256 before=([0-9a-f]{64})/g,
    ),
  ];
  for (const [, mut, file, before] of blocks) {
    checked += 1;
    const now = fileHashOf(file);
    if (now !== before) stale.push({ mut, file, before, now });
  }
  return { kills, checked, stale, fresh: checked > 0 && stale.length === 0 };
}

/** Render only accepts an all-green dossier; a failing gate in the data is a
 * programming error upstream and refuses here too (defense in depth). */
export function renderCertificate(d) {
  for (const [gate, ok] of Object.entries(d.green))
    if (ok !== true)
      throw new CertError('CERT_REFUSED', `gate "${gate}" is not green — no certificate`, { gate });
  const rows = (o) =>
    Object.entries(o)
      .map(([k, v]) => `| ${k} | ${v} |`)
      .join('\n');
  return `# Gate non-regression certificate — Sakk

Issued ${d.issuedAt} · commit \`${d.commit}\` · version ${d.version} · tree CLEAN

This certificate was produced by executing every gate below in sequence on
this exact commit (\`scripts/gate-certificate.mjs\`). It cannot be produced
over a failing gate, a stale drill report, or an uncommitted tree. Verify
independently: \`git checkout ${d.commit} && npm run certificate\`.

## 1. Behavioral suites

| Suite | Result |
| --- | --- |
${rows(d.suites)}

## 2. The judge was judged (mutation drill)

${d.drill.kills}/6 mutants killed, each by its pre-named guardian test; pristine control green on both suites. Evidence freshness: ${d.drill.checked} tampered-file hashes in the report verified equal to the bytes certified here.

## 3. Randomized invariants (seeded, replayable)

| Leg | Result |
| --- | --- |
${rows(d.fuzz)}

## 4. Deterministic reproducibility

Two independent full fake runs produced identical judgement fingerprints:

\`\`\`
${d.reproHash}
\`\`\`

An auditor on any machine at this commit obtains this same hash (see docs/AUDITOR_REPLAY.md).

## 5. Certified surface

| File | SHA-256 |
| --- | --- |
${rows(d.certified)}

---

_Fail-closed by construction: this document's existence is the claim._
`;
}

const isMain =
  process.argv[1] !== undefined &&
  (() => {
    try {
      return (
        realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
      );
    } catch {
      return false;
    }
  })();

if (isMain) {
  const refuse = (code, msg) => {
    console.error(`${code}: ${msg} — no certificate emitted`);
    process.exit(2);
  };
  const run = (cmd, args, label, timeout = 900_000) => {
    process.stderr.write(`· ${label} ...\n`);
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout, maxBuffer: 1 << 26 });
    return { exit: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const suiteCounts = (out, label) => {
    const c = parseSuiteSummary(out);
    if (!(Number.isInteger(c.tests) && c.tests > 0 && c.fail === 0))
      refuse('CERT_GATE_RED', `${label} summary unparsable or zero tests (${JSON.stringify(c)})`);
    return `${c.pass}/${c.tests} pass, ${c.fail} fail`;
  };

  // Gate 0: the tree itself
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  if (dirty !== '')
    refuse(
      'CERT_DIRTY_TREE',
      `uncommitted changes present (${dirty.split('\n').length} paths); certificates testify about commits`,
    );
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

  // Gate 1+2: suites
  const unit = run(
    process.execPath,
    [
      '--test',
      ...execFileSync('sh', ['-c', 'ls test/*.test.mjs'], { cwd: ROOT, encoding: 'utf8' })
        .trim()
        .split('\n'),
    ],
    'unit+CLI suite',
  );
  if (unit.exit !== 0) refuse('CERT_GATE_RED', 'unit suite failed');
  const validate = run(
    process.execPath,
    ['eval/bin/gold-runner.mjs', '--validate'],
    'gold manifest + schemas',
  );
  if (validate.exit !== 0) refuse('CERT_GATE_RED', '--validate failed');
  const evalSuite = run(
    process.execPath,
    [
      '--test',
      ...execFileSync('sh', ['-c', 'ls eval/__tests__/*.test.mjs'], { cwd: ROOT, encoding: 'utf8' })
        .trim()
        .split('\n'),
    ],
    'eval suite',
  );
  if (evalSuite.exit !== 0) refuse('CERT_GATE_RED', 'eval suite failed');

  // Gate 3: mutation drill, then freshness against CURRENT bytes
  const drillRun = run(
    'sh',
    ['scripts/mutation-drill.sh'],
    'mutation drill (6 mutants + control)',
    1_800_000,
  );
  if (drillRun.exit !== 0) refuse('CERT_GATE_RED', 'mutation drill failed');
  const freshness = verifyDrillFreshness({
    reportText: readFileSync(join(ROOT, 'mutation-drill-report.txt'), 'utf8'),
    fileHashOf: (f) => sha256File(join(ROOT, f)),
  });
  if (!freshness.fresh)
    refuse(
      'CERT_STALE_EVIDENCE',
      `drill report hashes do not match current bytes: ${JSON.stringify(freshness.stale.map((s) => s.mut))}`,
    );

  // Gate 4: seeded fuzz, both legs
  const ledgerFuzz = run(process.execPath, ['scripts/invariant-fuzz.mjs'], 'ledger invariant fuzz');
  if (ledgerFuzz.exit !== 0) refuse('CERT_GATE_RED', 'ledger fuzz failed');
  const policyFuzz = run(process.execPath, ['scripts/policy-fuzz.mjs'], 'policy invariant fuzz');
  if (policyFuzz.exit !== 0) refuse('CERT_GATE_RED', 'policy fuzz failed');

  // Gate 5: deterministic reproducibility (two runs, filtered fingerprint)
  const fp = () => {
    const out = mkdtempSync(join(tmpdir(), 'cert-replay-'));
    const r = run(
      process.execPath,
      ['eval/bin/gold-runner.mjs', '--fake-executor', '--out', out],
      'fake run (reproducibility)',
    );
    if (r.exit !== 0) refuse('CERT_GATE_RED', 'fake-executor run failed');
    const m = JSON.parse(readFileSync(join(out, 'metrics.json'), 'utf8'));
    delete m.runId;
    for (const k of ['p50_duration_ms', 'p95_duration_ms']) delete m.metrics[k];
    return createHash('sha256').update(JSON.stringify(m)).digest('hex');
  };
  const h1 = fp();
  const h2 = fp();
  if (h1 !== h2) refuse('CERT_NONDETERMINISTIC', `judgement fingerprints differ: ${h1} vs ${h2}`);

  const cert = renderCertificate({
    issuedAt: new Date().toISOString(),
    commit,
    version,
    green: {
      unit: unit.exit === 0,
      validate: validate.exit === 0,
      eval: evalSuite.exit === 0,
      drill: freshness.fresh,
      ledgerFuzz: true,
      policyFuzz: true,
      repro: h1 === h2,
    },
    suites: {
      'unit + CLI': suiteCounts(unit.out, 'unit suite'),
      'gold manifest': (validate.out.match(/gold-manifest: \S+/) ?? ['gold-manifest: OK'])[0],
      'eval harness': suiteCounts(evalSuite.out, 'eval suite'),
    },
    drill: freshness,
    fuzz: {
      'ledger (money invariants)': (ledgerFuzz.out.match(/invariant-fuzz: .*/) ?? [''])[0],
      'policy (decision invariants)': (policyFuzz.out.match(/policy-fuzz: .*/) ?? [''])[0],
    },
    reproHash: h1,
    certified: Object.fromEntries(
      [
        'src/ledger.mjs',
        'src/policy.mjs',
        'src/match.mjs',
        'bin/sakk.mjs',
        'eval/lib/scorer.mjs',
        'eval/bin/gold-runner.mjs',
      ].map((f) => [f, sha256File(join(ROOT, f))]),
    ),
  });
  writeFileSync(join(ROOT, 'CERTIFICATE.md'), cert);
  console.log(`certificate written: CERTIFICATE.md (commit ${commit.slice(0, 7)})`);
}
