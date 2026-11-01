#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Testing standard T2 (reliability): every gold case k times (key cases
// k_key times) through the runner, pass@1 with a Wilson 95% interval,
// pass^k, and run-to-run verdict stability. k, k_key and the key cases come
// from eval/thresholds.json.
//
//   node scripts/golden-k.mjs
//
// Today only the FAKE executor can run (a real run needs approved gold labels
// and a model key), so this measures the HARNESS — the report says so on its
// first line. Exit 1 if any case changes verdict between runs, or pass^k
// falls below the threshold.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(ROOT, 'eval', 'bin', 'gold-runner.mjs');
const T = JSON.parse(readFileSync(join(ROOT, 'eval', 'thresholds.json'), 'utf8')).T2;

/** Wilson 95% interval for x successes in n trials (testing standard §7.1). */
export function wilson(x, n, z = 1.96) {
  if (n === 0) return [0, 1];
  const p = x / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

if (process.argv.length > 2) {
  console.error('usage: node scripts/golden-k.mjs   (k comes from eval/thresholds.json)');
  process.exit(2);
}
if (!(
  Number.isInteger(T.k) &&
  T.k >= 3 &&
  Number.isInteger(T.k_key_cases) &&
  T.k_key_cases >= T.k
)) {
  console.error('eval/thresholds.json: T2.k must be ≥ 3 and T2.k_key_cases ≥ T2.k');
  process.exit(2);
}

const runOnce = (selector) => {
  const out = join(mkdtempSync(join(tmpdir(), 'golden-k-')), 'run');
  const args = [RUNNER, '--fake-executor', '--out', out, ...(selector ? ['--case', selector] : [])];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 600_000 });
  if (r.status === null) {
    console.error(`runner did not finish (${r.signal ?? 'timeout'})`);
    process.exit(1);
  }
  const verdicts = {};
  for (const id of readdirSync(out).filter((d) => /^G\d+$/.test(d)))
    verdicts[id] = JSON.parse(readFileSync(join(out, id, 'result.json'), 'utf8')).verdict;
  return verdicts;
};

const byCase = {};
const record = (verdicts) => {
  for (const [id, v] of Object.entries(verdicts)) (byCase[id] ??= []).push(v);
};
for (let i = 0; i < T.k; i += 1) record(runOnce());
for (let i = T.k; i < T.k_key_cases; i += 1) record(runOnce(T.key_cases.join(',')));

const ids = Object.keys(byCase).sort();
let passes = 0;
let n = 0;
let allK = 0;
const unstable = [];
const failing = [];
for (const id of ids) {
  const vs = byCase[id];
  n += vs.length;
  passes += vs.filter((v) => v === 'PASS').length;
  if (vs.every((v) => v === 'PASS')) allK += 1;
  else failing.push(`${id}:${vs.join('/')}`);
  if (new Set(vs).size > 1) unstable.push(id);
}
const [lo, hi] = wilson(passes, n);
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const passK = ids.length ? allK / ids.length : 0;

console.log('口径: FAKE executor (替身) — measures the harness only, says nothing about any model');
console.log(
  `cases ${ids.length} · k ${T.k} (key cases ${T.key_cases.join(',')} k ${T.k_key_cases}) · runs ${n}`,
);
console.log(`pass@1 ${pct(passes / n)} (Wilson 95% ${pct(lo)}–${pct(hi)}, n=${n})`);
console.log(`pass^k ${allK}/${ids.length}`);
console.log(`verdict changed between runs: ${unstable.length ? unstable.join(', ') : 'none'}`);
if (failing.length) console.log(`not passing every run: ${failing.join(' ')}`);
console.log('real-model T2: NOT VERIFIED — needs approved gold labels and a model key');
const ok = ids.length > 0 && unstable.length <= T.verdict_changes_max && passK >= T.fake_pass_k_min;
process.exit(ok ? 0 : 1);
