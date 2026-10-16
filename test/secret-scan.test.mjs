import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
// A wall clock only catches pathology (catastrophic backtracking, quadratic
// line numbering, one process per blob) — never speed. These run in ~3 ms,
// ~85 ms and a few seconds idle; the audit's mutation drill ran a test 14x
// slower than idle (F-62), so any tighter line reports load, not code.
const PATHOLOGY_MS = 30_000;
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
  test('200KB adversarial lines for every rule scan without catastrophic backtracking', () => {
    const hostile = [
      `://${'a:%41'.repeat(40_000)}`,
      `${SCHEME}${'a:'.repeat(100_000)}`,
      `password = "${'x'.repeat(200_000)}`,
      `Bearer ${'a'.repeat(200_000)}`,
      `${'%41'.repeat(70_000)}`,
    ];
    const t0 = Date.now();
    for (const h of hostile) scanText(h);
    assert.ok(Date.now() - t0 < PATHOLOGY_MS, `took ${Date.now() - t0}ms`);
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
    assert.ok(Date.now() - t0 < PATHOLOGY_MS, `took ${Date.now() - t0}ms`);
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
  test('review S2: a merge commit bringing in a secret is refused by the pre-merge-commit hook', () => {
    const d = repo();
    writeFileSync(join(d, 'base.txt'), 'base\n');
    git(d, 'add', 'base.txt');
    git(d, 'commit', '-qm', 'base');
    assert.equal(cli(['--install-hook'], { cwd: d }).status, 0);
    git(d, 'checkout', '-qb', 'feat');
    writeFileSync(join(d, 'app.env'), `DB=${FAKE_DSN}\n`);
    git(d, 'add', 'app.env');
    git(d, 'commit', '--no-verify', '-qm', 'leak on a branch');
    git(d, 'checkout', '-q', '-');
    const head = git(d, 'rev-parse', 'HEAD').trim();
    const m = spawnSync('git', ['merge', '--no-ff', '-q', '-m', 'merge', 'feat'], { cwd: d });
    assert.notEqual(m.status, 0, 'the merge commit is refused');
    assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, 'nothing recorded');
  });
  test('review S2: an existing pre-merge-commit hook means NOTHING is installed (both or neither)', () => {
    const d = repo();
    writeFileSync(join(d, '.git', 'hooks', 'pre-merge-commit'), '#!/bin/sh\n');
    const r = cli(['--install-hook'], { cwd: d });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /SCAN_HOOK_EXISTS: .*pre-merge-commit/);
    assert.equal(spawnSync('test', ['-e', join(d, '.git', 'hooks', 'pre-commit')]).status, 1);
  });
  test('review S6: a hook whose node is gone refuses with SCAN_HOOK_STALE, not a bare shell error', () => {
    const d = repo();
    assert.equal(cli(['--install-hook'], { cwd: d }).status, 0);
    const hookPath = join(d, '.git', 'hooks', 'pre-commit');
    writeFileSync(
      hookPath,
      readFileSync(hookPath, 'utf8').replaceAll(
        process.execPath,
        '/nonexistent/Cellar/node/0/bin/node',
      ),
    );
    writeFileSync(join(d, 'ok.txt'), 'clean\n');
    git(d, 'add', 'ok.txt');
    const c = spawnSync('git', ['commit', '-qm', 'x'], { cwd: d, encoding: 'utf8' });
    assert.notEqual(c.status, 0);
    assert.match(c.stderr, /SCAN_HOOK_STALE/);
  });
  test('review S1: a git replace ref cannot make --staged read other bytes than the commit records', () => {
    const d = repo();
    writeFileSync(join(d, 'clean.txt'), 'nothing here\n');
    const cleanSha = git(d, 'hash-object', '-w', 'clean.txt').trim();
    writeFileSync(join(d, 'app.env'), `DB=${FAKE_DSN}\n`);
    git(d, 'add', 'app.env');
    const secretSha = git(d, 'rev-parse', ':app.env').trim();
    git(d, 'replace', secretSha, cleanSha);
    assert.equal(scanStaged(d).findings.length, 1);
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
    // the ROOT, not a list of directories: README, CHANGELOG, findings/ and
    // specs/ were never scanned while the list said "whole repository" (F-79)
    const root = join(HERE, '..');
    const r = scanPaths([root]);
    assert.ok(r.scanned > 200, `scanned only ${r.scanned} files`);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.unreadable, []);
  });
});

