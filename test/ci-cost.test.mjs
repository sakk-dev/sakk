import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Class detector for C-04 (unbounded cost), F-218: what one commit costs in
 * GitHub Actions. Every workflow under .github/workflows is read — none is
 * named by hand — and must:
 *  1. run once per commit: push only on main, pull requests on their own event;
 *  2. cancel an older run of the same pull request, never a run on main;
 *  3. keep the worst case of one pull request commit and of one merge to main
 *     under a fixed runner-minute ceiling (timeout x matrix size, summed).
 * Two runs belong to no commit and are priced apart, each under its own
 * ceiling: a release on a pushed v* tag, and a scheduled run no more often
 * than weekly. A tag workflow never counts as a merge to main.
 * Before F-218 every pull request commit ran twice (branch push + pull_request)
 * and October cost about 11,959 runner-minutes against 3,000 included.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.github', 'workflows');

// Linux x64 2-core runner, per minute, each job rounded up to the minute:
// https://docs.github.com/en/billing/reference/actions-runner-pricing
const LINUX_USD_PER_MIN = 0.006;
// Worst case today: ci.yml test 2x30 + self-evolution 10 + base-checker 10 +
// format 10 + drill 2x30 (F-219) + gateway 15, plus pr-review 2 + 20; the DCO
// check is a step in the format job, so it adds nothing. The gateway job (the
// LiteLLM plugin's end-to-end tests) raised both commit ceilings by 15
// minutes, $0.09 at this rate (2026-11-02). A tag release (release.yml, 30)
// and a weekly run (scorecard.yml, 10, skipped while the repository is
// private) bill per tag and per week, not per commit. Raising a ceiling is a
// cost decision: say the new figure in the pull request.
const CEILING = { pull_request: 187, push: 145, release: 30, schedule: 10 };
const WHAT = {
  pull_request: 'pull request commit',
  push: 'merge to main',
  release: 'tag release',
  schedule: 'scheduled run',
};

const GROUP = '${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}';
const EVENTS = new Set(['push', 'pull_request', 'release', 'schedule']);
/** Weekly or rarer: a fixed minute, hour and weekday, every week. */
const WEEKLY = /^\d{1,2} \d{1,2} \* \* [0-6]$/;

