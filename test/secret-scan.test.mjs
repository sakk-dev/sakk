import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXEMPTIONS,
  FICTIONAL_EXEMPTION_TOKEN,
  scanPaths,
  scanStaged,
  scanText,
} from '../src/secret-scan.mjs';

// Every "secret" here is assembled at runtime from harmless pieces, so this
// test file can never itself become a source of real-looking findings.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'sakk.mjs');
const FAKE_PW = ['zz', 'fake', 'pw', '12345'].join('');
const FAKE_DSN = `postgresql://user:${FAKE_PW}@db.internal.example/app`;
const tdir = () => mkdtempSync(join(tmpdir(), 'sakk-scan-'));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const repo = () => {
  const d = tdir();
  git(d, 'init', '-q');
  git(d, 'config', 'user.email', 't@t');
  git(d, 'config', 'user.name', 't');
  return d;
};

describe('detection', () => {
  test('a hard-coded DSN with a password is caught', () => {
    const r = scanText(`const url = '${FAKE_DSN}';`, 'x.mjs');
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].rule, 'dsn_with_password');
  });
  test('URL-encoding is not a disguise', () => {
    const r = scanText('postgresql://u:p%40ss%3Aword@host/db', 'y.env');
    assert.ok(r.findings.some((f) => /password/.test(f.rule)));
  });
  test('cloud keys, tokens and private-key blocks are caught', () => {
    const samples = [
      `AKIA${'A'.repeat(16)}`,
      `sk-${'a1'.repeat(15)}`,
      `ghp_${'b2'.repeat(20)}`,
      ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
      `Bearer ${'c3'.repeat(15)}`,
    ];
    for (const s of samples) assert.equal(scanText(s).findings.length, 1, s.slice(0, 12));
  });
});

describe('exemption discipline', () => {
  test('the exemption list is exactly the one fictional token — no real fragments can hide in it', () => {
    assert.deepEqual([...EXEMPTIONS], [FICTIONAL_EXEMPTION_TOKEN]);
    const self = scanText(readFileSync(join(HERE, '..', 'src', 'secret-scan.mjs'), 'utf8'));
    assert.equal(self.findings.length, 0, 'the scanner source itself must be clean');
  });
  test('a value carrying the token is exempted — and COUNTED, never silent', () => {
    const r = scanText(`postgresql://stub:${FICTIONAL_EXEMPTION_TOKEN}@127.0.0.1:5499/db`);
    assert.equal(r.findings.length, 0);
    assert.equal(r.exempted, 1);
  });
  test('localhost is not a free pass', () => {
    assert.equal(scanText(`postgresql://u:${FAKE_PW}@127.0.0.1:5432/db`).findings.length, 1);
  });
});

describe('findings never contain the secret', () => {
  test('fingerprints only — the raw value never appears in output', () => {
    const r = scanText(FAKE_DSN);
    assert.ok(!JSON.stringify(r).includes(FAKE_PW));
    assert.match(r.findings[0].fingerprint, /^[0-9a-f]{12}$/);
    assert.equal(scanText(FAKE_DSN).findings[0].fingerprint, r.findings[0].fingerprint);
    assert.notEqual(
      scanText(FAKE_DSN.replace('12345', '54321')).findings[0].fingerprint,
      r.findings[0].fingerprint,
    );
  });
  test('the CLI output never prints the secret either', () => {
    const d = tdir();
    writeFileSync(join(d, 'cfg.env'), `DB=${FAKE_DSN}\n`);
    const r = spawnSync(process.execPath, [CLI, 'scan', d], { encoding: 'utf8' });
    assert.equal(r.status, 1, 'findings → exit 1');
    assert.ok(!r.stdout.includes(FAKE_PW) && !r.stderr.includes(FAKE_PW));
    assert.match(r.stdout, /cfg\.env:1\s+dsn_with_password\s+fp=[0-9a-f]{12}/);
  });
});

