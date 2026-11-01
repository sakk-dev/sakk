import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from '../scripts/evidence-bundle.mjs';

/**
 * The path no single feature branch could test: a case-pack run, bundled,
 * verified by the bundle's own verifier as an auditor would run it.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tdir = () => mkdtempSync(join(tmpdir(), 'pack-bundle-'));

test('a FAKE pack run bundles and verifies; its report reads HARNESS_ONLY and names no model', () => {
  const run = join(tdir(), 'run');
  const r = spawnSync(
    process.execPath,
    [
      join(ROOT, 'eval', 'bin', 'gold-runner.mjs'),
      '--fake-executor',
      '--pack',
      'example-change-control',
      '--out',
      run,
    ],
    { encoding: 'utf8', timeout: 300_000 },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = tdir();
  const built = buildBundle({ source: run, to: join(out, 'b.tgz') });
  assert.equal(built.status, 'PASS');
  execFileSync('tar', ['-xzf', built.to, '-C', out]);
  const b = join(
    out,
    readdirSync(out).find((n) => n.startsWith('sakk-evidence-')),
  );
  const report = JSON.parse(readFileSync(join(b, 'run', 'pack-report.json'), 'utf8'));
  assert.equal(report.executor_mode, 'FAKE');
  assert.equal(report.model, null);
  assert.ok(report.requirements.every((x) => x.status === 'HARNESS_ONLY'));
  const v = spawnSync(process.execPath, ['verify.mjs'], { cwd: b, encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout);
  assert.match(v.stdout, /VERIFY PASS/);
});
