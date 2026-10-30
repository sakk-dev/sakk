// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * main's merge rule, kept as code (F-116, docs/DECISIONS.md D13). Auto-merge
 * merges a pull request as soon as main's required checks pass, so a check
 * that is not required is not waited for. .github/rulesets/main.json is the
 * payload the live ruleset was created from; these tests keep it in step
 * with the workflows. They never call GitHub, so they cannot see the live
 * setting (docs/SELF_EVOLUTION.md, "What it does not do").
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.github', 'workflows');
const RULESET = join(ROOT, '.github', 'rulesets', 'main.json');
// the GitHub Actions app: a status posted by any other app cannot satisfy a check
const ACTIONS_APP = 15368;
// checks a pull request runs that main does not wait for, and why
const NOT_REQUIRED = {
  'adversarial-review':
    'its verdict is read by whoever merges; the job fails only when the review cannot be made or posted, so requiring it would let a provider outage block every merge',
};

/** Indented lines under the top-level key `key`, or null when the key is absent. */
function block(text, key) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l));
  if (at < 0) return null;
  const body = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.trim() || /^\s*#/.test(l)) continue; // a comment, even at column 0, ends nothing
    if (/^\S/.test(l)) break;
    body.push(l);
  }
  return body;
}

/**
 * The checks one workflow reports on a pull request, named the way GitHub
 * names them: the job id, plus the matrix value in brackets. Anything this
 * cannot read is a problem, never a guess.
 */
function pullRequestChecks(file) {
  const text = readFileSync(join(DIR, file), 'utf8');
  const problems = [];
  const on = block(text, 'on');
  if (!on) return { runs: false, checks: [], problems: [`${file}: no on: block it can read`] };
  const at = on.findIndex((l) => /^ {2}pull_request:/.test(l));
  if (at < 0) return { runs: false, checks: [], problems };
  // a workflow skipped by a path or branch filter leaves its required checks
  // pending, which blocks the merge for good (GitHub, troubleshooting required checks)
  for (const l of on.slice(at + 1)) {
    if (/^ {2}\S/.test(l)) break;
    const k = l.match(/^ {4}([a-z_-]+):/)?.[1];
    if (k !== 'types') problems.push(`${file}: pull_request has a filter (${l.trim()})`);
  }
  const jobs = block(text, 'jobs');
  if (!jobs) return { runs: true, checks: [], problems: [...problems, `${file}: no jobs: block`] };
  const checks = [];
  let job = null;
  const close = () => {
    if (!job) return;
    if (job.name) problems.push(`${file}: job ${job.id} sets name:, which this test does not read`);
    if (job.matrix.length > 1)
      problems.push(`${file}: job ${job.id} has a matrix of ${job.matrix.length} keys`);
    const values = job.matrix[0]?.values ?? [null];
    for (const v of values)
      checks.push({ context: v === null ? job.id : `${job.id} (${v})`, ...job });
  };
  let inMatrix = false;
  for (const l of jobs) {
    const id = l.match(/^ {2}([a-z][\w-]*):\s*$/)?.[1];
    if (id) {
      close();
      job = { id, name: false, needs: false, matrix: [] };
      inMatrix = false;
      continue;
    }
    if (!job) {
      problems.push(`${file}: a jobs line it cannot read: ${l.trim()}`);
      continue;
    }
    if (/^ {4}name:/.test(l)) job.name = true;
    if (/^ {4}needs:/.test(l)) job.needs = true;
    if (/^ {6}matrix:\s*$/.test(l)) inMatrix = true;
    else if (inMatrix && /^ {8}\S/.test(l)) {
      const m = l.match(/^ {8}([a-z_-]+):\s*\[([^\]]+)\]\s*$/);
      if (!m) problems.push(`${file}: job ${job.id} has a matrix line it cannot read: ${l.trim()}`);
      else job.matrix.push({ key: m[1], values: m[2].split(',').map((v) => v.trim()) });
    } else if (!/^ {8}/.test(l)) inMatrix = false;
  }
  close();
  if (!checks.length) problems.push(`${file}: runs on pull requests but no job was read`);
  return { runs: true, checks, problems };
}

function read() {
  const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
  const all = files.map(pullRequestChecks);
  return {
    files,
    checks: all.flatMap((w) => w.checks),
    problems: all.flatMap((w) => w.problems),
  };
}

test("main's ruleset requires every check a pull request runs, except the declared review (F-116)", () => {
  // read inside the test: a missing file must fail this test, not stop the file loading
  const rs = JSON.parse(readFileSync(RULESET, 'utf8'));
  assert.equal(rs.target, 'branch');
  assert.equal(rs.enforcement, 'active', 'an evaluate-only ruleset blocks nothing');
  assert.deepEqual(rs.conditions?.ref_name?.include, ['~DEFAULT_BRANCH']);
  assert.deepEqual(rs.bypass_actors, [], 'a bypass actor can merge past a red check');
  const rules = (rs.rules ?? []).filter((r) => r.type === 'required_status_checks');
  assert.equal(rules.length, 1, 'the ruleset has no required-checks rule');
  const required = rules[0].parameters?.required_status_checks ?? [];
  for (const c of required)
    assert.equal(c.integration_id, ACTIONS_APP, `${c.context}: any app could report it`);

  const { files, checks, problems } = read();
  assert.ok(files.length >= 2, `found only ${files.length} workflow files`);
  assert.deepEqual(problems, []);
  const runs = new Set(checks.map((c) => c.context));
  for (const id of Object.keys(NOT_REQUIRED))
    assert.ok(runs.has(id), `${id} is exempted but no pull request runs it`);
  const want = [...runs].filter((c) => !(c in NOT_REQUIRED)).sort();
  assert.deepEqual(
    required.map((c) => c.context).sort(),
    want,
    'the checks main requires and the checks a pull request runs differ',
  );
});

test('every required check comes from a job that reports on every pull request: no path or branch filter, no needs (F-116)', () => {
  const rs = JSON.parse(readFileSync(RULESET, 'utf8'));
  const required = new Set(
    (rs.rules ?? [])
      .filter((r) => r.type === 'required_status_checks')
      .flatMap((r) => r.parameters?.required_status_checks ?? [])
      .map((c) => c.context),
  );
  assert.ok(required.size > 0, 'no required checks were read');
  const { checks, problems } = read();
  // a filtered workflow never reports, so its checks stay pending
  assert.deepEqual(problems, []);
  const byContext = new Map(checks.map((c) => [c.context, c]));
  for (const ctx of required) {
    const job = byContext.get(ctx);
    assert.ok(job, `${ctx} is required but no workflow runs it on a pull request`);
    // a job skipped because the job it needs failed reads as passed
    assert.equal(job.needs, false, `${ctx} needs another job, so its failure can read as a pass`);
  }
});
