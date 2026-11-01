// SPDX-License-Identifier: AGPL-3.0-only
//
// Optional username + password sign-in for `sakk ui` (the maintainer, 2026-11-01). Every
// test drives the real console over real HTTP on loopback with a fake HOME,
// the shipped scrypt parameters and an injected clock; the command-line
// refusals spawn the real bin/sakk.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { scryptSync, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { URLSearchParams, fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers';
import { startConsole } from '../src/console.mjs';
import { initLedger } from '../src/ledger.mjs';

// a dynamic import, so on the code before this feature each test fails on its
// own assertion (the module is missing) instead of the whole file failing to load
const L = await import('../src/console-login.mjs').catch(() => ({}));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'sakk.mjs');
const USER = 'console-owner';
const PASS = 'correct horse battery staple 42';
const WRONG = 'incorrect mule battery stapler 7';

/** An isolated HOME (the real ~/.sakk and ~/.claude are never read). */
function world({ ledger = false } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'console-login-')));
  const home = join(base, '.sakk');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(base, 'emptylogs'), { recursive: true });
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ claudeLogDir: join(base, 'emptylogs') }),
  );
  const env = {
    ...process.env,
    HOME: base,
    SAKK_HOME: home,
    CLAUDE_CONFIG_DIR: join(base, 'noclaude'),
  };
  delete env.SAKK_LEDGER_PATH;
  let ledgerPath = null;
  if (ledger) {
    ledgerPath = join(base, 'ledger.json');
    initLedger({ ledgerPath, capUsd: 100 });
  }
  return { base, home, env, cwd: base, ledgerPath };
}

async function setPassword(w, username = USER, password = PASS) {
  assert.equal(
    typeof L.setConsoleLogin,
    'function',
    'src/console-login.mjs exports setConsoleLogin',
  );
  return L.setConsoleLogin({ home: w.home, username, password });
}

/** A console with an injected clock and a captured log. */
async function start(w, opts = {}) {
  const clock = { t: 1_800_000_000_000 };
  const lines = [];
  const c = await startConsole({
    port: 0,
    home: w.home,
    cwd: w.cwd,
    env: w.env,
    ledgerPath: w.ledgerPath,
    now: () => clock.t,
    log: (line) => lines.push(line),
    ...opts,
  });
  return { c, clock, lines };
}

