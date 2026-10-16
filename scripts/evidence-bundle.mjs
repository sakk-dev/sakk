#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Evidence bundle (audit gap G5): turn a gold-runner out-dir into ONE
// self-contained .tgz an auditor can verify on any machine with Node ≥ 20 —
// no clone, no repository, no network.
//
//   node scripts/evidence-bundle.mjs <run-out-dir> --to <bundle.tgz>
//
// Fail-closed: a source that is not a complete run, a target that already
// exists, traces that disagree on run/commit, or a bundle that does not
// pass its OWN verifier → refusal, nothing written. A bundle that cannot
// verify itself is never shipped.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle } from '../eval/lib/bundle-verify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export class BundleError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const README = (meta) => `# Sakk evidence bundle

Run \`${meta.runId}\` · harness commit \`${meta.harnessCommit}\` · mode ${meta.mode}
· ${meta.cases.length} case(s) · created ${meta.createdAt}

## Verify it yourself

    node verify.mjs

Needs Node 20 or newer and nothing else — no repository, no network.

## What a PASS means

- **Integrity**: every file matches MANIFEST.sha256; nothing was added or
  removed.
- **Internal consistency**: each verdict agrees with its violations; each
  case's cost agrees with its own ledger; every trace belongs to this run
  and this harness commit; metrics.json recomputes from the per-case files;
  the pack report (if any) recomputes from the verdicts.

## What a PASS does not mean

- **Authenticity.** Someone who rebuilds the entire bundle, manifest
  included, also gets a PASS. Compare the fingerprint the verifier prints
  with the one the issuer gave you through a separate channel (the
  certificate, the hand-over email). A fingerprint printed inside the
  bundle itself would prove nothing, so none is.

- **Re-scoring.** The verifier checks the judgements against each other;
  re-running the judge itself needs the harness at the commit above
  (see AUDITOR_REPLAY in the repository).

## Layout

    run/        the runner's out-dir, untouched (traces, results, ledgers, logs, metrics)
    cases/      the case definitions the run used
    bundle.json run id, harness commit, case list
    verify.mjs  this bundle's verifier
`;

export function buildBundle({ source, to, now = new Date() }) {
  const src = resolve(source);
  if (!existsSync(join(src, 'metrics.json')))
    throw new BundleError(
      'BUNDLE_SOURCE_INVALID',
      `${source} has no metrics.json — not a completed run`,
    );
  const caseIds = readdirSync(src)
    .filter((d) => /^G\d+$/.test(d) && statSync(join(src, d)).isDirectory())
    .sort();
  if (caseIds.length === 0)
    throw new BundleError('BUNDLE_SOURCE_INVALID', `${source} holds no case directories`);
  if (existsSync(to))
    throw new BundleError('BUNDLE_TARGET_EXISTS', `${to} already exists — pick a fresh path`);

  const traces = caseIds.map((id) => JSON.parse(readFileSync(join(src, id, 'trace.json'), 'utf8')));
  const runIds = new Set(traces.map((t) => t.run_id));
  const commits = new Set(traces.map((t) => t.git_commit));
  if (runIds.size !== 1 || commits.size !== 1)
    throw new BundleError(
      'BUNDLE_SOURCE_INVALID',
      `traces disagree (runs: ${[...runIds].join(',')}; commits: ${[...commits].join(',')}) — one bundle, one run`,
    );
  const metrics = JSON.parse(readFileSync(join(src, 'metrics.json'), 'utf8'));
  const meta = {
    schema: 'sakk-evidence-bundle.v1',
    runId: [...runIds][0],
    harnessCommit: [...commits][0],
    mode: metrics.mode ?? metrics.metrics?.executor_mode ?? 'unknown',
    cases: caseIds,
    createdAt: now.toISOString(),
    sakkVersion: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
  };

  const stage = mkdtempSync(join(tmpdir(), 'sakk-bundle-'));
  const b = join(stage, `sakk-evidence-${meta.runId}`);
  try {
    cpSync(src, join(b, 'run'), { recursive: true });
    for (const id of caseIds)
      cpSync(join(ROOT, 'eval', 'cases', `${id}.json`), join(b, 'cases', `${id}.json`));
    cpSync(join(ROOT, 'eval', 'lib', 'bundle-verify.mjs'), join(b, 'verify.mjs'));
    writeFileSync(join(b, 'bundle.json'), `${JSON.stringify(meta, null, 1)}\n`);

    const files = [];
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(relative(b, p).split('\\').join('/'));
      }
    };
    writeFileSync(join(b, 'README.md'), README(meta));
    walk(b);
    const sha = (rel) =>
      createHash('sha256')
        .update(readFileSync(join(b, rel)))
        .digest('hex');
    const manifest = files.sort().map((f) => `${sha(f)}  ${f}`);
    writeFileSync(join(b, 'MANIFEST.sha256'), `${manifest.join('\n')}\n`);

    const check = verifyBundle(b);
    if (!check.ok)
      throw new BundleError(
        'BUNDLE_SELF_CHECK_FAILED',
        `the bundle fails its own verifier — not shipping it: ${check.problems.map((p) => `${p.code} ${p.detail}`).join('; ')}`,
      );
    execFileSync('tar', ['-czf', resolve(to), '-C', stage, `sakk-evidence-${meta.runId}`]);
    return { to: resolve(to), fingerprint: check.fingerprint, meta };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const isMain = (() => {
  try {
    return statSync(process.argv[1]).ino === statSync(fileURLToPath(import.meta.url)).ino;
  } catch {
    return false;
  }
})();
if (isMain) {
  const source = process.argv[2];
  const i = process.argv.indexOf('--to');
  const to = i > 0 ? process.argv[i + 1] : undefined;
  if (!source || !to || to.startsWith('--')) {
    console.error('usage: node scripts/evidence-bundle.mjs <run-out-dir> --to <bundle.tgz>');
    process.exit(2);
  }
  try {
    const r = buildBundle({ source, to });
    console.log(`bundle written: ${r.to}`);
    console.log(`fingerprint:    ${r.fingerprint}`);
    console.log(
      'record this fingerprint where the auditor can see it independently (e.g. in the certificate or the hand-over email)',
    );
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