describe('verify pass B1: no staged blob can go unscanned', () => {
  test('from a subdirectory, --staged still sees the whole index', () => {
    const d = repo();
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 'app.env'), `DB=${FAKE_DSN}\n`);
    git(d, 'add', '-A');
    assert.equal(scanStaged(join(d, 'sub')).findings.length, 1);
    assert.equal(cli(['--staged'], { cwd: join(d, 'sub') }).status, 1);
  });
  test('two names that decode alike cannot hide a secret blob from the installed hook', () => {
    const d = repo();
    assert.equal(cli(['--install-hook'], { cwd: d }).status, 0);
    const blob = (text) =>
      execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: d,
        input: text,
        encoding: 'utf8',
      }).trim();
    const secret = blob(`DB=${FAKE_DSN}\n`);
    const clean = blob('DB=clean\n');
    const line = (sha, byte) =>
      Buffer.concat([Buffer.from(`100644 ${sha}\t`), Buffer.from([byte]), Buffer.from('.env\n')]);
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: d,
      input: Buffer.concat([line(secret, 0xfe), line(clean, 0xff)]),
    });
    assert.equal(scanStaged(d).findings.length, 1);
    assert.notEqual(spawnSync('git', ['commit', '-qm', 'collide'], { cwd: d }).status, 0);
  });
  test('a staged symlink whose target string is secret-shaped is scanned', () => {
    const d = repo();
    symlinkSync(FAKE_DSN, join(d, 'link'));
    git(d, 'add', 'link');
    assert.equal(scanStaged(d).findings.length, 1);
  });
  test('git missing from PATH says so (SCAN_GIT_MISSING), exit 2', () => {
    const r = cli(['--staged'], { cwd: repo(), env: { ...process.env, PATH: '/nonexistent' } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /SCAN_GIT_MISSING/);
  });
  test('2000 staged files scan in one batch, not one process per blob', () => {
    const d = repo();
    for (let i = 0; i < 2000; i++) writeFileSync(join(d, `f${i}.txt`), `line ${i}\n`);
    git(d, 'add', '-A');
    const t0 = Date.now();
    assert.equal(scanStaged(d).scanned, 2000);
    assert.ok(Date.now() - t0 < PATHOLOGY_MS, `took ${Date.now() - t0}ms`);
  });
});

describe('verify pass: explicit inputs and usage', () => {
  test('an explicit root that is a symlink is followed and scanned', () => {
    const d = tdir();
    mkdirSync(join(d, 'real'));
    writeFileSync(join(d, 'real', 'app.env'), `DB=${FAKE_DSN}\n`);
    symlinkSync(join(d, 'real'), join(d, 'linkdir'));
    assert.equal(cli([join(d, 'linkdir')]).status, 1);
  });
  test('an explicit fifo is unreadable (exit 2), never "scanned 0, clean"', () => {
    const d = tdir();
    const fifo = join(d, 'p');
    if (spawnSync('mkfifo', [fifo]).status !== 0) return;
    const r = cli([fifo]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /SCAN_UNREADABLE/);
  });
  test('--staged with paths is a usage error, not a silently dropped path', () => {
    const r = cli(['src', '--staged'], { cwd: repo() });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /SCAN_USAGE/);
  });
  test('an odd-length FE FF file does not abort the scan; the real secret beside it is found', () => {
    const d = tdir();
    writeFileSync(join(d, 'data.bin'), Buffer.from([0xfe, 0xff, 0x01]));
    writeFileSync(join(d, 'app.env'), `DB=${FAKE_DSN}\n`);
    assert.equal(cli([d]).status, 1);
  });
  test('UTF-32 (BOM) text is decoded, not mis-read as UTF-16', () => {
    const d = tdir();
    const text = `DB=${FAKE_DSN}\n`;
    const body = Buffer.alloc(text.length * 4);
    [...text].forEach((c, i) => body.writeUInt32LE(c.codePointAt(0), i * 4));
    writeFileSync(join(d, 'u32.txt'), Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), body]));
    assert.equal(cli([d]).status, 1);
  });
  test('control characters in a file name are escaped — a name cannot forge a summary line', () => {
    const d = tdir();
    writeFileSync(join(d, 'a\nscanned 9 file(s): 0 finding(s)'), `DB=${FAKE_DSN}\n`);
    const r = cli([d]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout.match(/^scanned /gm).length, 1, r.stdout);
    assert.match(r.stdout, /\\x0a/);
  });
});

