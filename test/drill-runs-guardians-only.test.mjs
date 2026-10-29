import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Findings F-219: the mutation drill reran a whole suite per mutant, so its CI
 * time grew as mutants x suite. This drives the drill's own run_drill (taken
 * from scripts/mutation-drill.sh as it is) over a two-file project: one file
 * holds the named test, the other only records that it ran. One mutant must
 * be killed by its named test without the other file running.
 *
 * It reads no new module, so it also runs on a drill from before the fix,
 * where the second file runs and the last assertion fails.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRILL = readFileSync(join(ROOT, 'scripts', 'mutation-drill.sh'), 'utf8');

/** One shell function from the drill, unchanged: a one-line body or up to a `}` line. */
function drillFunction(name) {
  const m = new RegExp(`^${name}\\(\\) \\{(?: .*\\}|\\n[\\s\\S]*?\\n\\})$`, 'm').exec(DRILL);
  assert.ok(m, `scripts/mutation-drill.sh has no ${name}() function`);
  return m[0];
}

/**
 * A two-file project and one mutant through the drill's run_drill. `helper` is
 * the selection script the project carries: this tree's own by default, or a
 * stand-in source text.
 */
function runOneMutant(tmp, helper) {
  const project = join(tmp, 'project');
  for (const d of ['src', 'test', 'scripts']) mkdirSync(join(project, d), { recursive: true });
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'drill-probe', private: true, type: 'module', scripts: { test: 'node --test test/*.test.mjs' } }, null, 2)}\n`,
  );
  writeFileSync(join(project, 'src', 'answer.mjs'), 'export const answer = () => 42;\n');
  writeFileSync(
    join(project, 'test', 'guardian.test.mjs'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { answer } from '../src/answer.mjs';",
      "test('the answer is 42', () => assert.equal(answer(), 42));",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(project, 'test', 'bystander.test.mjs'),
    [
      "import { test } from 'node:test';",
      "import { appendFileSync } from 'node:fs';",
      "test('bystander', () => appendFileSync(process.env.DRILL_PROBE, 'bystander ran\\n'));",
      '',
    ].join('\n'),
  );
  const own = join(ROOT, 'scripts', 'drill-guardians.mjs');
  if (helper !== undefined) writeFileSync(join(project, 'scripts', 'drill-guardians.mjs'), helper);
  // a drill from before F-219 has no helper, and its run_drill calls none
  else if (existsSync(own)) copyFileSync(own, join(project, 'scripts', 'drill-guardians.mjs'));

  const report = join(tmp, 'report.txt');
  const probe = join(tmp, 'bystander-ran.txt');
  const script = [
    'set -u',
    'FAILED=0',
    'TOTAL=0',
    drillFunction('log'),
    drillFunction('copy_repo'),
    drillFunction('run_drill'),
    `run_drill MUT-P src/answer.mjs "=> 42;" "=> 41;" "the answer is 42" test`,
    'exit "$FAILED"',
    '',
  ].join('\n');
  const r = spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    timeout: 120_000,
    killSignal: 'SIGKILL',
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => !k.startsWith('GIT_') && k !== 'NODE_TEST_CONTEXT' && k !== 'NODE_OPTIONS',
        ),
      ),
      ROOT: project,
      REPORT: report,
      DRILL_PROBE: probe,
      TMPDIR: tmp,
      npm_config_update_notifier: 'false',
    },
  });
  return {
    status: r.status,
    output: `${r.stdout}${r.stderr}`,
    report: existsSync(report) ? readFileSync(report, 'utf8') : '',
    bystanderRan: existsSync(probe),
  };
}

test('the drill runs a mutant against the files holding its named test, not the whole suite', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sakk-drill-probe-'));
  try {
    const r = runOneMutant(tmp);
    assert.equal(r.status, 0, `the drill failed its one mutant:\n${r.output}\n${r.report}`);
    assert.match(r.report, /\[MUT-P\] MUTANT KILLED by 'the answer is 42'/);
    assert.equal(
      r.bystanderRan,
      false,
      'test/bystander.test.mjs ran for a mutant whose named test is in test/guardian.test.mjs: the drill reran the whole suite (F-219)',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a selection that prints no command is DRILL BROKEN, not a surviving or killed mutant', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sakk-drill-probe-'));
  try {
    // exits 0 with nothing on stdout, as the helper did when its main-module
    // check compared a symlinked path with a resolved one
    const r = runOneMutant(tmp, '');
    assert.notEqual(r.status, 0);
    assert.match(
      r.report,
      /\[MUT-P\] DRILL BROKEN: no command for the guardian files of 'the answer is 42'/,
    );
    assert.doesNotMatch(r.report, /MUTANT (KILLED|SURVIVED)/);
    assert.equal(r.bystanderRan, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