/** Raw HTTP so Host, Origin, Cookie and the body can all be controlled. */
function hit(port, { path = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (b) => (data += b));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const local = (c) => ({ Host: `127.0.0.1:${c.port}`, Origin: `http://127.0.0.1:${c.port}` });
const hostOnly = (c) => ({ Host: `127.0.0.1:${c.port}` });
const signIn = (c, username, password, headers = local(c)) =>
  hit(c.port, {
    path: '/login',
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
const setCookies = (r) => [r.headers['set-cookie'] ?? []].flat();
const sessionOf = (r) => {
  const m = setCookies(r)
    .map((s) => s.match(/^sakk_s=([0-9a-f]{32});/))
    .find(Boolean);
  return m ? m[1] : null;
};
const withSession = (c, sid) => ({ ...hostOnly(c), Cookie: `sakk_s=${sid}` });

test('the right username and password open a session cookie that is HttpOnly and SameSite=Strict', async () => {
  const w = world();
  await setPassword(w);
  const { c } = await start(w);
  try {
    // the sign-in page: a GET that writes nothing and sets no cookie
    const page = await hit(c.port, { headers: hostOnly(c) });
    assert.equal(page.status, 200);
    assert.equal(page.headers['set-cookie'], undefined, 'the sign-in page sets no cookie');
    assert.match(page.body, /id="signin" method="post" action="\/login"/);
    assert.match(page.body, /type="password" autocomplete="current-password"/);
    const nonce = page.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
    assert.ok(page.body.includes(`<script nonce="${nonce}">`), 'the script carries the CSP nonce');
    assert.ok(!page.body.includes('innerHTML'), 'the sign-in page never writes innerHTML');
    assert.ok(!/https?:\/\//.test(page.body), 'the sign-in page names no absolute URL');

    const r = await signIn(c, USER, PASS);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { signedIn: true });
    const [cookie] = setCookies(r);
    assert.match(cookie, /^sakk_s=[0-9a-f]{32}; Path=\/; SameSite=Strict; HttpOnly$/);
    const sid = sessionOf(r);

    // the session opens the console and its API, and never promotes a start token
    const home = await hit(c.port, { headers: withSession(c, sid) });
    assert.equal(home.status, 200);
    assert.ok(home.body.includes('const SIGN_IN=true'), 'the console offers Sign out');
    assert.equal(home.headers['set-cookie'], undefined);
    assert.equal(
      (await hit(c.port, { path: '/api/overview', headers: withSession(c, sid) })).status,
      200,
    );

    // a form body works the same as JSON
    const form = await hit(c.port, {
      path: '/login',
      method: 'POST',
      headers: { ...local(c), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: USER, password: PASS }).toString(),
    });
    assert.equal(form.status, 200, form.body);
    assert.notEqual(sessionOf(form), sid, 'each sign-in gets a fresh session id');

    // sign out ends the session and clears both cookies
    const out = await hit(c.port, {
      path: '/logout',
      method: 'POST',
      headers: { ...local(c), Cookie: `sakk_s=${sid}` },
    });
    assert.equal(out.status, 200);
    assert.ok(setCookies(out).some((s) => /^sakk_s=;.*Max-Age=0/.test(s)));
    assert.ok(setCookies(out).some((s) => /^sakk_t=;.*Max-Age=0/.test(s)));
    assert.equal(
      (await hit(c.port, { path: '/api/overview', headers: withSession(c, sid) })).status,
      403,
    );
  } finally {
    await c.close();
  }
});

test('a wrong password and a wrong username get the same refusal and no cookie', async () => {
  const w = world();
  await setPassword(w);
  const { c } = await start(w);
  try {
    const badPass = await signIn(c, USER, WRONG);
    const badUser = await signIn(c, 'someone-else', PASS);
    assert.equal(badPass.status, 401);
    assert.equal(badUser.status, 401);
    assert.equal(badPass.body, badUser.body, 'one refusal for either mistake');
    assert.deepEqual(JSON.parse(badPass.body), {
      error: 'CONSOLE_LOGIN_FAILED',
      message: 'Wrong username or password.',
    });
    assert.equal(badPass.headers['set-cookie'], undefined);
    assert.equal(badUser.headers['set-cookie'], undefined);
    // the control: the right pair on the same console signs in
    assert.equal((await signIn(c, USER, PASS)).status, 200);

    // malformed requests are refused before any check runs
    const post = (headers, body) => hit(c.port, { path: '/login', method: 'POST', headers, body });
    const json = { ...local(c), 'Content-Type': 'application/json' };
    assert.equal((await post(json, JSON.stringify({ username: USER }))).status, 400);
    assert.equal((await post(json, JSON.stringify({ username: USER, password: 5 }))).status, 400);
    assert.equal((await post(json, 'not json')).status, 400);
    assert.equal((await post({ ...local(c), 'Content-Type': 'text/plain' }, 'x')).status, 415);
    assert.equal((await post(local(c), 'x')).status, 415, 'no Content-Type is refused too');
    const over = 'x'.repeat(3000);
    const big = await post({ ...json, 'Content-Length': String(over.length) }, over);
    assert.equal(big.status, 413, 'a declared length over the cap is refused unread');
    // a chunked body with no length is cut off once it passes the cap
    await assert.rejects(post(json, over));
    assert.equal(c.login.failures, 2, 'only the two real attempts counted as failures');
  } finally {
    await c.close();
  }
});

test('five failed sign-ins lock sign-in out with a clear message, while the token link still works', async () => {
  const w = world();
  await setPassword(w);
  const { c, clock, lines } = await start(w);
  try {
    for (let i = 0; i < L.LOGIN_MAX_FAILURES; i += 1) {
      assert.equal((await signIn(c, USER, `${WRONG} ${i}`)).status, 401);
      clock.t += 1000;
    }
    // the right password during the lock is still refused: this observes the lock
    const locked = await signIn(c, USER, PASS);
    assert.equal(locked.status, 429);
    const body = JSON.parse(locked.body);
    assert.equal(body.error, 'CONSOLE_LOGIN_LOCKED');
    assert.match(body.message, /Too many failed sign-ins\. Try again in \d+ min/);
    assert.match(body.message, /open the address sakk ui printed/);
    const retry = Number(locked.headers['retry-after']);
    assert.ok(retry > 0 && retry <= L.LOGIN_WINDOW_MS / 1000, `Retry-After ${retry}`);
    assert.equal(locked.headers['set-cookie'], undefined);

    // the owner is never locked out: the start token link opens the console
    const viaToken = await hit(c.port, { path: `/?t=${c.token}`, headers: hostOnly(c) });
    assert.equal(viaToken.status, 200);
    assert.ok(setCookies(viaToken).some((s) => s.startsWith('sakk_t=')));

    // the lock lifts when the window has passed
    clock.t += L.LOGIN_WINDOW_MS;
    assert.equal((await signIn(c, USER, PASS)).status, 200);

    // failures are logged, never with the password or the username
    assert.equal(lines.filter((l) => l.startsWith('sign-in failed')).length, 5);
    assert.ok(lines.some((l) => l.startsWith('sign-in refused: locked')));
    for (const l of lines) {
      assert.ok(!l.includes(PASS) && !l.includes(WRONG) && !l.includes(USER), l);
    }
  } finally {
    await c.close();
  }
  // one scrypt at a time, and at most 16 sessions in memory (a stub verifier,
  // so the count is exact and the test does not wait on scrypt)
  let release;
  const slow = createGateWith(() => new Promise((r) => (release = r)));
  const first = slow.signIn(USER, PASS);
  assert.deepEqual(await slow.signIn(USER, PASS), { busy: true });
  release(true);
  assert.equal((await first).ok, true);
  const quick = createGateWith(async () => true);
  const ids = [];
  for (let i = 0; i < 20; i += 1) ids.push((await quick.signIn(USER, PASS)).id);
  assert.equal(quick.sessions, 16);
  assert.equal(quick.sessionOk(ids[0]), false, 'the oldest session was dropped');
  assert.equal(quick.sessionOk(ids[19]), true);
});

function createGateWith(verify) {
  assert.equal(typeof L.createLoginGate, 'function');
  return L.createLoginGate({ rec: { username: USER }, verify });
}

test('with a password set every API route still needs the token or a session', async () => {
  const src = readFileSync(join(ROOT, 'src', 'console.mjs'), 'utf8');
  const routes = [...new Set([...src.matchAll(/name === '([a-z]+)'/g)].map((m) => m[1]))];
  assert.ok(routes.length >= 8, `found ${routes.length} API routes — pattern drifted?`);
  const w = world({ ledger: true });
  await setPassword(w);
  const { c } = await start(w, { allowHalt: true });
  try {
    const sid = sessionOf(await signIn(c, USER, PASS));
    assert.ok(sid);
    const forged = randomBytes(16).toString('hex');
    for (const name of routes) {
      const path = `/api/${name}`;
      assert.equal((await hit(c.port, { path, headers: hostOnly(c) })).status, 403, path);
      assert.equal(
        (await hit(c.port, { path, headers: withSession(c, forged) })).status,
        403,
        path,
      );
      assert.notEqual(
        (await hit(c.port, { path, headers: withSession(c, sid) })).status,
        403,
        path,
      );
    }
    const halt = await hit(c.port, {
      path: '/api/halt',
      method: 'POST',
      headers: local(c),
      body: '{}',
    });
    assert.equal(halt.status, 403);
  } finally {
    await c.close();
  }
});

test('sign-in refuses a foreign Origin, a missing Origin and a foreign Host', async () => {
  const w = world();
  await setPassword(w);
  const { c } = await start(w);
  try {
    const host = `127.0.0.1:${c.port}`;
    const cases = [
      { Host: host, Origin: 'http://evil.example' },
      { Host: host }, // a form POST under no-referrer sends no usable Origin
      { Host: host, Origin: 'null' },
      { Host: `evil.example:${c.port}`, Origin: `http://evil.example:${c.port}` }, // rebinding
      { Host: `evil.example:${c.port}`, Origin: `http://${host}` },
    ];
    for (const headers of cases) {
      const r = await signIn(c, USER, PASS, headers);
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.equal(r.headers['set-cookie'], undefined);
    }
    assert.equal(c.login.failures, 0, 'a refused request never reaches the password check');

    // a GET never signs in, even with the fields in the query
    const q = new URLSearchParams({ username: USER, password: PASS });
    const get = await hit(c.port, { path: `/login?${q}`, headers: hostOnly(c) });
    assert.equal(get.status, 403);
    assert.equal(get.headers['set-cookie'], undefined);

    // sign-out is a write too: a foreign Origin cannot end a session
    const sid = sessionOf(await signIn(c, USER, PASS));
    const out = await hit(c.port, {
      path: '/logout',
      method: 'POST',
      headers: { Host: host, Origin: 'http://evil.example', Cookie: `sakk_s=${sid}` },
    });
    assert.equal(out.status, 403);
    assert.equal(
      (await hit(c.port, { path: '/api/overview', headers: withSession(c, sid) })).status,
      200,
    );
  } finally {
    await c.close();
  }
});

test('a credential file that is a symlink, a hard link or readable by others stops the console from starting', async () => {
  const w = world();
  const { path } = await setPassword(w);
  // a console that starts anyway is closed before failing, so a regression is
  // a red test and never a test run that hangs on an open server
  const refused = async (code) => {
    let c;
    try {
      c = await startConsole({ port: 0, home: w.home, cwd: w.cwd, env: w.env });
    } catch (e) {
      assert.equal(e.code, code, e.message);
      return;
    }
    await c.close();
    assert.fail(`the console started on an unsafe credential file (want ${code})`);
  };
  const good = readFileSync(path, 'utf8');

  chmodSync(path, 0o644);
  await refused('CONSOLE_LOGIN_UNSAFE');
  // the real entry point refuses too, with exit 2 and the next step
  const cli = spawnSync(process.execPath, [BIN, 'ui'], {
    env: w.env,
    cwd: w.base,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(cli.status, 2, `${cli.stdout}${cli.stderr}`);
  assert.match(cli.stderr, /CONSOLE_LOGIN_UNSAFE: .* sakk ui --clear-password/);
  assert.ok(!cli.stdout.includes('Sakk console:'), 'the console did not start');
  chmodSync(path, 0o600);

  const other = join(w.base, 'second-name.json');
  linkSync(path, other);
  await refused('CONSOLE_LOGIN_UNSAFE');
  unlinkSync(other);

  const real = join(w.base, 'elsewhere.json');
  renameSync(path, real);
  symlinkSync(real, path);
  await refused('CONSOLE_LOGIN_UNSAFE');
  unlinkSync(path);

  writeFileSync(path, ' '.repeat(5000) + good, { mode: 0o600 });
  await refused('CONSOLE_LOGIN_UNSAFE'); // over the 4 KiB cap: not read
  writeFileSync(path, '{}\n', { mode: 0o600 });
  await refused('CONSOLE_LOGIN_INVALID');
  const weak = JSON.parse(good);
  weak.params.N = 1024; // a downgraded cost is not accepted
  writeFileSync(path, JSON.stringify(weak), { mode: 0o600 });
  await refused('CONSOLE_LOGIN_INVALID');

  // a home that is not a folder: the file cannot even be looked up
  const notDir = join(w.base, 'not-a-folder');
  writeFileSync(notDir, 'x');
  assert.throws(() => L.loadConsoleLogin({ home: notDir }), { code: 'CONSOLE_LOGIN_UNREADABLE' });

  // the way out the message names: clear it, and the console is token-only again
  assert.equal(L.clearConsoleLogin({ home: w.home }).removed, true);
  const { c } = await start(w);
  try {
    assert.equal(c.login, null);
  } finally {
    await c.close();
  }
});

test('a password session cannot stop an agent without the start token', async () => {
  const w = world({ ledger: true });
  await setPassword(w);
  const { c } = await start(w, { allowHalt: true });
  try {
    const sid = sessionOf(await signIn(c, USER, PASS));
    assert.ok(sid);
    const halt = (extra) =>
      hit(c.port, {
        path: '/api/halt',
        method: 'POST',
        headers: {
          ...local(c),
          Cookie: `sakk_s=${sid}`,
          'Content-Type': 'application/json',
          ...extra,
        },
        body: '{}',
      });
    assert.equal((await halt({})).status, 403, 'a session alone cannot stop');
    assert.equal((await halt({ 'X-Sakk-Token': 'f'.repeat(32) })).status, 403);
    assert.equal(JSON.parse(readFileSync(w.ledgerPath, 'utf8')).halt, undefined, 'nothing halted');
    // with the start token the stop works, and it is still labelled self-declared
    const ok = await halt({ 'X-Sakk-Token': c.token });
    assert.equal(ok.status, 200, ok.body);
    const r = JSON.parse(ok.body);
    assert.equal(r.halted, true);
    assert.match(r.note, /self-declared/);
    assert.notEqual(r.by, USER, 'the sign-in name is never recorded as the approver');
  } finally {
    await c.close();
  }
});

test('with no password set the console is unchanged: no token is 403 and /login is 404', async () => {
  const w = world();
  const { c } = await start(w);
  try {
    assert.equal(c.login, null, 'no credential file, no sign-in');
    const tok = { ...local(c), Cookie: `sakk_t=${c.token}` };
    assert.equal((await hit(c.port, { headers: hostOnly(c) })).status, 403);
    assert.equal(
      (await hit(c.port, { path: '/login', method: 'POST', headers: local(c) })).status,
      403,
    );
    assert.equal((await hit(c.port, { path: '/login', method: 'POST', headers: tok })).status, 404);
    assert.equal(
      (await hit(c.port, { path: '/logout', method: 'POST', headers: tok })).status,
      404,
    );
    assert.equal((await hit(c.port, { path: '/login', headers: tok })).status, 404);
    const page = await hit(c.port, { path: `/?t=${c.token}`, headers: hostOnly(c) });
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('const SIGN_IN=false'), 'no Sign out without a password');
    assert.ok(!page.body.includes('id="signin"'));
    assert.equal(existsSync(join(w.home, 'console-login.json')), false, 'starting writes nothing');
  } finally {
    await c.close();
  }
});

test('a session ends after the idle limit and after the absolute limit', async () => {
  const w = world();
  await setPassword(w);
  const { c, clock } = await start(w);
  assert.equal(L.SESSION_IDLE_MS, 30 * 60 * 1000);
  assert.equal(L.SESSION_MAX_MS, 8 * 60 * 60 * 1000);
  const api = (sid) => hit(c.port, { path: '/api/overview', headers: withSession(c, sid) });
  try {
    // idle: one minute short of the limit is fine, the limit itself is not
    const idle = sessionOf(await signIn(c, USER, PASS));
    clock.t += L.SESSION_IDLE_MS - 60_000;
    assert.equal((await api(idle)).status, 200);
    clock.t += L.SESSION_IDLE_MS;
    assert.equal((await api(idle)).status, 403);

    // absolute: a session kept busy still ends after eight hours
    const busy = sessionOf(await signIn(c, USER, PASS));
    const born = clock.t;
    while (clock.t + 20 * 60_000 < born + L.SESSION_MAX_MS) {
      clock.t += 20 * 60_000;
      assert.equal((await api(busy)).status, 200);
    }
    clock.t = born + L.SESSION_MAX_MS;
    assert.equal((await api(busy)).status, 403);
    assert.equal(c.login.sessions, 0, 'expired sessions are dropped from memory');
  } finally {
    await c.close();
  }
});

test('a session cookie the server did not issue is refused', async () => {
  const w = world();
  await setPassword(w);
  const a = await start(w);
  const b = await start(w);
  try {
    const api = (c, sid) => hit(c.port, { path: '/api/overview', headers: withSession(c, sid) });
    assert.equal((await api(a.c, randomBytes(16).toString('hex'))).status, 403);
    assert.equal((await api(a.c, a.c.token)).status, 403, 'the start token is not a session id');
    assert.equal((await api(a.c, 'x'.repeat(4000))).status, 403);
    // a session from another console run is not one of ours
    const other = sessionOf(await signIn(b.c, USER, PASS));
    assert.equal((await api(b.c, other)).status, 200);
    assert.equal((await api(a.c, other)).status, 403);
    // fixation: a cookie planted before sign-in is replaced, never adopted
    const planted = randomBytes(16).toString('hex');
    const r = await signIn(a.c, USER, PASS, { ...local(a.c), Cookie: `sakk_s=${planted}` });
    assert.equal(r.status, 200);
    assert.notEqual(sessionOf(r), planted);
    assert.equal((await api(a.c, planted)).status, 403);
    assert.equal((await api(a.c, sessionOf(r))).status, 200);
  } finally {
    await a.c.close();
    await b.c.close();
  }
});

test('the credential file is mode 0600 and holds a scrypt hash, never the password', async () => {
  const w = world();
  const fresh = { ...w, home: join(w.base, 'new-home') };
  const old = process.umask(0); // the mode is set explicitly, not left to the umask
  let path;
  try {
    ({ path } = await setPassword(fresh));
  } finally {
    process.umask(old);
  }
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(fresh.home).mode & 0o777, 0o700, 'a new Sakk home is owner-only');
  const text = readFileSync(path, 'utf8');
  assert.ok(!text.includes(PASS), 'the password is not in the file');
  const rec = JSON.parse(text);
  assert.equal(rec.v, 1);
  assert.equal(rec.username, USER);
  assert.match(rec.salt, /^[0-9a-f]{32}$/, '16-byte salt');
  assert.deepEqual(rec.params, { N: 2 ** 17, r: 8, p: 1, keylen: 64 });
  const key = scryptSync(PASS.normalize('NFKC'), Buffer.from(rec.salt, 'hex'), 64, {
    N: rec.params.N,
    r: rec.params.r,
    p: rec.params.p,
    maxmem: 256 * 1024 * 1024,
  });
  assert.equal(rec.hash, key.toString('hex'), 'the hash is scrypt over the password and salt');
  // setting it again draws a new salt
  await setPassword(fresh);
  assert.notEqual(JSON.parse(readFileSync(path, 'utf8')).salt, rec.salt);
  // short passwords and odd usernames are refused before anything is written
  assert.throws(() => L.checkPassword('fourteen chars'), { code: 'UI_PASSWORD_INVALID' });
  assert.equal(L.checkPassword('fifteen chars!!'), 'fifteen chars!!');
  assert.throws(() => L.checkUsername(' padded'), { code: 'UI_USERNAME_INVALID' });
  assert.throws(() => L.checkUsername('a\u0007b'), { code: 'UI_USERNAME_INVALID' });
  await assert.rejects(L.setConsoleLogin({ home: w.home, username: USER, password: 'short' }), {
    code: 'UI_PASSWORD_INVALID',
  });
  assert.equal(existsSync(join(w.home, 'console-login.json')), false);
});

test('sakk ui refuses a password on the command line and a password prompt without a terminal', async () => {
  const w = world();
  const run = (args, input) =>
    spawnSync(process.execPath, [BIN, 'ui', ...args], {
      env: w.env,
      cwd: w.base,
      encoding: 'utf8',
      input,
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
  const secret = 'Tr0ub4dor-and-three-more-words';
  for (const args of [
    [secret],
    ['--set-password', secret],
    [`--set-password=${secret}`],
    [`--${secret}`],
  ]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /USAGE_/);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(secret), `the password was echoed: ${r.stderr}`);
  }
  // a pipe is not a terminal: nothing is read or saved
  const piped = run(['--set-password'], `${USER}\n${secret}\n${secret}\n`);
  assert.equal(piped.status, 2);
  assert.match(piped.stderr, /UI_PASSWORD_NEEDS_TTY/);
  assert.ok(!`${piped.stdout}${piped.stderr}`.includes(secret));
  assert.equal(existsSync(join(w.home, 'console-login.json')), false);
  assert.equal(run(['--set-password', '--port', '0']).status, 2, 'set-password stands alone');

  // --clear-password removes it and says the console is token-only
  await setPassword(w);
  const cleared = run(['--clear-password']);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, /token-only/);
  assert.equal(existsSync(join(w.home, 'console-login.json')), false);
  assert.match(run(['--clear-password']).stdout, /No console sign-in was set/);

  // the prompt itself: raw mode, no echo, backspace, cancel, and no TTY refused
  const tty = () => {
    const input = new PassThrough();
    input.isTTY = true;
    input.raw = [];
    input.setRawMode = (on) => input.raw.push(on);
    const output = new PassThrough();
    let shown = '';
    output.on('data', (b) => (shown += b));
    return { input, output, shown: () => shown };
  };
  const t = tty();
  const got = L.promptHidden({ input: t.input, output: t.output, prompt: 'Password: ' });
  t.input.write('abcX\u007fd\r');
  assert.equal(await got, 'abcd');
  assert.deepEqual(t.input.raw, [true, false], 'raw mode on, then restored');
  assert.ok(t.shown().startsWith('Password: '));
  assert.ok(!t.shown().includes('abc'), 'typed characters are not echoed');
  const c2 = tty();
  const cancelled = L.promptHidden({ input: c2.input, output: c2.output, prompt: '> ' });
  c2.input.write('ab\u0003');
  await assert.rejects(cancelled, { code: 'UI_PASSWORD_CANCELLED' });
  await assert.rejects(L.promptHidden({ input: new PassThrough(), prompt: '> ' }), {
    code: 'UI_PASSWORD_NEEDS_TTY',
  });

  // the whole --set-password flow at a terminal: two different passwords save
  // nothing, two equal ones save the hash
  const flow = (answers, t = tty()) => {
    const queue = [...answers];
    t.output.on('data', (b) => {
      if (String(b).endsWith(': ') && queue.length) {
        const next = queue.shift();
        setImmediate(() => t.input.write(next));
      }
    });
    return L.askConsoleLogin({ home: w.home, input: t.input, output: t.output });
  };
  await assert.rejects(flow([`${USER}\n`, `${PASS}\r`, `${WRONG}\r`]), {
    code: 'UI_PASSWORD_MISMATCH',
  });
  assert.equal(existsSync(join(w.home, 'console-login.json')), false, 'a mismatch saves nothing');
  const saved = await flow([`${USER}\n`, `${PASS}\r`, `${PASS}\r`]);
  assert.equal(saved.username, USER);
  assert.equal(L.loadConsoleLogin({ home: w.home }).username, USER);
  await assert.rejects(
    L.askConsoleLogin({ home: w.home, input: new PassThrough(), output: new PassThrough() }),
    { code: 'UI_PASSWORD_NEEDS_TTY' },
  );
});
