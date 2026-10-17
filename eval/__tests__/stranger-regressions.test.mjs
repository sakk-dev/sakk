import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regressions from stranger testing (clean-container README walk, 2026-10-15).
 * Each test reproduces the stranger's exact situation, not a proxy for it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

describe('ZIP-download stranger: no .git anywhere above the harness', () => {
  let copy;
  before(() => {
    // A ZIP download = the tracked tree without .git. tar keeps it portable.
    copy = mkdtempSync(join(tmpdir(), 'sakk-zip-'));
    execSync(
      `tar -cf - --exclude .git --exclude node_modules --exclude mutation-drill-report.txt .` +
        ` | (cd '${copy}' && tar -xf -)`,
      { cwd: REPO, stdio: 'ignore' },
    );
  });
  after(() => rmSync(copy, { recursive: true, force: true }));

  const runner = (args) =>
    spawnSync(process.execPath, [join(copy, 'eval', 'bin', 'gold-runner.mjs'), ...args], {
      encoding: 'utf8',
      timeout: 120_000,
      // GIT_DIR/GIT_WORK_TREE from a caller must not silently rescue the run
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      cwd: copy,
    });

  test('an execution mode refuses with HARNESS_GIT_REQUIRED, one line, no stack', () => {
    const r = runner(['--fake-executor', '--case', 'G12']);
    assert.equal(r.status, 2, `exit=${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /HARNESS_GIT_REQUIRED/);
    assert.doesNotMatch(r.stderr, /at prepCase|not a git repository/, 'raw crash leaked through');
  });

  test('--validate still works without .git (the ZIP stranger can at least check schemas)', () => {
    const r = runner(['--validate']);
    assert.equal(r.status, 0, r.stderr);
  });
});

describe("nested-checkout stranger: the harness sits inside SOMEONE ELSE's repository", () => {
  // F-64: extracted (ZIP, vendored) inside any git repo, `git rev-parse HEAD`
  // named the parent's commit and the dirty check looked at the parent's
  // eval/ — pack-report said harness_dirty:false over a modified harness.
  let parent;
  before(() => {
    parent = mkdtempSync(join(tmpdir(), 'sakk-nested-'));
    execSync('mkdir sakk', { cwd: parent });
    execSync(
      `tar -cf - --exclude .git --exclude node_modules --exclude mutation-drill-report.txt .` +
        ` | (cd '${join(parent, 'sakk')}' && tar -xf -)`,
      { cwd: REPO, stdio: 'ignore' },
    );
    execSync(
      'git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm parent',
      { cwd: parent, stdio: 'ignore' },
    );
  });
  after(() => rmSync(parent, { recursive: true, force: true }));

  test('an execution mode refuses with HARNESS_GIT_REQUIRED instead of naming the parent commit', () => {
    const copy = join(parent, 'sakk');
    const r = spawnSync(
      process.execPath,
      [join(copy, 'eval', 'bin', 'gold-runner.mjs'), '--fake-executor', '--case', 'G12'],
      { encoding: 'utf8', timeout: 120_000, cwd: copy },
    );
    assert.equal(r.status, 2, `exit=${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /HARNESS_GIT_REQUIRED/);
    assert.match(r.stderr, /not the top of its own git repository/);
  });
});

describe('symlinked-path stranger: the CLI must execute, never silently no-op', () => {
  // macOS tmpdir lives under /var → /private/var; URL-equality main-module
  // detection saw two different paths and quietly did NOTHING (exit 0).
  test('a runner invoked through a symlink still runs its CLI (proven by a refusal)', () => {
    const d = mkdtempSync(join(tmpdir(), 'sakk-link-'));
    const link = join(d, 'repolink');
    symlinkSync(REPO, link);
    const r = spawnSync(
      process.execPath,
      [join(link, 'eval', 'bin', 'gold-runner.mjs'), '--case', 'G99_TYPO'],
      { encoding: 'utf8', timeout: 60_000 },
    );
    rmSync(d, { recursive: true, force: true });
    // A silent no-op exits 0 with no output; a running CLI refuses loudly.
    assert.equal(r.status, 2, `exit=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /CASE_SELECTOR_UNKNOWN/);
  });
});

describe('relative --out stranger: the out path means the same thing to every process', () => {
  // A relative --out reached executors and verification commands that run in
  // other working directories: every case scored FAIL (G01 "claimed [] !=
  // actual", G05 "got FAIL") while the same run with an absolute path passed.
  test('`--out run1` from some directory scores exactly like an absolute --out', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sakk-rel-'));
    const r = spawnSync(
      process.execPath,
      [
        join(REPO, 'eval', 'bin', 'gold-runner.mjs'),
        '--fake-executor',
        '--case',
        'G01,G05',
        '--out',
        'run1',
      ],
      { cwd, encoding: 'utf8', timeout: 300_000 },
    );
    rmSync(cwd, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^G01: PASS/m);
    assert.match(r.stdout, /^G05: PASS/m);
    const summary = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('{"runId"')));
    assert.ok(isAbsolute(summary.outDir) && summary.outDir.endsWith('/run1'), summary.outDir);
  });
});

describe('tampered answer key (gold review S4)', () => {
  test('a gold file that differs from its manifest stops a fake-executor run too', () => {
    const copy = mkdtempSync(join(tmpdir(), 'sakk-tamper-'));
    execSync(
      `tar -cf - --exclude .git --exclude node_modules --exclude mutation-drill-report.txt --exclude audit-logs .` +
        ` | (cd '${copy}' && tar -xf -)`,
      { cwd: REPO, stdio: 'ignore' },
    );
    execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm c', {
      cwd: copy,
      stdio: 'ignore',
    });
    writeFileSync(join(copy, 'eval', 'gold', 'G01', 'scoring.json'), '{"secret_canaries":[]}\n');
    const r = spawnSync(
      process.execPath,
      [join(copy, 'eval', 'bin', 'gold-runner.mjs'), '--fake-executor', '--case', 'G01'],
      { encoding: 'utf8', timeout: 120_000, cwd: copy },
    );
    rmSync(copy, { recursive: true, force: true });
    assert.equal(r.status, 2, `exit=${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /GOLD_MANIFEST_MISMATCH/);
  });
});