describe('verify pass: patterns', () => {
  test('ordinary identifiers starting sk_/rk_/sk- are not API keys', () => {
    for (const code of [
      'sk_set_memalloc_and_flags(sk)',
      'rk_reconfigure_cluster_nodes()',
      'const sk_learn_pipeline_config = 1',
      'const name = "sk-learn-pipeline-configuration"',
    ])
      assert.equal(scanText(code).findings.length, 0, code);
  });
  test('key shapes with digits still match', () => {
    for (const k of [
      ['sk', '-', 'proj', '-', 'Ab3'.repeat(10)].join(''),
      ['sk', '_live_', '9Zq'.repeat(10)].join(''),
      ['rk', '_test_', '4Lm'.repeat(10)].join(''),
    ])
      assert.equal(scanText(k).findings.length, 1, k.slice(0, 8));
  });
  test('rediss, amqps and an empty-user redis URL are database URLs too', () => {
    for (const scheme of ['rediss', 'amqps', 'redis'])
      assert.equal(
        scanText(`${scheme}${':'}//${scheme === 'redis' ? '' : 'default'}:${FAKE_PW}@host:6380/0`)
          .findings.length,
        1,
        scheme,
      );
  });
  test('a fiction token glued to a real key exempts nothing', () => {
    const glued = ['sk', '-', FICTIONAL_EXEMPTION_TOKEN, '-sk', '_live_', '7Kd'.repeat(10)].join(
      '',
    );
    assert.equal(scanText(glued).findings.length, 1);
  });
  test('password assignments aligned with many spaces are still found', () => {
    assert.equal(scanText(`db_password${' '.repeat(16)}= "${FAKE_PW}x"`).findings.length, 1);
  });
});

describe('verify pass: installing the hook', () => {
  test('a hooksPath that is a regular file → SCAN_HOOK_UNWRITABLE, exit 2, no stack trace', () => {
    const d = repo();
    writeFileSync(join(d, 'hf'), 'x');
    git(d, 'config', 'core.hooksPath', 'hf');
    const r = cli(['--install-hook'], { cwd: d });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /SCAN_HOOK_UNWRITABLE|SCAN_HOOK_DIR_MISSING/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  });
  test('installed under umask 177 the hook is still executable and still refuses secrets', () => {
    const d = repo();
    const inst = spawnSync(
      'sh',
      ['-c', `umask 177; "${process.execPath}" "${CLI}" scan --install-hook`],
      {
        cwd: d,
        encoding: 'utf8',
      },
    );
    assert.equal(inst.status, 0, inst.stderr);
    assert.ok(statSync(join(d, '.git', 'hooks', 'pre-commit')).mode & 0o100);
    writeFileSync(join(d, 'app.env'), `DB=${FAKE_DSN}\n`);
    git(d, 'add', 'app.env');
    assert.notEqual(spawnSync('git', ['commit', '-qm', 'leak'], { cwd: d }).status, 0);
  });
  test('a sakk installed under a hostile directory name cannot inject shell into the hook', () => {
    const base = tdir();
    const inst = join(base, 'inst $(touch PWNED) `touch PWNED2` "q"');
    for (const part of ['bin', 'src'])
      cpSync(join(HERE, '..', part), join(inst, part), { recursive: true });
    cpSync(join(HERE, '..', 'package.json'), join(inst, 'package.json'));
    const d = repo();
    assert.equal(
      spawnSync(process.execPath, [join(inst, 'bin', 'sakk.mjs'), 'scan', '--install-hook'], {
        cwd: d,
      }).status,
      0,
    );
    writeFileSync(join(d, 'ok.txt'), 'clean\n');
    git(d, 'add', 'ok.txt');
    assert.equal(
      spawnSync('git', ['commit', '-qm', 'clean'], { cwd: d }).status,
      0,
      'the hook still runs',
    );
    assert.ok(!existsSync(join(d, 'PWNED')) && !existsSync(join(d, 'PWNED2')));
  });
  test('installing from the temporary npx cache is refused (SCAN_HOOK_EPHEMERAL)', () => {
    const base = join(tdir(), '_npx', '0a1b2c3d4e5f6789', 'node_modules', 'sakk');
    for (const part of ['bin', 'src'])
      cpSync(join(HERE, '..', part), join(base, part), { recursive: true });
    cpSync(join(HERE, '..', 'package.json'), join(base, 'package.json'));
    const r = spawnSync(
      process.execPath,
      [join(base, 'bin', 'sakk.mjs'), 'scan', '--install-hook'],
      {
        cwd: repo(),
        encoding: 'utf8',
      },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /SCAN_HOOK_EPHEMERAL/);
  });
});

