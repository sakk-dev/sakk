import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPaths } from '../src/secret-scan.mjs';

/**
 * `sakk gateway init`: the door for an app that is not a coding agent. The
 * tests run the real CLI as a child process with a temporary HOME and
 * SAKK_HOME, and run the start script it writes with /bin/sh against a fake
 * litellm that records the arguments and SAKK_ variables a real shell gave it.
 * LiteLLM itself is never run (no installs, no paid calls).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'bin', 'sakk.mjs');
const SHIPPED = join(ROOT, 'integrations', 'litellm');
const SYSTEM_PATH = '/usr/bin:/bin';

// records what it was started with, then exits 0 (a real proxy would serve)
const FAKE_LITELLM = `#!/bin/sh
{
  printf 'SELF=%s\\n' "$0"
  for a in "$@"; do printf 'ARG=%s\\n' "$a"; done
  printf 'SAKK_NODE=%s\\n' "$SAKK_NODE"
  printf 'SAKK_BIN=%s\\n' "$SAKK_BIN"
  printf 'SAKK_LEDGER=%s\\n' "$SAKK_LEDGER"
  printf 'SAKK_GATEWAY_CONFIG=%s\\n' "$SAKK_GATEWAY_CONFIG"
  printf 'COST_MAP=%s\\n' "$LITELLM_LOCAL_MODEL_COST_MAP"
} > "$FAKE_OUT"
`;

/** A temp world whose every path has a space and a single quote in it. */
function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gw-init-')));
  const root = join(base, "the parent workspace's");
  const home = join(root, 'home');
  const sakkHome = join(home, '.sakk');
  const fakeBin = join(root, 'fake bin');
  mkdirSync(sakkHome, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, 'litellm'), FAKE_LITELLM, { mode: 0o755 });
  const env = { PATH: `${fakeBin}${delimiter}${SYSTEM_PATH}`, HOME: home, SAKK_HOME: sakkHome };
  const run = (args, opts = {}) =>
    spawnSync(process.execPath, [opts.cli ?? CLI, ...args], {
      encoding: 'utf8',
      env: { ...env, ...opts.env },
      cwd: opts.cwd ?? root,
    });
  const ledger = join(sakkHome, 'sakk-ledger.json');
  const initLedger = () => {
    const r = run(['init', '--cap', '5']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(ledger), 'sakk init made the default ledger');
  };
  return {
    base,
    root,
    home,
    sakkHome,
    fakeBin,
    env,
    run,
    ledger,
    initLedger,
    gwDir: join(sakkHome, 'gateway'),
  };
}

/** Runs a written start.sh the way an operator would, against the fake litellm. */
function startScript(script, { cwd, key = 'test-gateway-key-not-a-secret', extra = {} } = {}) {
  const out = join(dirname(script), '..', `fake-out-${process.pid}-${Math.random()}.txt`);
  const env = { PATH: SYSTEM_PATH, FAKE_OUT: out, ...extra };
  if (key !== null) env.LITELLM_MASTER_KEY = key;
  const r = spawnSync('/bin/sh', [script], { encoding: 'utf8', env, cwd });
  const recorded = existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean) : null;
  const fields = {};
  const args = [];
  for (const line of recorded ?? []) {
    const k = line.slice(0, line.indexOf('='));
    const v = line.slice(line.indexOf('=') + 1);
    if (k === 'ARG') args.push(v);
    else fields[k] = v;
  }
  return { r, ran: recorded !== null, args, fields };
}

const listing = (d) => (existsSync(d) ? readdirSync(d).sort() : null);
const mode = (p) => statSync(p).mode & 0o777;
const baseLines = (s) => s.split('\n').filter((l) => l.startsWith('OPENAI_BASE_URL'));