/** Lines of the top-level key `key` (indented children only), or null when absent. */
function block(text, key) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^${key}:(\\s|$)`).test(l));
  if (at < 0) return null;
  const head = lines[at].slice(key.length + 1).trim();
  const body = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\S/.test(l)) break;
    if (l.trim() && !/^\s*#/.test(l)) body.push(l);
  }
  return { head, body };
}

const list = (s) =>
  s
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

/**
 * Triggers as {event: {filter: values}}; problems for anything it cannot read.
 * A push filtered only by tags is a `release`, priced apart from a commit.
 */
function triggers(text) {
  const b = block(text, 'on');
  if (!b) return { on: null, problems: ['no on: block'] };
  const on = {};
  const problems = [];
  if (b.head.startsWith('[')) for (const e of list(b.head)) on[e] = {};
  else if (b.head) on[b.head] = {};
  else {
    let ev = null;
    for (const l of b.body) {
      const m2 = l.match(/^ {2}([a-z_]+):\s*(.*)$/);
      const m4 = l.match(/^ {4}([a-z_-]+):\s*(.*)$/);
      const cron = l.match(/^ {4}- cron:\s*(['"])([^'"]*)\1\s*$/);
      if (m2) {
        ev = m2[1];
        on[ev] = {};
        if (m2[2]) problems.push(`${ev}: an inline value it cannot read (${m2[2]})`);
      } else if (cron && ev === 'schedule') (on.schedule.cron ??= []).push(cron[2]);
      else if (m4 && ev) on[ev][m4[1]] = m4[2].startsWith('[') ? list(m4[2]) : null;
      else problems.push(`a trigger line it cannot read: ${l.trim()}`);
    }
  }
  if (on.push && Object.keys(on.push).join() === 'tags') {
    on.release = on.push;
    delete on.push;
  }
  if (!Object.keys(on).length) problems.push('on: names no event');
  return { on, problems };
}

/** Why a workflow's triggers would run a commit more than once, or never on its own event. */
function triggerProblems(text) {
  const { on, problems } = triggers(text);
  if (!on) return problems;
  for (const [ev, filters] of Object.entries(on)) {
    if (!EVENTS.has(ev)) {
      problems.push(`${ev}: an event this budget does not price — add it to the test on purpose`);
      continue;
    }
    const keys = Object.keys(filters);
    if (ev === 'push') {
      if (keys.join() !== 'branches' || filters.branches?.join() !== 'main')
        problems.push(
          'push must be limited to branches: [main] — a branch push also runs on its pull request',
        );
    } else if (ev === 'release') {
      const tags = filters.tags ?? [];
      if (!tags.length || tags.some((t) => !/^v/.test(t)))
        problems.push(
          `a tag release must be limited to v* tags (got ${tags.join(', ') || 'none'}) — any other tag publishes too`,
        );
    } else if (ev === 'schedule') {
      const crons = filters.cron ?? [];
      if (keys.join() !== 'cron' || !crons.length)
        problems.push('schedule: no cron line it can read');
      for (const c of crons)
        if (!WEEKLY.test(c.trim()))
          problems.push(
            `schedule: ${c} runs more often than weekly — pin minute, hour and weekday`,
          );
    } else if (keys.some((k) => k !== 'types'))
      problems.push(`pull_request: a filter this test does not know (${keys.join(', ')})`);
  }
  return problems;
}

/** Why a newer commit would not cancel its pull request's older run, or a main run could be cancelled. */
function concurrencyProblems(text) {
  const b = block(text, 'concurrency');
  if (!b) return ['no top-level concurrency block'];
  if (b.head) return [`concurrency: ${b.head} is a bare group with no cancel-in-progress`];
  const get = (k) =>
    b.body
      .map((l) => l.match(new RegExp(`^ {2}${k}:\\s*(.*)$`)))
      .find(Boolean)?.[1]
      ?.trim();
  const out = [];
  if (get('group') !== GROUP)
    out.push(
      `concurrency.group must be ${GROUP}: keyed by the pull request, with run_id so main never shares a group (got ${get('group')})`,
    );
  if (get('cancel-in-progress') !== 'true') out.push('concurrency.cancel-in-progress must be true');
  return out;
}

/** Each job with its worst-case runner-minutes and the event it is limited to. */
function jobs(text) {
  const at = text.indexOf('\njobs:\n');
  if (at < 0) return { jobs: [], problems: ['no jobs: block'] };
  const body = text.slice(at + '\njobs:\n'.length);
  const heads = [...body.matchAll(/^ {2}([a-z][\w-]*):\s*$/gm)];
  const problems = [];
  const out = heads.map((h, i) => {
    const jb = body.slice(h.index, heads[i + 1]?.index ?? body.length);
    const id = h[1];
    const timeout = Number(jb.match(/^ {4}timeout-minutes:\s*(\d+)\s*$/m)?.[1]);
    if (!Number.isInteger(timeout) || timeout <= 0) problems.push(`${id}: no timeout-minutes`);
    const runsOn = jb.match(/^ {4}runs-on:\s*(\S+)\s*$/m)?.[1];
    if (!runsOn || !/^ubuntu-/.test(runsOn))
      problems.push(
        `${id}: runs-on ${runsOn ?? '(none)'} is not a Linux runner this budget prices`,
      );
    let size = 1;
    const lines = jb.split('\n');
    const s = lines.findIndex((l) => /^ {4}strategy:/.test(l));
    if (s >= 0) {
      // only the strategy block's own lines, then only the matrix block's
      const strat = [];
      for (const l of lines.slice(s + 1)) {
        if (!/^ {6}/.test(l)) break;
        strat.push(l);
      }
      const m = strat.findIndex((l) => /^ {6}matrix:\s*$/.test(l));
      const axes = [];
      if (m >= 0)
        for (const l of strat.slice(m + 1)) {
          if (!/^ {8}/.test(l)) break;
          const a = l.match(/^ {8}([\w-]+):\s*(.*)$/);
          if (a) axes.push(a);
        }
      if (!/^ {4}strategy:\s*$/.test(lines[s]) || !axes.length)
        problems.push(`${id}: a strategy without a matrix it can count`);
      for (const [, axis, v] of axes) {
        if (axis === 'include' || axis === 'exclude' || !v.startsWith('['))
          problems.push(`${id}: matrix ${axis} it cannot count — list each axis as [a, b]`);
        else size *= list(v).length;
      }
    }
    const cond = jb.match(/^ {4}if:\s*(.+)$/m)?.[1] ?? '';
    const only = /github\.event_name == 'pull_request'/.test(cond)
      ? 'pull_request'
      : /github\.event_name == 'push'/.test(cond)
        ? 'push'
        : null;
    return { id, minutes: timeout * size, timeout, size, only };
  });
  if (!out.length) problems.push('jobs: lists no job');
  return { jobs: out, problems };
}

/** Worst-case runner-minutes of one commit for `event`, over the given workflows. */
function worstCase(workflows, event) {
  let total = 0;
  const parts = [];
  for (const { file, text } of workflows) {
    const { on } = triggers(text);
    if (!on || !on[event]) continue;
    for (const j of jobs(text).jobs) {
      if (j.only && j.only !== event) continue;
      total += j.minutes;
      parts.push(`${file}:${j.id} ${j.size > 1 ? `${j.size}x${j.timeout}` : j.timeout}`);
    }
  }
  return { total, parts };
}

const workflows = readdirSync(DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
  .map((file) => ({ file, text: readFileSync(join(DIR, file), 'utf8') }));

// shapes the parser must see as wrong, so a pass is not a parser that sees nothing
const OLD_TRIGGER =
  'name: ci\non: [push, pull_request]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n';
const GOOD =
  'name: ci\non:\n  push:\n    branches: [main]\n  pull_request:\n' +
  `concurrency:\n  group: ${GROUP}\n  cancel-in-progress: true\n` +
  'jobs:\n  t:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n';

describe('CI cost per commit (F-218)', () => {
  test('every workflow runs once per commit: a push only on main, a pull request on its own event', () => {
    assert.ok(
      workflows.length >= 2,
      `workflows found: ${workflows.map((w) => w.file).join() || 'none'}`,
    );
    for (const { file, text } of workflows) assert.deepEqual(triggerProblems(text), [], file);
    assert.ok(
      workflows.some(({ text }) => triggers(text).on?.pull_request),
      'no workflow runs on pull_request',
    );
    assert.ok(
      workflows.some(({ text }) => triggers(text).on?.push),
      'no workflow runs on main after a merge',
    );
    // controls: the trigger F-218 fixed, and the fixed form
    assert.match(triggerProblems(OLD_TRIGGER).join(), /push must be limited to branches: \[main\]/);
    assert.deepEqual(triggerProblems(GOOD), []);
    const blockPush = GOOD.replace('    branches: [main]\n', '');
    assert.match(triggerProblems(blockPush).join(), /push must be limited/);
    const wide = GOOD.replace('branches: [main]', 'branches: [main, dev]');
    assert.match(triggerProblems(wide).join(), /push must be limited/);
  });

  test('a newer commit on a pull request cancels its older run; a run on main is never cancelled', () => {
    for (const { file, text } of workflows) assert.deepEqual(concurrencyProblems(text), [], file);
    assert.deepEqual(concurrencyProblems(GOOD), []);
    assert.match(concurrencyProblems(OLD_TRIGGER).join(), /no top-level concurrency/);
    // a group without run_id would put every main run in one group and cancel it
    const shared = GOOD.replace(' || github.run_id', '');
    assert.match(concurrencyProblems(shared).join(), /run_id so main never shares a group/);
    const keep = GOOD.replace('cancel-in-progress: true', 'cancel-in-progress: false');
    assert.match(concurrencyProblems(keep).join(), /cancel-in-progress must be true/);
  });

  test('one pull request commit and one merge to main stay inside the runner-minute budget', () => {
    for (const { file, text } of workflows) assert.deepEqual(jobs(text).problems, [], file);
    for (const event of Object.keys(CEILING)) {
      const { total, parts } = worstCase(workflows, event);
      assert.ok(total > 0, `${event}: no job counted — the reader is broken`);
      const usd = (n) => `$${(n * LINUX_USD_PER_MIN).toFixed(2)}`;
      assert.ok(
        total <= CEILING[event],
        `one ${WHAT[event]} can bill ${total} runner-minutes ` +
          `(${usd(total)}), over the ${CEILING[event]} ceiling (${usd(CEILING[event])}): ${parts.join(', ')}. ` +
          'Cut a job, or raise the ceiling in this diff and state the cost in the pull request.',
      );
    }
    // control: a third Node version on a 75-minute job must be seen
    const more = GOOD.replace(
      '    timeout-minutes: 5\n',
      '    timeout-minutes: 75\n    strategy:\n      matrix:\n        node: [20, 22, 24]\n',
    );
    assert.equal(worstCase([{ file: 'x', text: more }], 'pull_request').total, 225);
  });

  test('a tag release and the weekly schedule are priced under their own ceilings, never under a commit', () => {
    const tagged = workflows.filter(({ text }) => triggers(text).on?.release);
    const scheduled = workflows.filter(({ text }) => triggers(text).on?.schedule);
    assert.deepEqual(
      tagged.map((w) => w.file),
      ['release.yml'],
    );
    assert.deepEqual(
      scheduled.map((w) => w.file),
      ['scorecard.yml'],
    );
    for (const w of [...tagged, ...scheduled]) {
      assert.equal(worstCase([w], 'push').total, 0, `${w.file} is billed to a merge to main`);
      assert.equal(
        worstCase([w], 'pull_request').total,
        0,
        `${w.file} is billed to a pull request`,
      );
    }
    assert.ok(worstCase(tagged, 'release').total > 0, 'the release job was not counted');
    assert.ok(worstCase(scheduled, 'schedule').total > 0, 'the scheduled job was not counted');
    // controls: a tag workflow is a release, not a push; other tags and a
    // daily cron are refused; a weekly cron is priced as one scheduled run
    const TAG = GOOD.replace(
      '  push:\n    branches: [main]\n  pull_request:\n',
      "  push:\n    tags: ['v*']\n",
    );
    assert.deepEqual(triggerProblems(TAG), []);
    assert.equal(worstCase([{ file: 't', text: TAG }], 'push').total, 0);
    assert.equal(worstCase([{ file: 't', text: TAG }], 'release').total, 5);
    assert.match(triggerProblems(TAG.replace("'v*'", "'*'")).join(), /limited to v\* tags/);
    const both = TAG.replace("    tags: ['v*']\n", "    branches: [main]\n    tags: ['v*']\n");
    assert.match(triggerProblems(both).join(), /push must be limited/);
    const WEEK = GOOD.replace(
      '  push:\n    branches: [main]\n  pull_request:\n',
      "  schedule:\n    - cron: '23 4 * * 1'\n",
    );
    assert.deepEqual(triggerProblems(WEEK), []);
    assert.equal(worstCase([{ file: 'w', text: WEEK }], 'schedule').total, 5);
    assert.equal(worstCase([{ file: 'w', text: WEEK }], 'push').total, 0);
    assert.match(
      triggerProblems(WEEK.replace("'23 4 * * 1'", "'0 3 * * *'")).join(),
      /more often than weekly/,
    );
    assert.match(
      triggerProblems(WEEK.replace("'23 4 * * 1'", "'*/5 * * * *'")).join(),
      /more often than weekly/,
    );
  });

  test('a workflow without triggers, a job without a timeout or an unreadable matrix refuses', () => {
    assert.match(triggerProblems('name: x\njobs:\n').join(), /no on: block/);
    assert.match(
      triggerProblems(GOOD.replace('  pull_request:\n', '  workflow_dispatch:\n')).join(),
      /workflow_dispatch/,
    );
    assert.match(
      triggerProblems(
        GOOD.replace('  pull_request:\n', '  pull_request:\n    paths: [src]\n'),
      ).join(),
      /filter this test does not know/,
    );
    assert.match(
      concurrencyProblems(
        GOOD.replace(/concurrency:[\s\S]*?jobs:/, 'concurrency: ci\njobs:'),
      ).join(),
      /bare group/,
    );
    assert.match(
      jobs(GOOD.replace('    timeout-minutes: 5\n', '')).problems.join(),
      /t: no timeout-minutes/,
    );
    assert.match(
      jobs(GOOD.replace('ubuntu-latest', 'macos-latest')).problems.join(),
      /not a Linux runner/,
    );
    const include = GOOD.replace(
      '    timeout-minutes: 5\n',
      '    timeout-minutes: 5\n    strategy:\n      matrix:\n        include:\n          - node: 20\n',
    );
    assert.match(jobs(include).problems.join(), /matrix include it cannot count/);
    const noMatrix = GOOD.replace(
      '    timeout-minutes: 5\n',
      '    timeout-minutes: 5\n    strategy:\n      fail-fast: false\n',
    );
    assert.match(jobs(noMatrix).problems.join(), /strategy without a matrix/);
    assert.match(jobs('name: x\non: [pull_request]\njobs:\n').problems.join(), /lists no job/);
    assert.match(jobs('name: x\non: [pull_request]\n').problems.join(), /no jobs: block/);
  });
});