describe('verify pass round 3', () => {
  test('S1: Stripe-style prefixed keys without digits, sk_<hex> and long sk- keys are found', () => {
    for (const k of [
      ['sk', '_live_', 'abcdefghijklmnopqrstuvwx'].join(''),
      ['rk', '_live_', 'abcdefghijklmnopqrstuvwx'].join(''),
      ['sk', '_', '0123456789abcdef'.repeat(3)].join(''),
      ['sk', '-', 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv'].join(''),
    ])
      assert.equal(scanText(k).findings.length, 1, k.slice(0, 10));
  });
  test('S2: diff.relative=true does not hide files from a subdirectory scan', () => {
    const d = repo();
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'a.env'), `DB=${FAKE_DSN}\n`);
    writeFileSync(join(d, 'sub', 'ok'), 'clean\n');
    git(d, 'add', '-A');
    git(d, 'config', 'diff.relative', 'true');
    assert.equal(cli(['--staged'], { cwd: join(d, 'sub') }).status, 1);
  });
  test('N1: values on the next line (YAML, wrapped Bearer) are found', () => {
    for (const t of [
      `password:\n    "${FAKE_PW}abc"`,
      `password =\n  "${FAKE_PW}"`,
      `Bearer\n${'Zx9pQ7rT2v'.repeat(4)}`,
    ])
      assert.equal(scanText(t).findings.length, 1, JSON.stringify(t.slice(0, 12)));
  });
  test('N2: a placeholder in the secret position is not a secret', () => {
    for (const t of [
      `REDIS_URL=redis${':'}//:\${REDIS_PASSWORD}@redis:6379/0`,
      `rediss${':'}//:%(redis_password)s@cache:6380`,
      `DB=${SCHEME}app:{{ db_password }}@db/app`,
      ['password', ' = "${DB_PASSWORD_FROM_VAULT}"'].join(''),
    ])
      assert.equal(scanText(t).findings.length, 0, t);
  });
  test('N3: a staged object missing from the repository is named as missing', () => {
    const d = repo();
    git(d, 'update-index', '--add', '--cacheinfo', `100644,${'1234567890'.repeat(4)},ghost.txt`);
    const r = cli(['--staged'], { cwd: d });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /object missing from the repository/);
  });
  test('N4/N6: --install-hook without git says SCAN_GIT_MISSING; with paths it is SCAN_USAGE', () => {
    const d = repo();
    const nogit = cli(['--install-hook'], {
      cwd: d,
      env: { ...process.env, PATH: '/nonexistent' },
    });
    assert.equal(nogit.status, 2);
    assert.match(nogit.stderr, /SCAN_GIT_MISSING/);
    const withPath = cli(['--install-hook', 'src'], { cwd: d });
    assert.equal(withPath.status, 2);
    assert.match(withPath.stderr, /SCAN_USAGE/);
  });
  test('N5: a legit path containing _npx installs; bunx and pnpm dlx caches are refused', () => {
    const mk = (...parts) => {
      const base = join(tdir(), ...parts);
      for (const part of ['bin', 'src'])
        cpSync(join(HERE, '..', part), join(base, part), { recursive: true });
      cpSync(join(HERE, '..', 'package.json'), join(base, 'package.json'));
      return spawnSync(
        process.execPath,
        [join(base, 'bin', 'sakk.mjs'), 'scan', '--install-hook'],
        {
          cwd: repo(),
          encoding: 'utf8',
        },
      );
    };
    assert.equal(mk('work', '_npx', 'tools', 'sakk').status, 0, 'a legit install');
    for (const parts of [
      ['bunx-501-sakk@0.1.0', 'node_modules', 'sakk'],
      ['.cache', 'pnpm', 'dlx', 'abc123', 'node_modules', 'sakk'],
    ]) {
      const r = mk(...parts);
      assert.equal(r.status, 2, parts.join('/'));
      assert.match(r.stderr, /SCAN_HOOK_EPHEMERAL/);
    }
  });
  test('N7: C1 controls and Unicode line separators in names are escaped', () => {
    const d = tdir();
    writeFileSync(join(d, 'a\u009b2K\u2028b.env'), `DB=${FAKE_DSN}\n`);
    const r = cli([d]);
    assert.equal(r.status, 1);
    assert.ok(!/[\u0080-\u009f\u2028\u2029]/.test(r.stdout), JSON.stringify(r.stdout));
    assert.match(r.stdout, /\\x9b2K\\u2028b/);
  });
  test('N8: a key glued right after the fiction token is found', () => {
    const glued = [FICTIONAL_EXEMPTION_TOKEN, 'sk', '_live_', '7Kd'.repeat(10)].join('');
    assert.equal(scanText(glued).findings.length, 1);
  });
  test('review S4: a PGP private key block is a private-key block', () => {
    const pgp = ['-----BEGIN PGP', 'PRIVATE KEY BLOCK-----'].join(' ');
    assert.equal(scanText(pgp).findings.length, 1);
  });
  test('RC-03 class: a fiction token beside any real secret, in any position, never hides it', () => {
    // judged in context, not on the literal capture: every recognized shape
    // × every way a declared fiction can sit next to it (F-11, F-63)
    const T = FICTIONAL_EXEMPTION_TOKEN;
    const F = `${SCHEME}u:${T}`;
    const shapes = [
      `${SCHEME}app:${FAKE_PW}@db.internal/app`,
      ['AKIA', 'Q7RT2VW4MN8KZX9P'].join(''),
      ['ghp', '_', 'Zx9pQ7rT2vW4mN8kL3s'.repeat(2)].join(''),
      ['sk', '_live_', 'Zx9pQ7rT2vW4mN8kL3sJ'].join(''),
      ['password', ' = "', 'Zx9pQ7rT2vW4', '"'].join(''),
    ];
    const contexts = [
      (x) => `${F}${x}`,
      (x) => `${F},${x}`,
      (x) => `${F} ${x}`,
      (x) => `${T}${x}`,
      (x) => `${x}${T}`,
      (x) => `${x} ${F}@h`,
      (x) => `${F}@h ${x}`,
      (x) => x.replace('app:', `${T}:`), // the fiction as the real DSN's own user (F-11)
    ];
    const missed = [];
    for (const x of shapes)
      contexts.forEach((c, i) => {
        if (scanText(c(x)).findings.length === 0) missed.push(`context ${i}: ${x.slice(0, 12)}…`);
      });
    assert.deepEqual(missed, []);
  });
  test('F-63: an exempt match never hides a real secret it swallowed', () => {
    // the greedy DSN capture runs to the first '@', swallowing a second DSN;
    // the outer match is exempt, the inner one is a real recognized secret
    const T = FICTIONAL_EXEMPTION_TOKEN;
    const ENC = ['p', '%40', 'ss'].join('');
    for (const text of [
      `${SCHEME}u:${T}${SCHEME}x:${FAKE_PW}@h`,
      `urls=${SCHEME}u:${T},${SCHEME}x:${FAKE_PW}@h`,
      `https://u:${T}https://x:${ENC}@h`,
    ])
      assert.equal(scanText(text).findings.length, 1, text);
    // control: a lone declared fiction is still exempt
    const lone = scanText(`${SCHEME}stub:${T}@127.0.0.1:5499/db`);
    assert.deepEqual([lone.findings.length, lone.exempted], [0, 1]);
  });
});
