#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Evidence bundle (audit gap G5): turn a gold-runner out-dir into ONE
// self-contained .tgz an auditor can verify on any machine with Node ≥ 20 —
// no clone, no repository, no network.
//
//   node scripts/evidence-bundle.mjs <run-out-dir> --to <bundle.tgz>
//
// Fail-closed: a source that is not a complete run (or holds a link), a
// target that already exists, traces that disagree on run/commit, a commit
// this clone does not have, or an archive that does not pass its OWN
// verifier after unpacking → refusal, nothing written at the target.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_SCHEMA, verifyBundle } from '../eval/lib/bundle-verify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFIER = join(ROOT, 'eval', 'lib', 'bundle-verify.mjs');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export class BundleError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const README = (meta, verifierSha) => `# Sakk evidence bundle

Run \`${meta.runId}\` · harness commit \`${meta.harnessCommit}\` · executor ${meta.executorMode}
· ${meta.cases.length} case(s) · created ${meta.createdAt} · sakk ${meta.sakkVersion}

This README travels inside the bundle, so it is only as trustworthy as the
bundle. The authoritative copy of these steps is §6 of docs/AUDITOR_REPLAY.md
in the public sakk repository.

## Verify it — in this order

\`verify.mjs\` is a program shipped INSIDE this bundle. Check the bundle
without it first; only then run it.

1. Look before you unpack, then unpack into an empty directory:

       tar -tzf <bundle>.tgz          # every path must start with sakk-evidence-<run>/
       mkdir fresh && tar -xzf <bundle>.tgz -C fresh && cd fresh/sakk-evidence-*

2. Fingerprint. Compute it yourself and compare it with the value the issuer
   gave you through a SEPARATE channel (certificate, hand-over email):

       shasum -a 256 MANIFEST.sha256        # or: sha256sum MANIFEST.sha256

   Different, or no independent value to compare with: stop. You cannot
   tell this bundle from a rebuilt one.

3. Every file — verify.mjs included — matches the manifest:

       shasum -a 256 -c MANIFEST.sha256     # or: sha256sum -c MANIFEST.sha256

4. Optional: verify.mjs should be byte-identical to
   \`eval/lib/bundle-verify.mjs\` of sakk ${meta.sakkVersion} (sha256
   \`${verifierSha}\`).

5. Now run it (Node 20 or newer, nothing else):

       node verify.mjs

## What verify.mjs checks

- Integrity: every file matches MANIFEST.sha256; nothing added or removed;
  only regular files (a symlink, device or fifo is a failure).
- One run, one harness commit, one executor mode — the mode is
  cross-checked against every trace's model provider.
- The case list in bundle.json equals the case directories in run/.
- Each verdict agrees with its violations; each case's cost equals what its
  own ledger settled, and no ledger settled more than its cap.
- metrics.json recomputes from the per-case files: pass rates (overall,
  fake/real split, recovery, escalation), first-pass yield, violation
  counts, case counts, total and per-case cost, p50/p95 duration.
- pack-report.json (if present) recomputes from the verdicts; a FAKE run
  can only read HARNESS_ONLY.
- Any file it cannot read or parse is a named failure, never a skipped
  check.

## What a PASS does not show

- **Authenticity.** Someone who rebuilds the whole bundle — editing
  verdicts, dropping a failing case, recomputing metrics and manifest —
  also gets a PASS. Only step 2 catches that.
- **Re-scoring.** Verdicts are checked against their recorded violations,
  not re-judged against the agent's workspace (that needs the harness at
  the commit above; see AUDITOR_REPLAY).
- **trace_completeness_rate** is range-checked only (re-deriving it needs
  the trace schema, which the bundle does not carry).
- **A FAKE-executor bundle** proves the harness chain only — nothing about
  any model or agent.

## Before forwarding

\`run/\` holds raw executor and test logs: whatever the agent printed,
which can include secrets or personal data. Review before passing the
bundle on.

## Layout

    run/        the runner's out-dir (traces, results, ledgers, logs, metrics)
    cases/      the case definitions at the harness commit above
    bundle.json run id, harness commit, executor mode, case list
    verify.mjs  this bundle's verifier
`;

/** Every entry must be a plain file or directory: a link could point anywhere on the auditor's disk. */
function inventory(dir) {
  const files = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(d, name));
      if (st.isDirectory()) walk(join(d, name), r);
      else if (st.isFile()) files.push(r);
      else
        throw new BundleError(
          'BUNDLE_SOURCE_INVALID',
          `${r} is not a regular file (symlink, device or fifo) — a bundle holds plain files only`,
        );
    }
  };
  walk(dir, '');
  return files;
}

const parseJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new BundleError('BUNDLE_SOURCE_INVALID', `${what} is missing or not valid JSON`);
  }
};

