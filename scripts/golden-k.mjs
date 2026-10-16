#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Testing standard T2 (reliability): every gold case k times through the
// runner, pass@1 with a Wilson 95% interval, pass^k, and run-to-run verdict
// stability.
//
//   node scripts/golden-k.mjs [--k 3]
//
// Today only the FAKE executor can run (a real run needs approved gold labels
// and a model key), so this measures the HARNESS — the report says so on its
// first line. Exit 1 if any case changes verdict between runs, or any FAKE
// case fails (the fake agents are written to pass).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(ROOT, 'eval', 'bin', 'gold-runner.mjs');

/** Wilson 95% interval for x successes in n trials (testing standard §7.1). */
export function wilson(x, n, z = 1.96) {
  if (n === 0) return [0, 1];
  const p = x / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const args = process.argv.slice(2);
const kAt = args.indexOf('--k');
const k = kAt >= 0 ? Number(args[kAt + 1]) : 3;
if (!Number.isInteger(k) || k < 3 || args.some((a, i) => a !== '--k' && i !== kAt + 1)) {
  console.error('usage: node scripts/golden-k.mjs [--k N]   (N ≥ 3, testing standard T2)');
  process.exit(2);
}

const runs = [];
for (let i = 0; i < k; i += 1) {
  const out = join(mkdtempSync(join(tmpdir(), 'golden-k-')), 'run');
  const r = spawnSync(process.execPath, [RUNNER, '--fake-executor', '--out', out], {
    encoding: 'utf8',
    timeout: 600_000,
  });
  if (r.status === null) {
    console.error(`run ${i + 1}: runner did not finish (${r.signal ?? 'timeout'})`);
    process.exit(1);
  }
  const verdicts = {};
  for (const id of readdirSync(out)
    .filter((d) => /^G\d+$/.test(d))
    .sort())
    verdicts[id] = JSON.parse(readFileSync(join(out, id, 'result.json'), 'utf8')).verdict;
  runs.push(verdicts);
}

const ids = Object.keys(runs[0]);
let passes = 0;
let allK = 0;
const unstable = [];
const failing = [];
for (const id of ids) {
  const vs = runs.map((r) => r[id]);
  passes += vs.filter((v) => v === 'PASS').length;
  if (vs.every((v) => v === 'PASS')) allK += 1;
  else failing.push(`${id}:${vs.join('/')}`);
  if (new Set(vs).size > 1) unstable.push(id);
}
const n = ids.length * k;
const [lo, hi] = wilson(passes, n);
const pct = (x) => `${(100 * x).toFixed(1)}%`;

console.log('口径: FAKE executor (替身) — measures the harness only, says nothing about any model');
console.log(`cases ${ids.length} · k ${k} · runs ${n}`);
console.log(`pass@1 ${pct(passes / n)} (Wilson 95% ${pct(lo)}–${pct(hi)}, n=${n})`);
console.log(`pass^${k} ${allK}/${ids.length}`);
console.log(`verdict changed between runs: ${unstable.length ? unstable.join(', ') : 'none'}`);
if (failing.length) console.log(`not passing every run: ${failing.join(' ')}`);
console.log('real-model T2: NOT VERIFIED — needs approved gold labels and a model key');
process.exit(unstable.length === 0 && failing.length === 0 && ids.length > 0 ? 0 : 1);
