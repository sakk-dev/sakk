import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMIT, parseArgs, wipProblem } from '../scripts/wip-limit.mjs';

/**
 * The open pull request cap (owner's rule, 2026-10-29: at most three in flight).
 * The CLI runs as a child with a fake gh, or none; the real gh and GitHub are
 * never called.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SCRIPT = join(REPO, 'scripts', 'wip-limit.mjs');
const pr = (number, day) => ({
  number,
  createdAt: `2026-10-${String(day).padStart(2, '0')}T08:00:00Z`,
});
const FOUR = [pr(31, 4), pr(28, 1), pr(30, 3), pr(29, 2)];

function cli(args, { list, gh = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wiplimit-'));
  const bin = mkdtempSync(join(tmpdir(), 'wiplimit-bin-'));
  const listFile = join(dir, 'list.json');
  const argsFile = join(dir, 'gh-args.txt');
  if (list !== undefined)
    writeFileSync(listFile, typeof list === 'string' ? list : JSON.stringify(list));
  if (gh) {
    // shell builtins only, so PATH can hold nothing but this folder
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$ARGS_OUT"\nwhile IFS= read -r l || [ -n "$l" ]; do printf '%s\\n' "$l"; done < "$LIST"\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
  }
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: bin, LIST: listFile, ARGS_OUT: argsFile, HOME: dir },
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  let ghArgs = null;
  try {
    ghArgs = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean);
  } catch {
    /* gh never ran */
  }
  return { ...r, ghArgs, listFile };
}

describe('the open pull request cap', () => {
  test('inside the oldest three passes; the fourth is refused and told which to merge', () => {
    assert.equal(LIMIT, 3);
    assert.equal(wipProblem(FOUR, 28), null, 'oldest');
    assert.equal(wipProblem(FOUR, 30), null, 'third: the last inside the cap');
    const p = wipProblem(FOUR, 31);
    assert.match(p, /#31 is open pull request 4 of 4; at most 3 may be in flight/);
    assert.match(p, /Merge or close one of #28, #29, #30 first, then re-run this check/);
    assert.equal(wipProblem(FOUR.slice(0, 1), 31), null, 'alone');
  });
  test('drafts count, and a tie in creation time is broken by number', () => {
    // gh lists drafts as open; the cap does not ask, so a draft holds a place like any other
    const withDraft = [...FOUR.slice(1), { ...pr(27, 1), isDraft: true }];
    assert.equal(wipProblem(withDraft, 29), null);
    assert.match(
      wipProblem(withDraft, 30),
      /#30 is open pull request 4 of 4.*#27, #28, #29/,
      'the draft took a place',
    );
    const tie = [pr(12, 5), pr(11, 5), pr(10, 5), pr(13, 5)];
    assert.equal(wipProblem(tie, 12), null);
    assert.match(wipProblem(tie, 13), /4 of 4.*#10, #11, #12/);
  });
  test('an absent pull request, a malformed entry or a non-list refuses', () => {
    assert.match(wipProblem(FOUR, 99), /#99 is not among the 4 open pull requests/);
    assert.match(wipProblem([...FOUR, { number: 32 }], 28), /no number or creation time/);
    assert.match(
      wipProblem([{ number: '28', createdAt: '2026-10-01' }], 28),
      /no number or creation time/,
    );
    assert.match(wipProblem({ items: FOUR }, 28), /not a list/);
    assert.match(wipProblem(FOUR, 0), /not a pull request number/);
    assert.match(wipProblem(FOUR, 28.5), /not a pull request number/);
  });
  test('the CLI exits 1 over the cap, 0 inside it, and 1 when gh cannot run', () => {
    let r = cli(['--pr', '31'], { list: FOUR });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /wip-limit: #31 is open pull request 4 of 4/);
    assert.deepEqual(r.ghArgs, [
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,createdAt',
      '--limit',
      '200',
    ]);
    r = cli(['--pr', '29'], { list: FOUR });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /#29 is within the 3 oldest of 4/);
    r = cli(['--pr', '29'], { list: FOUR, gh: false });
    assert.equal(r.status, 1, 'no gh: the cap cannot judge, so it fails');
    assert.match(r.stderr, /cannot read the open pull requests/);
    r = cli(['--pr', '29'], { list: 'not json' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not JSON/);
    const many = Array.from({ length: 200 }, (_, i) => ({
      number: i + 1,
      createdAt: '2026-10-01T00:00:00Z',
    }));
    r = cli(['--pr', '1'], { list: many });
    assert.equal(r.status, 1, 'a list cut at the limit cannot be judged');
    assert.match(r.stderr, /reached the listing limit/);
    // --from reads the file and never starts gh
    const f = cli(['--pr', '1'], { list: FOUR });
    r = cli(['--pr', '28', '--from', f.listFile], { gh: false });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.ghArgs, null);
  });
  test('the CLI refuses an unknown flag, a repeated flag and a missing --pr with exit 2', () => {
    for (const [args, code] of [
      [['--pr', '3', '--limit', '9'], 'USAGE_UNKNOWN_ARGUMENT'],
      [['--pr', '3', '--pr', '4'], 'USAGE_REPEATED_ARGUMENT'],
      [[], 'USAGE_MISSING_PR'],
      [['--pr'], 'USAGE_MISSING_VALUE'],
      [['--pr', '--from'], 'USAGE_MISSING_VALUE'],
      [['--pr', '0'], 'USAGE_BAD_PR'],
      [['--pr', '3x'], 'USAGE_BAD_PR'],
    ]) {
      assert.equal(parseArgs(args).code, code, args.join(' '));
      const r = cli(args, { list: FOUR });
      assert.equal(r.status, 2, args.join(' '));
      assert.match(
        r.stderr,
        new RegExp(`^${code}: .*usage is node scripts/wip-limit\\.mjs --pr <number>`),
      );
      assert.equal(r.ghArgs, null, 'a usage error never asks GitHub');
    }
  });
  test("CI runs the base branch's cap on every pull request, with read access to pull requests", () => {
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    const start = ci.indexOf('\n  base-checker:\n');
    assert.ok(start >= 0, 'the base-checker job exists');
    const rest = ci.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
    const job = next < 0 ? rest : rest.slice(0, next + 1);
    assert.match(job, /if: github\.event_name == 'pull_request'/, 'every pull request');
    assert.match(job, /permissions:\n\s+contents: read\n\s+pull-requests: read/);
    const step = job.slice(job.indexOf('- name: at most three pull requests in flight'));
    assert.ok(
      step.startsWith('- name: at most three pull requests in flight'),
      'the cap step is in the job',
    );
    assert.match(step, /if: \$\{\{ !cancelled\(\) \}\}/, 'runs even after the checker step fails');
    assert.match(
      step,
      /PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}/,
      'the number comes through env',
    );
    assert.match(step, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(
      step,
      /git show "origin\/\$base:scripts\/wip-limit\.mjs" > "\$cap"/,
      "the base's copy judges",
    );
    assert.match(step, /node "\$cap" --pr "\$\{PR_NUMBER:\?\}"/);
    const body = step.slice(step.indexOf('run: |'));
    assert.ok(body.startsWith('run: |'));
    assert.doesNotMatch(body, /\$\{\{/, 'no expression is interpolated into the script');
  });
});