export function buildBundle({ source, to, now = new Date() }) {
  const src = resolve(source);
  const target = resolve(to);
  if (!existsSync(join(src, 'metrics.json')))
    throw new BundleError(
      'BUNDLE_SOURCE_INVALID',
      `${source} has no metrics.json — not a completed run`,
    );
  if (existsSync(target))
    throw new BundleError('BUNDLE_TARGET_EXISTS', `${to} already exists — pick a fresh path`);
  const files = inventory(src);
  const caseIds = [
    ...new Set(
      files
        .map((f) => f.split('/'))
        .filter((p) => p.length > 1)
        .map((p) => p[0]),
    ),
  ]
    .filter((d) => /^G\d+$/.test(d))
    .sort();
  if (caseIds.length === 0)
    throw new BundleError('BUNDLE_SOURCE_INVALID', `${source} holds no case directories`);
  for (const id of caseIds)
    for (const f of ['result.json', 'trace.json', 'ledger.json'])
      if (!files.includes(`${id}/${f}`))
        throw new BundleError(
          'BUNDLE_SOURCE_INVALID',
          `${id}/${f} is missing — not a complete run`,
        );

  const traces = caseIds.map((id) => parseJson(join(src, id, 'trace.json'), `${id}/trace.json`));
  const runIds = new Set(traces.map((t) => t?.run_id));
  const commits = new Set(traces.map((t) => t?.git_commit));
  if (runIds.size !== 1 || commits.size !== 1)
    throw new BundleError(
      'BUNDLE_SOURCE_INVALID',
      `traces disagree (runs: ${[...runIds].join(',')}; commits: ${[...commits].join(',')}) — one bundle, one run`,
    );
  const runId = [...runIds][0];
  const harnessCommit = [...commits][0];
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(runId))
    throw new BundleError(
      'BUNDLE_SOURCE_INVALID',
      `run id ${JSON.stringify(runId)} is not a plain name`,
    );
  if (typeof harnessCommit !== 'string' || !/^[0-9a-f]{40}$/.test(harnessCommit))
    throw new BundleError('BUNDLE_SOURCE_INVALID', 'traces carry no full harness commit id');
  const metrics = parseJson(join(src, 'metrics.json'), 'metrics.json');
  const executorMode = metrics?.metrics?.executor_mode;
  if (executorMode !== 'FAKE' && executorMode !== 'REAL')
    throw new BundleError(
      'BUNDLE_SOURCE_INVALID',
      'metrics.json names no executor mode (FAKE|REAL)',
    );

  // The case definitions the run actually used are the ones at its commit,
  // not whatever this checkout holds now.
  const caseDefs = new Map();
  for (const id of caseIds) {
    try {
      caseDefs.set(
        id,
        execFileSync('git', ['show', `${harnessCommit}:eval/cases/${id}.json`], {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } catch {
      throw new BundleError(
        'BUNDLE_SOURCE_INVALID',
        `case ${id} at harness commit ${harnessCommit.slice(0, 12)} is not in this repository — build the bundle from a clone that has that commit`,
      );
    }
  }

  const verifierBuf = readFileSync(VERIFIER);
  const meta = {
    schema: BUNDLE_SCHEMA,
    runId,
    harnessCommit,
    executorMode,
    mode: metrics.mode ?? executorMode,
    cases: caseIds,
    createdAt: now.toISOString(),
    sakkVersion: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
  };

  const name = `sakk-evidence-${runId}`;
  const stage = mkdtempSync(join(tmpdir(), 'sakk-bundle-'));
  const partial = `${target}.partial-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    const b = join(stage, name);
    for (const f of files) {
      mkdirSync(dirname(join(b, 'run', f)), { recursive: true });
      cpSync(join(src, f), join(b, 'run', f));
    }
    mkdirSync(join(b, 'cases'));
    for (const [id, buf] of caseDefs) writeFileSync(join(b, 'cases', `${id}.json`), buf);
    writeFileSync(join(b, 'verify.mjs'), verifierBuf);
    writeFileSync(join(b, 'bundle.json'), `${JSON.stringify(meta, null, 1)}\n`);
    writeFileSync(join(b, 'README.md'), README(meta, sha256(verifierBuf)));
    const manifest = inventory(b).map((f) => `${sha256(readFileSync(join(b, f)))}  ${f}`);
    writeFileSync(join(b, 'MANIFEST.sha256'), `${manifest.join('\n')}\n`);

    const check = verifyBundle(b);
    if (!check.ok)
      throw new BundleError(
        'BUNDLE_SELF_CHECK_FAILED',
        `the bundle fails its own verifier — not shipping it: ${check.problems.map((p) => `${p.code} ${p.detail}`).join('; ')}`,
      );
    // Verify what actually ships: the archive, unpacked fresh.
    try {
      execFileSync('tar', ['-czf', partial, '-C', stage, name], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      throw new BundleError(
        'BUNDLE_WRITE_FAILED',
        `could not write the archive: ${e.message.split('\n')[0]}`,
      );
    }
    const unpacked = join(stage, 'unpacked');
    mkdirSync(unpacked);
    execFileSync('tar', ['-xzf', partial, '-C', unpacked], { stdio: ['ignore', 'pipe', 'pipe'] });
    const shipped = verifyBundle(join(unpacked, name));
    if (
      !shipped.ok ||
      shipped.fingerprint !== check.fingerprint ||
      readdirSync(unpacked).length !== 1
    )
      throw new BundleError(
        'BUNDLE_SELF_CHECK_FAILED',
        'the archive does not unpack to the bundle that was verified — not shipping it',
      );
    try {
      linkSync(partial, target); // exclusive: never replaces a file that appeared meanwhile
    } catch (e) {
      if (e.code === 'EEXIST')
        throw new BundleError(
          'BUNDLE_TARGET_EXISTS',
          `${to} appeared while building — not replaced`,
        );
      throw new BundleError(
        'BUNDLE_WRITE_FAILED',
        `could not place the bundle: ${e.code ?? e.message}`,
      );
    }
    return {
      to: target,
      fingerprint: check.fingerprint,
      verifierSha256: sha256(verifierBuf),
      meta,
    };
  } finally {
    rmSync(partial, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
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
    console.log(`fingerprint:    ${r.fingerprint}   (= shasum -a 256 MANIFEST.sha256)`);
    console.log(`verifier:       ${r.verifierSha256}   (sha256 of verify.mjs)`);
    console.log(
      'give the auditor the fingerprint through a separate channel (certificate, hand-over email) — never only inside the bundle',
    );
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
