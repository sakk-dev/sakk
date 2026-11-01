import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from '../scripts/evidence-bundle.mjs';
import { verifyBundle } from '../eval/lib/bundle-verify.mjs';

/**
 * Class detector for pattern fail-open-absence (findings F-65 and eleven
 * before it): delete every key of every JSON document in a real bundle, one
 * at a time, manifest regenerated, and verify. A deletion that still reads
 * PASS must be on NOT_CHECKED below, with the reason a PASS does not depend
 * on it. A new silent absence fails this test; so does a stale entry (the
 * key became checked — shrink the list).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tdir = () => mkdtempSync(join(tmpdir(), 'absence-'));

// Keys a PASS does not vouch for. Paths use Gxx for any case and .0. for
// the first element of a list.
const DESCRIPTIVE_CASE =
  'case definitions are carried for the reader; the verifier checks only id and budget (compare the rest with git show <harnessCommit>:eval/cases/<id>.json — bundle README)';
const SCORER_EVIDENCE =
  'what the scorer read; a PASS does not re-judge verdicts against the workspace (bundle README "What a PASS does not show")';
const NOT_CHECKED = {
  ...Object.fromEntries(
    [
      'category',
      'title',
      'task',
      'fixture',
      'allowed_paths',
      'forbidden_paths',
      'expected_behavior',
      'forbidden_behavior',
      'setup_command',
      'verification_commands',
      'timeout_seconds',
      'requires_human_escalation',
      'scoring',
      'scoring.require_executor_ran_tests',
      'scoring.expected_claim',
      'scoring.extra_output_paths',
      'scoring.require_verification_pass',
      'counts_into_score',
      'execution_mode',
    ].map((k) => [`cases/Gxx.json:${k}`, DESCRIPTIVE_CASE]),
  ),
  ...Object.fromEntries(
    [
      'prompt_or_packet_version',
      'started_at',
      'ended_at',
      'tool_calls',
      'state_transitions.0.at',
      'state_transitions.0.to',
      'state_transitions.0.path',
      'state_transitions.0.code',
      'state_transitions.0.toolExit',
      'files_changed',
      'commands_executed',
      'commands_executed.0.cmd',
      'commands_executed.0.exit',
      'test_results',
      'test_results.0.source',
      'test_results.0.cmd',
      'test_results.0.exit',
      'budget_reserved_usd',
      'final_claim',
      'evidence_paths',
      'errors',
    ].map((k) => [`run/Gxx/trace.json:${k}`, SCORER_EVIDENCE]),
  ),
  'run/Gxx/result.json:scored_at': SCORER_EVIDENCE,
  'run/Gxx/result.json:scorer_version': SCORER_EVIDENCE,
  'run/Gxx/ledger.json:initializedAt':
    "sakk's own ledger rules do not require it (src/ledger.mjs); the verifier applies the same rules",
  'run/Gxx/ledger.json:flags.reason': 'optional in sakk ledgers while no reconciliation is flagged',
  'run/pack-report.json:requirements.0.cases.0.verdict':
    'never reached: a requirement whose quoted case lost its verdict fails on the case comparison — listed only if the comparison regresses',
};

let BUNDLE;
before(() => {
  const run = join(tdir(), 'run');
  const r = spawnSync(
    process.execPath,
    [
      join(ROOT, 'eval', 'bin', 'gold-runner.mjs'),
      '--fake-executor',
      '--pack',
      'example-agent-oversight',
      '--out',
      run,
    ],
    { encoding: 'utf8', timeout: 300_000 },
  );
  assert.equal(r.status, 0, r.stderr);
  const to = join(tdir(), 'b.tgz');
  buildBundle({ source: run, to });
  const d = tdir();
  execFileSync('tar', ['-xzf', to, '-C', d]);
  BUNDLE = join(d, readdirSync(d)[0]);
});

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
/** Every key path in a document, descending into objects and the first element of lists. */
const keyPaths = (o, pre = []) =>
  Object.entries(o).flatMap(([k, v]) => {
    const here = [...pre, k];
    if (Array.isArray(v))
      return [here, ...(v[0] && typeof v[0] === 'object' ? keyPaths(v[0], [...here, '0']) : [])];
    return [here, ...(v && typeof v === 'object' ? keyPaths(v, here) : [])];
  });

describe('fail-open-absence: deleting any key never reads PASS unless declared', () => {
  test('the bundle under test is a PASS (control)', () => {
    assert.equal(verifyBundle(BUNDLE).status, 'PASS');
  });
  test('every silently deletable key is declared, and every declaration is still needed', () => {
    // every case of the run: key shapes differ per case (commands, test results, paid steps)
    const docs = files(BUNDLE).filter((f) => f.endsWith('.json'));
    const silent = new Set();
    let tried = 0;
    for (const f of docs) {
      const paths = keyPaths(JSON.parse(readFileSync(join(BUNDLE, f), 'utf8')));
      for (const p of paths) {
        const b = join(tdir(), 'b');
        cpSync(BUNDLE, b, { recursive: true });
        const doc = JSON.parse(readFileSync(join(b, f), 'utf8'));
        let parent = doc;
        for (const k of p.slice(0, -1)) parent = parent[k];
        delete parent[p.at(-1)];
        writeFileSync(join(b, f), JSON.stringify(doc));
        reManifest(b);
        tried += 1;
        if (verifyBundle(b).status === 'PASS')
          silent.add(`${f.replace(/G\d+/g, 'Gxx')}:${p.join('.')}`);
      }
    }
    assert.ok(tried >= 100, `only ${tried} deletions tried — did the bundle shrink?`);
    const undeclared = [...silent].filter((k) => !(k in NOT_CHECKED)).sort();
    assert.deepEqual(undeclared, [], 'a deleted key read PASS without a declared reason');
    const stale = Object.keys(NOT_CHECKED)
      .filter((k) => !silent.has(k) && !NOT_CHECKED[k].startsWith('never reached'))
      .sort();
    assert.deepEqual(stale, [], 'declared as unchecked, but the verifier now catches it — remove');
  });
});
