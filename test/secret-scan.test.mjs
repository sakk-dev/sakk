import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXEMPTIONS,
  FICTIONAL_EXEMPTION_TOKEN,
  scanPaths,
  scanStaged,
  scanText,
  ScanError,
} from '../src/secret-scan.mjs';

// Every "secret" here is assembled at runtime from pieces that do not match
// any rule in this SOURCE text — the repository must be able to scan (and
// commit) its own tests. A self-scan test below enforces that.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'sakk.mjs');
const SCHEME = ['postgresql', ':', '//'].join('');
const FAKE_PW = ['zz', 'fake', 'pw', '12345'].join('');
const FAKE_DSN = `${SCHEME}user:${FAKE_PW}@db.internal.example/app`;
const tdir = () => mkdtempSync(join(tmpdir(), 'sakk-scan-'));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const repo = () => {
  const d = tdir();
  git(d, 'init', '-q');
  git(d, 'config', 'user.email', 't@t');
  git(d, 'config', 'user.name', 't');
  return d;
};
const cli = (args, opts = {}) =>
  spawnSync(process.execPath, [CLI, 'scan', ...args], { encoding: 'utf8', ...opts });
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('detection', () => {
  test('DSN with a password, URL-encoded passwords', () => {
    assert.equal(scanText(`const url = '${FAKE_DSN}';`).findings[0].rule, 'dsn_with_password');
    assert.ok(scanText(`${SCHEME}u:p%40ss%3Aword@host/db`).findings.length >= 1);
  });
  test('cloud keys, sk_live_ keys, classic and fine-grained GitHub tokens, key blocks, bearer tokens', () => {
    const samples = [
      ['AKIA', 'A'.repeat(16)].join(''),
      ['sk', '-', 'a1'.repeat(15)].join(''),
      ['sk', '_live_', 'b2'.repeat(15)].join(''),
      ['ghp', '_', 'c3'.repeat(20)].join(''),
      ['github', '_pat_', 'd4'.repeat(15)].join(''),
      ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
      ['Bearer', 'e5'.repeat(15)].join(' '),
    ];
    for (const s of samples) assert.equal(scanText(s).findings.length, 1, s.slice(0, 14));
  });
});

describe('exemption discipline', () => {
  test('the exemption list is exactly the one fictional token', () => {
    assert.deepEqual([...EXEMPTIONS], [FICTIONAL_EXEMPTION_TOKEN]);
  });
  test('a token in the SECRET part is exempted and counted', () => {
    const r = scanText(`${SCHEME}stub:${FICTIONAL_EXEMPTION_TOKEN}@127.0.0.1:5499/db`);
    assert.equal(r.findings.length, 0);
    assert.equal(r.exempted, 1);
  });
  test('a token in the USERNAME does not exempt a real password (review)', () => {
    const r = scanText(`${SCHEME}${FICTIONAL_EXEMPTION_TOKEN}:${FAKE_PW}@prod.example/db`);
    assert.equal(r.findings.length, 1);
  });
  test('localhost is not a free pass', () => {
    assert.equal(scanText(`${SCHEME}u:${FAKE_PW}@127.0.0.1:5432/db`).findings.length, 1);
  });
});

