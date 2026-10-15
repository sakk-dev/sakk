import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