describe('walking the tree safely', () => {
  test('a secret in a log on line 2 is reported with path and line', () => {
    const d = tdir();
    writeFileSync(join(d, 'cmd.log'), `ok\npsql ${FAKE_DSN}\n`);
    const r = scanPaths([d]);
    assert.equal(r.findings[0].line, 2);
  });
  test('symlink loops and links out of the tree are skipped, never followed', () => {
    const d = tdir();
    mkdirSync(join(d, 'a'));
    symlinkSync(d, join(d, 'a', 'loop'));
    const outside = tdir();
    writeFileSync(join(outside, 'secret.env'), `X=${FAKE_DSN}\n`);
    symlinkSync(outside, join(d, 'escape'));
    const r = scanPaths([d]);
    assert.equal(r.findings.length, 0, 'nothing outside the tree, no infinite loop');
  });
  test('binary files are skipped by NUL sniffing', () => {
    const d = tdir();
    writeFileSync(
      join(d, 'blob.dat'),
      Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(FAKE_DSN)]),
    );
    assert.equal(scanPaths([d]).scanned, 0);
  });
});

describe('pre-commit: what is STAGED is what gets checked', () => {
  test('--staged scans the staged blob, not the working-tree file', () => {
    const d = repo();
    writeFileSync(join(d, 'app.env'), `DB=${FAKE_DSN}\n`);
    git(d, 'add', 'app.env');
    writeFileSync(join(d, 'app.env'), 'DB=clean\n'); // working tree cleaned, index still dirty
    const r = scanStaged(d);
    assert.equal(r.findings.length, 1, 'the commit would record the secret — must be caught');
  });
  test('the installed hook refuses a commit that contains a secret', () => {
    const d = repo();
    const inst = spawnSync(process.execPath, [CLI, 'scan', '--install-hook'], {
      cwd: d,
      encoding: 'utf8',
    });
    assert.equal(inst.status, 0, inst.stderr);
    // point the hook at THIS checkout's CLI (npx would need a published package)
    const hookPath = join(d, '.git', 'hooks', 'pre-commit');
    writeFileSync(
      hookPath,
      readFileSync(hookPath, 'utf8').replace('npx sakk', `"${process.execPath}" "${CLI}"`),
    );
    writeFileSync(join(d, 'app.env'), `DB=${FAKE_DSN}\n`);
    git(d, 'add', 'app.env');
    const c = spawnSync('git', ['commit', '-qm', 'leak'], { cwd: d, encoding: 'utf8' });
    assert.notEqual(c.status, 0, 'the commit must be refused');
    assert.equal(
      spawnSync('git', ['rev-parse', 'HEAD'], { cwd: d }).status,
      128,
      'no commit exists',
    );
  });
  test('--install-hook never overwrites an existing pre-commit hook', () => {
    const d = repo();
    const hookPath = join(d, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho team-hook\n');
    const r = spawnSync(process.execPath, [CLI, 'scan', '--install-hook'], {
      cwd: d,
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /SCAN_HOOK_EXISTS/);
    assert.equal(readFileSync(hookPath, 'utf8'), '#!/bin/sh\necho team-hook\n');
  });
  test('usage errors exit 2: no paths, or --staged outside a repo', () => {
    assert.equal(spawnSync(process.execPath, [CLI, 'scan'], { encoding: 'utf8' }).status, 2);
    const r = spawnSync(process.execPath, [CLI, 'scan', '--staged'], {
      cwd: tdir(),
      encoding: 'utf8',
      env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    assert.equal(r.status, 2);
  });
});

describe('the repository itself', () => {
  test('sakk source, CLI, harness and scripts carry zero secret findings', () => {
    const root = join(HERE, '..');
    const r = scanPaths(
      ['src', 'bin', 'eval/lib', 'eval/bin', 'scripts'].map((p) => join(root, p)),
    );
    assert.deepEqual(r.findings, []);
  });
});