describe('output never carries a secret', () => {
  test('keyed fingerprints: stable within a run, different across runs unless SAKK_SCAN_KEY is set', () => {
    const r = scanText(FAKE_DSN);
    assert.ok(!JSON.stringify(r).includes(FAKE_PW));
    assert.equal(scanText(FAKE_DSN).findings[0].fingerprint, r.findings[0].fingerprint);
    const fp = (env) =>
      spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { scanText } from ${JSON.stringify(new URL('../src/secret-scan.mjs', import.meta.url).href)}; console.log(scanText(${JSON.stringify(FAKE_DSN)}).findings[0].fingerprint)`,
        ],
        { encoding: 'utf8', env: { ...process.env, ...env } },
      ).stdout.trim();
    assert.notEqual(fp({ SAKK_SCAN_KEY: '' }), fp({ SAKK_SCAN_KEY: '' }), 'random key per process');
    assert.equal(
      fp({ SAKK_SCAN_KEY: 'k' }),
      fp({ SAKK_SCAN_KEY: 'k' }),
      'explicit key → comparable',
    );
  });
  test('a secret in a FILE NAME is redacted in output and counted as a finding (review)', () => {
    const d = tdir();
    const leakyName = ['ghp', '_', 'f6'.repeat(20)].join('');
    writeFileSync(join(d, `${leakyName}.txt`), 'harmless\n');
    const r = cli([d]);
    assert.equal(r.status, 1);
    assert.ok(!r.stdout.includes(leakyName), 'the leaky name must not be printed');
    assert.match(r.stdout, /\[redacted path [0-9a-f]{12}\]/);
  });
});

describe('a scan of nothing is not a pass (review S-3)', () => {
  test('a mistyped path exits 2 SCAN_PATH_MISSING', () => {
    const r = cli([join(tdir(), 'srcc')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /SCAN_PATH_MISSING/);
  });
  test('an EXPLICIT path named like a skip dir (dist) is still scanned', () => {
    const d = tdir();
    mkdirSync(join(d, 'dist'));
    writeFileSync(join(d, 'dist', 'cfg.env'), `DB=${FAKE_DSN}\n`);
    assert.equal(cli([join(d, 'dist')]).status, 1);
  });
  test(
    'an unreadable file makes the scan exit 2 SCAN_UNREADABLE, never 0',
    { skip: isRoot },
    () => {
      const d = tdir();
      writeFileSync(join(d, 'locked.env'), `DB=${FAKE_DSN}\n`);
      chmodSync(join(d, 'locked.env'), 0o000);
      try {
        const r = cli([d]);
        assert.equal(r.status, 2);
        assert.match(r.stderr, /SCAN_UNREADABLE/);
      } finally {
        chmodSync(join(d, 'locked.env'), 0o644);
      }
    },
  );
  test('skips are counted in the summary, and UTF-16 text is scanned, not skipped', () => {
    const d = tdir();
    writeFileSync(join(d, 'blob.dat'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('x')]));
    writeFileSync(
      join(d, 'utf16.txt'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`DB=${FAKE_DSN}\n`, 'utf16le')]),
    );
    const r = cli([d]);
    assert.equal(r.status, 1, 'the UTF-16 secret is found');
    assert.match(r.stdout, /skipped 1 binary/);
  });
});

describe('walking the tree safely', () => {
  test('symlink loops and links out of the tree are skipped (counted), never followed', () => {
    const d = tdir();
    mkdirSync(join(d, 'a'));
    symlinkSync(d, join(d, 'a', 'loop'));
    const outside = tdir();
    writeFileSync(join(outside, 'secret.env'), `X=${FAKE_DSN}\n`);
    symlinkSync(outside, join(d, 'escape'));
    const r = scanPaths([d]);
    assert.equal(r.findings.length, 0);
    assert.equal(r.skipped.symlink, 2);
  });
});

describe('performance: hostile lines cost linear time (review S-4)', () => {
  test('200KB adversarial lines for every rule scan in well under a second', () => {
    const hostile = [
      `://${'a:%41'.repeat(40_000)}`,
      `${SCHEME}${'a:'.repeat(100_000)}`,
      `password = "${'x'.repeat(200_000)}`,
      `Bearer ${'a'.repeat(200_000)}`,
      `${'%41'.repeat(70_000)}`,
    ];
    const t0 = Date.now();
    for (const h of hostile) scanText(h);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
  });
  test('many findings in a big file do not go quadratic on line numbers', () => {
    const text = Array.from(
      { length: 50_000 },
      (_, i) => `k${i}=${['AKIA', String(i).padStart(16, 'A').toUpperCase()].join('')}`,
    ).join('\n');
    const t0 = Date.now();
    const r = scanText(text);
    assert.equal(r.findings.length, 50_000);
    assert.equal(r.findings.at(-1).line, 50_000);
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
  });
});