/** A copy of the package at `dest`, optionally without the gateway sources. */
function copyPackage(dest, { integrations = true } = {}) {
  mkdirSync(dest, { recursive: true });
  for (const d of ['bin', 'src', 'prices', 'policies'])
    cpSync(join(ROOT, d), join(dest, d), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(dest, 'package.json'));
  if (integrations)
    for (const f of ['sakk_gateway.py', 'config.example.yaml', 'README.md'])
      cpSync(join(SHIPPED, f), join(dest, 'integrations', 'litellm', f));
  return join(dest, 'bin', 'sakk.mjs');
}

describe('sakk gateway init', () => {
  test('writes the gateway files with their modes and prints the one line to change', () => {
    const w = world();
    w.initLedger();
    const r = w.run(['gateway', 'init', '--port', '4100']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(listing(w.gwDir), ['config.yaml', 'sakk_gateway.py', 'start.sh']);
    assert.equal(mode(w.gwDir), 0o700, 'the folder is private');
    assert.equal(mode(join(w.gwDir, 'sakk_gateway.py')), 0o600);
    assert.equal(mode(join(w.gwDir, 'config.yaml')), 0o600);
    assert.equal(mode(join(w.gwDir, 'start.sh')), 0o700);
    assert.equal(
      readFileSync(join(w.gwDir, 'sakk_gateway.py'), 'utf8'),
      readFileSync(join(SHIPPED, 'sakk_gateway.py'), 'utf8'),
      'the callback is the shipped one, unchanged',
    );
    const config = readFileSync(join(w.gwDir, 'config.yaml'), 'utf8');
    assert.match(config, /^# Written by sakk gateway init \(sakk \d+\.\d+\.\d+/);
    assert.ok(config.endsWith(readFileSync(join(SHIPPED, 'config.example.yaml'), 'utf8')));
    // the one line, exactly, on a line of its own
    assert.deepEqual(baseLines(r.stdout), ['OPENAI_BASE_URL=http://127.0.0.1:4100/v1']);
    assert.match(r.stdout, /its version was not checked/, 'the output does not claim a version');
    // acting on it: the script starts litellm on the port the line names
    const s = startScript(join(w.gwDir, 'start.sh'), { cwd: w.base });
    assert.equal(s.r.status, 0, s.r.stderr);
    assert.deepEqual(s.args, [
      '--config',
      join(w.gwDir, 'config.yaml'),
      '--host',
      '127.0.0.1',
      '--port',
      '4100',
    ]);
    assert.equal(s.fields.SELF, join(w.fakeBin, 'litellm'), 'litellm found on PATH, by full path');
    assert.equal(s.fields.COST_MAP, 'True', 'no cost-map fetch at start');
    // the default port, and the default folder under SAKK_HOME
    const other = join(w.root, 'second gw');
    const d = w.run(['gateway', 'init', '--dir', other]);
    assert.equal(d.status, 0, d.stderr);
    assert.deepEqual(baseLines(d.stdout), ['OPENAI_BASE_URL=http://127.0.0.1:4000/v1']);
    assert.match(readFileSync(join(other, 'start.sh'), 'utf8'), / --port 4000\n/);
  });

  test('the start script keeps paths with spaces and quotes as one argument, all absolute', () => {
    const w = world();
    w.initLedger();
    // relative --dir and --litellm, resolved against the working directory now
    const r = w.run(['gateway', 'init', '--dir', "./gw out's", '--litellm', './fake bin/litellm']);
    assert.equal(r.status, 0, r.stderr);
    const dir = join(w.root, "gw out's");
    const script = join(dir, 'start.sh');
    // run from somewhere else: the meaning must not depend on the cwd
    const s = startScript(script, { cwd: w.base });
    assert.equal(s.r.status, 0, s.r.stderr);
    assert.equal(s.fields.SELF, join(w.fakeBin, 'litellm'));
    assert.equal(s.fields.SAKK_BIN, realpathSync(CLI));
    assert.equal(s.fields.SAKK_LEDGER, w.ledger);
    assert.equal(s.fields.SAKK_GATEWAY_CONFIG, join(dir, 'config.yaml'));
    assert.equal(s.fields.SAKK_NODE, process.execPath, 'the node that ran init, not one on PATH');
    assert.equal(s.args[1], join(dir, 'config.yaml'), 'the config path is one argument');
    for (const k of ['SELF', 'SAKK_BIN', 'SAKK_LEDGER', 'SAKK_GATEWAY_CONFIG', 'SAKK_NODE'])
      assert.ok(isAbsolute(s.fields[k]), `${k} is absolute: ${s.fields[k]}`);
    // control: without the key the script refuses before litellm runs
    const nokey = startScript(script, { cwd: w.base, key: null });
    assert.notEqual(nokey.r.status, 0);
    assert.match(nokey.r.stderr, /LITELLM_MASTER_KEY/);
    assert.equal(nokey.ran, false, 'litellm was not started without a key');
    // a ledger that went away: the script says so and does not start litellm
    rmSync(w.ledger);
    const stale = startScript(script, { cwd: w.base });
    assert.equal(stale.r.status, 1);
    assert.match(stale.r.stderr, /^sakk: GATEWAY_STALE: /m);
    assert.equal(stale.ran, false, 'litellm was not started on a gone ledger');
  });

  test('no litellm on PATH: refuses, prints the pinned recipe, writes nothing', () => {
    const w = world();
    w.initLedger();
    for (const d of SYSTEM_PATH.split(':'))
      assert.ok(!existsSync(join(d, 'litellm')), `precondition: no litellm in ${d}`);
    // a relative PATH entry is skipped: it names a different file from every cwd
    const r = w.run(['gateway', 'init'], { env: { PATH: `fake bin${delimiter}${SYSTEM_PATH}` } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^GATEWAY_LITELLM_NOT_FOUND: no executable named litellm on PATH/);
    assert.equal(listing(w.gwDir), null, 'nothing was written');
    // the recipe printed is the one the shipped README documents, line for line
    const readme = readFileSync(join(SHIPPED, 'README.md'), 'utf8').split('\n');
    const uv = r.stderr.split('\n').filter((l) => l.startsWith('  uv '));
    assert.equal(uv.length, 3, r.stderr);
    for (const l of uv) assert.ok(readme.includes(l.trim()), `README has: ${l.trim()}`);
    assert.match(r.stderr, /--generate-hashes/);
    assert.match(r.stderr, /--require-hashes/);
    assert.ok(r.stderr.includes("printf 'litellm[proxy]==1.106.2\\n' > req.in"));
    assert.ok(readme.join('\n').includes('`litellm[proxy]==1.106.2`'));
    assert.match(r.stderr, /Do not install LiteLLM 1\.82\.7, 1\.82\.8 or 1\.107\.0/);
    // --litellm naming a file that is not executable, or a folder: refused the same way
    const plain = join(w.root, 'litellm-not-exec');
    writeFileSync(plain, '#!/bin/sh\n', { mode: 0o644 });
    for (const p of [plain, w.fakeBin]) {
      const g = w.run(['gateway', 'init', '--litellm', p], { env: { PATH: SYSTEM_PATH } });
      assert.equal(g.status, 1, p);
      assert.match(g.stderr, /^GATEWAY_LITELLM_NOT_FOUND: .* is not an executable file/);
      assert.equal(listing(w.gwDir), null, `nothing was written for ${p}`);
    }
    // the fix the message names works
    assert.equal(w.run(['gateway', 'init']).status, 0);
  });

  test('a ledger that cannot be read refuses before anything is written', () => {
    const w = world();
    const r = w.run(['gateway', 'init']);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^GATEWAY_LEDGER_UNREADABLE: .*sakk init --cap <usd>.*nothing was written/,
    );
    assert.equal(listing(w.gwDir), null);
    const corrupt = join(w.root, 'corrupt.json');
    writeFileSync(corrupt, '{ not json');
    const c = w.run(['gateway', 'init', '--ledger', corrupt]);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /^GATEWAY_LEDGER_UNREADABLE: /);
    assert.equal(listing(w.gwDir), null);
    // a ledger made as the message says: init then succeeds
    w.initLedger();
    assert.equal(w.run(['gateway', 'init']).status, 0);
  });

  test('existing files are refused, and --force replaces them', () => {
    const w = world();
    w.initLedger();
    assert.equal(w.run(['gateway', 'init']).status, 0);
    const script = join(w.gwDir, 'start.sh');
    writeFileSync(script, 'tampered\n');
    rmSync(join(w.gwDir, 'sakk_gateway.py'));
    const r = w.run(['gateway', 'init', '--port', '4200']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^GATEWAY_FILES_EXIST: .*start\.sh.* --force .*nothing was written/);
    assert.equal(readFileSync(script, 'utf8'), 'tampered\n', 'start.sh was replaced');
    assert.deepEqual(
      listing(w.gwDir),
      ['config.yaml', 'start.sh'],
      'the missing file stays missing',
    );
    const f = w.run(['gateway', 'init', '--port', '4200', '--force']);
    assert.equal(f.status, 0, f.stderr);
    assert.match(f.stdout, /^replaced the gateway files in /);
    assert.match(readFileSync(script, 'utf8'), / --port 4200\n$/);
    assert.equal(mode(script), 0o700);
    assert.deepEqual(
      listing(w.gwDir),
      ['config.yaml', 'sakk_gateway.py', 'start.sh'],
      'no temp file left',
    );
    // a planted symlink is refused, then replaced as a link, never written through
    const dir = join(w.root, 'planted');
    mkdirSync(dir);
    const victim = join(w.root, 'victim.txt');
    writeFileSync(victim, 'keep\n');
    symlinkSync(victim, join(dir, 'start.sh'));
    const p = w.run(['gateway', 'init', '--dir', dir]);
    assert.equal(p.status, 1);
    assert.match(p.stderr, /^GATEWAY_FILES_EXIST: /);
    assert.deepEqual(listing(dir), ['start.sh']);
    assert.equal(w.run(['gateway', 'init', '--dir', dir, '--force']).status, 0);
    assert.ok(lstatSync(join(dir, 'start.sh')).isFile(), 'the link itself was replaced');
    assert.equal(readFileSync(victim, 'utf8'), 'keep\n', 'the link target is untouched');
  });

  test('the written files hold no secret value', () => {
    const w = world();
    w.initLedger();
    // keys in the environment of the person running init must not be copied in
    const fake = `sk-${'q7'.repeat(24)}`;
    const r = w.run(['gateway', 'init'], {
      env: { DEEPSEEK_API_KEY: fake, LITELLM_MASTER_KEY: fake, ANTHROPIC_API_KEY: fake },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(fake) && !r.stderr.includes(fake), 'no key printed');
    for (const f of readdirSync(w.gwDir))
      assert.ok(!readFileSync(join(w.gwDir, f), 'utf8').includes(fake), `${f} holds no key`);
    const scan = scanPaths([w.gwDir]);
    assert.ok(scan.scanned >= 3, `the scan read the files (${scan.scanned})`);
    assert.deepEqual(scan.findings, []);
    assert.deepEqual(scan.unreadable, []);
    const config = readFileSync(join(w.gwDir, 'config.yaml'), 'utf8');
    const keyLines = config.split('\n').filter((l) => /^\s*(api_key|master_key):/.test(l));
    assert.ok(keyLines.length >= 2, 'the config names its keys');
    for (const l of keyLines) assert.match(l, /:\s*os\.environ\/[A-Z_]+\s*$/, l);
  });

  test('refuses what it does not understand, and each refusal writes nothing', () => {
    const w = world();
    w.initLedger();
    for (const [args, code] of [
      [['gateway'], 'GATEWAY_USAGE'],
      [['gateway', 'start'], 'GATEWAY_USAGE'],
      [['gateway', 'init', 'extra'], 'GATEWAY_USAGE'],
      [['gateway', 'init', '--port', '80'], 'GATEWAY_PORT_INVALID'],
      [['gateway', 'init', '--port', '70000'], 'GATEWAY_PORT_INVALID'],
      [['gateway', 'init', '--port', '4000.5'], 'GATEWAY_PORT_INVALID'],
      [['gateway', 'init', '--port', 'abc'], 'GATEWAY_PORT_INVALID'],
      [['gateway', 'init', '--bogus'], 'USAGE_UNKNOWN_ARGUMENT'],
    ]) {
      const r = w.run(args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`^${code}: `), args.join(' '));
      assert.equal(listing(w.gwDir), null, `${args.join(' ')} wrote nothing`);
    }
    // from an npx cache: the start script would pin a path the cleaner removes
    const npx = copyPackage(join(w.base, '_npx', 'abcdef12', 'node_modules', 'sakk'));
    const e = w.run(['gateway', 'init'], { cli: npx });
    assert.equal(e.status, 2, e.stderr);
    assert.match(e.stderr, /^GATEWAY_EPHEMERAL: .*npm install -g sakk/);
    assert.equal(listing(w.gwDir), null);
    // an install that lost the gateway sources
    const bare = copyPackage(join(w.base, 'bare', 'sakk'), { integrations: false });
    const m = w.run(['gateway', 'init'], { cli: bare });
    assert.equal(m.status, 1, m.stderr);
    assert.match(m.stderr, /^GATEWAY_SOURCE_MISSING: .*sakk_gateway\.py/);
    assert.equal(listing(w.gwDir), null);
    // a folder that cannot be made (a file is in the way)
    const file = join(w.root, 'a file');
    writeFileSync(file, 'x');
    const nd = w.run(['gateway', 'init', '--dir', join(file, 'gw')]);
    assert.equal(nd.status, 1);
    assert.match(nd.stderr, /^GATEWAY_WRITE_FAILED: /);
    // a write that fails part-way removes what this run created
    const half = join(w.root, 'half');
    mkdirSync(join(half, 'start.sh'), { recursive: true });
    writeFileSync(join(half, 'start.sh', 'inside'), 'x');
    const h = w.run(['gateway', 'init', '--dir', half, '--force']);
    assert.equal(h.status, 1, h.stderr);
    assert.match(h.stderr, /^GATEWAY_WRITE_FAILED: .*removed/);
    assert.deepEqual(listing(half), ['start.sh'], 'created files and the temp file were removed');
  });

  test('the docs show the gateway door, the line to change and the outage behavior', () => {
    const docs = ['README.md', 'README.zh-CN.md', 'docs/FAQ.md', 'docs/FAQ.zh-CN.md', 'llms.txt'];
    for (const f of docs) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      for (const need of [
        'sakk gateway init',
        'OPENAI_BASE_URL=http://127.0.0.1:4000/v1',
        'x-sakk-status: unmetered',
        'SAKK_ON_UNAVAILABLE=deny',
        '402',
        '403',
        'integrations/litellm/README.md',
      ])
        assert.ok(text.includes(need), `${f} says ${need}`);
      // the gateway is not called fail-closed: a paragraph naming both explains the difference
      for (const para of text.split(/\n\s*\n/))
        if (/gateway|网关/i.test(para) && /fail[- ]closed|fails closed|失败即拒/i.test(para))
          assert.match(para, /unmetered|不计量|不记账/, `${f}: ${para.slice(0, 120)}`);
    }
    // the README's snippets are the three clients the door promises
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /base_url=["']http:\/\/127\.0\.0\.1:4000\/v1["']/, 'Python');
    assert.match(readme, /baseURL: ["']http:\/\/127\.0\.0\.1:4000\/v1["']/, 'Node');
    assert.match(readme, /curl -s http:\/\/127\.0\.0\.1:4000\/v1\/chat\/completions/, 'curl');
  });
});