describe('pre-commit: what is STAGED is what gets checked', () => {
  test('--staged scans the staged blob, not the working-tree file', () => {
    const d = repo();
    writeFileSync(join(d, 'app.env'), `DB=${FAKE_DSN}\n`);
    git(d, 'add', 'app.env');
    writeFileSync(join(d, 'app.env'), 'DB=clean\n');
    assert.equal(scanStaged(d).findings.length, 1);
  });
  test('a TYPE change (symlink → file holding a secret) is scanned (review S-2)', () => {
    const d = repo();
    writeFileSync(join(d, 'cfg.example'), 'DB=placeholder\n');
    symlinkSync('cfg.example', join(d, 'cfg.env'));
    git(d, 'add', '-A');
    git(d, 'commit', '-qm', 'base');
    rmSync(join(d, 'cfg.env'));
    writeFileSync(join(d, 'cfg.env'), `DB=${FAKE_DSN}\n`);
    git(d, 'add', 'cfg.env');
    assert.equal(scanStaged(d).findings.length, 1);
  });
  test('a file literally named "0:foo" is read as itself, not as stage 0 of "foo" (review S-2)', () => {
    const d = repo();
    writeFileSync(join(d, 'foo'), 'clean\n');
    writeFileSync(join(d, '0:foo'), `DB=${FAKE_DSN}\n`);
    git(d, 'add', '-A');
    assert.equal(scanStaged(d).findings.length, 1);
  });
  test('a staged submodule pointer is skipped (counted), not a bogus SCAN_NOT_A_REPO', () => {
    const d = repo();
    git(d, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},sm`);
    const r = scanStaged(d);
    assert.equal(r.skipped.gitlink, 1);
  });
  test('outside a repo → ScanError SCAN_NOT_A_REPO', () => {
    const d = tdir();
    assert.throws(
      () => scanStaged(d),
      (e) => e instanceof ScanError && e.code === 'SCAN_NOT_A_REPO',
    );
  });
});

describe('the hook as SHIPPED (review S-1: no npx, nothing rewritten in the test)', () => {
  test('the installed hook runs this installation by absolute path; clean commits pass, secret commits are refused', () => {
    const d = repo();
    const inst = cli(['--install-hook'], { cwd: d });
    assert.equal(inst.status, 0, inst.stderr);
    const hook = readFileSync(join(d, '.git', 'hooks', 'pre-commit'), 'utf8');
    assert.ok(
      !/\bnpx\b/.test(
        hook
          .split('\n')
          .filter((l) => !l.startsWith('#'))
          .join('\n'),
      ),
      hook,
    );
    assert.ok(hook.includes(process.execPath));
    writeFileSync(join(d, 'ok.txt'), 'clean\n');
    git(d, 'add', 'ok.txt');
    assert.equal(
      spawnSync('git', ['commit', '-qm', 'clean'], { cwd: d }).status,
      0,
      'a clean commit passes',
    );
    writeFileSync(join(d, 'app.env'), `DB=${FAKE_DSN}\n`);
    git(d, 'add', 'app.env');
    assert.notEqual(
      spawnSync('git', ['commit', '-qm', 'leak'], { cwd: d }).status,
      0,
      'a secret commit is refused',
    );
  });
  test('an existing hook — even a DANGLING symlink — is never overwritten or written through', () => {
    const d = repo();
    const hookPath = join(d, '.git', 'hooks', 'pre-commit');
    symlinkSync('../../tools/team-hook', hookPath);
    const r = cli(['--install-hook'], { cwd: d });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /SCAN_HOOK_EXISTS/);
    assert.equal(
      spawnSync('test', ['-e', join(d, 'tools', 'team-hook')]).status,
      1,
      'nothing written through the link',
    );
  });
  test('a hooksPath pointing nowhere → SCAN_HOOK_DIR_MISSING, exit 2', () => {
    const d = repo();
    git(d, 'config', 'core.hooksPath', 'no/such/dir');
    const r = cli(['--install-hook'], { cwd: d });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /SCAN_HOOK_DIR_MISSING/);
  });
});

describe('the repository itself', () => {
  test('the whole repository — tests included — scans clean', () => {
    const root = join(HERE, '..');
    const r = scanPaths(
      ['src', 'bin', 'eval', 'scripts', 'test', 'docs', 'policies'].map((p) => join(root, p)),
    );
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.unreadable, []);
  });
});
