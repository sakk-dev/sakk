import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
  symlinkSync,
  appendFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startConsole,
  tailDecisions,
  tokenOk,
  renderPage,
  overviewData,
  secretData,
  tryData,
  TAIL_BYTES,
  PAGE_LINES,
  ledgerData,
  LEDGER_VIEW_BYTES,
} from '../src/console.mjs';
import { initLedger, readLedger, reserve, settle, alertsPathFor } from '../src/ledger.mjs';
import { normalize, evaluate } from '../src/hook.mjs';
import { install } from '../src/guard-install.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A world with an isolated HOME (so the real ~/.claude logs are never read). */
function world({ decisions = [], cap = null, ledger = false } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'console-')));
  const home = join(base, '.sakk');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(base, 'emptylogs'), { recursive: true });
  const env = {
    ...process.env,
    HOME: base,
    SAKK_HOME: home,
    CLAUDE_CONFIG_DIR: join(base, 'noclaude'),
  };
  const config = { claudeLogDir: join(base, 'emptylogs') };
  if (cap !== null) config.capUsd = cap;
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  if (decisions.length)
    writeFileSync(
      join(home, 'decisions.jsonl'),
      decisions.map((d) => JSON.stringify(d)).join('\n') + '\n',
    );
  let ledgerPath = null;
  if (ledger) {
    ledgerPath = join(base, 'ledger.json');
    initLedger({ ledgerPath, capUsd: 100 });
  }
  return { base, home, env, cwd: base, ledgerPath };
}

const H = '0000000000000000000000000000000000000000000000000000000000000000';
const dec = (over = {}) => ({
  at: '2026-10-22T10:00:00.000Z',
  by: 'claude-code',
  verdict: 'allow',
  ruleId: null,
  policyHash: H,
  context: { agent: 'claude-code', action: 'shell.run', callId: 'c1', estimatedUsd: 0 },
  ...over,
});

/** Raw HTTP so Host/Origin/Cookie and a missing token can all be controlled. */
function hit(port, { path = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const cookie = (tok) => `sakk_t=${tok}`;

describe('sakk ui console (M4): security', () => {
  test('a request without the token gets nothing', async () => {
    const w = world({ decisions: [dec()] });
    const c = await startConsole({ ...w });
    try {
      for (const path of ['/', '/api/overview', '/api/records', '/api/rules', '/api/ledger']) {
        const r = await hit(c.port, { path, headers: { Host: `127.0.0.1:${c.port}` } });
        assert.equal(r.status, 403, path);
        // no CORS header is ever sent
        assert.equal(r.headers['access-control-allow-origin'], undefined, path);
      }
      // with the token it works
      const ok = await hit(c.port, {
        path: '/api/overview',
        headers: { Host: `127.0.0.1:${c.port}`, Cookie: cookie(c.token) },
      });
      assert.equal(ok.status, 200);
    } finally {
      await c.close();
    }
  });

  test('a foreign Host header is refused', async () => {
    const w = world();
    const c = await startConsole({ ...w });
    try {
      const r = await hit(c.port, {
        path: `/api/overview?t=${c.token}`,
        headers: { Host: 'evil.example' },
      });
      assert.equal(r.status, 403);
    } finally {
      await c.close();
    }
  });

  test('F-195 a cross-site Origin is refused on every route, not just the write', async () => {
    const w = world({ decisions: [dec()], ledger: true });
    const c = await startConsole({ ...w, allowHalt: true });
    try {
      const own = { Host: `127.0.0.1:${c.port}`, Cookie: cookie(c.token) };
      const foreign = { ...own, Origin: 'http://attacker.example' };
      // every GET route — plus a path outside the route table, so the gate is
      // provably before dispatch and covers routes that do not exist yet
      const paths = [
        '/',
        '/api/overview',
        '/api/records',
        '/api/rules',
        '/api/secret',
        '/api/agents',
        '/api/prices',
        '/api/ledger',
        '/api/try?cmd=ls',
        '/api/forbidden',
        '/api/not-a-route',
      ];
      for (const path of paths) {
        const r = await hit(c.port, { path, headers: foreign });
        assert.equal(r.status, 403, `${path} must refuse a cross-site Origin`);
      }
      // the write too, even with a valid token header
      const haltR = await hit(c.port, {
        path: '/api/halt',
        method: 'POST',
        headers: { ...foreign, 'Content-Type': 'application/json', 'X-Sakk-Token': c.token },
        body: '{}',
      });
      assert.equal(haltR.status, 403, 'halt must refuse a cross-site Origin');
      // our own Origin, and an absent Origin (typed URL / curl), still read
      for (const headers of [{ ...own, Origin: `http://127.0.0.1:${c.port}` }, own]) {
        const ok = await hit(c.port, { path: '/api/overview', headers });
        assert.equal(ok.status, 200);
      }
      // every response — page, JSON and refusal alike — is no-store, and a
      // non-HTML response's CSP carries no empty-nonce allowance
      for (const path of ['/', '/api/overview', '/api/not-a-route']) {
        const r = await hit(c.port, { path, headers: own });
        assert.equal(r.headers['cache-control'], 'no-store', path);
        assert.doesNotMatch(r.headers['content-security-policy'], /'nonce-'/, path);
      }
    } finally {
      await c.close();
    }
  });

  test('the server listens on loopback only', async () => {
    const w = world();
    const c = await startConsole({ ...w });
    try {
      assert.equal(c.address, '127.0.0.1');
    } finally {
      await c.close();
    }
  });

  test('writes need the flag, the origin and the token', async () => {
    // read-only server: halt is 405
    const w0 = world({ ledger: true });
    const ro = await startConsole({ ...w0, allowHalt: false });
    try {
      const r = await hit(ro.port, {
        path: '/api/halt',
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${ro.port}`,
          Cookie: cookie(ro.token),
          'Content-Type': 'application/json',
          Origin: `http://127.0.0.1:${ro.port}`,
          'X-Sakk-Token': ro.token,
        },
        body: '{}',
      });
      assert.equal(r.status, 405);
    } finally {
      await ro.close();
    }
    // write-enabled server: cookie alone is not enough — needs Origin and the header
    const w = world({ ledger: true });
    const c = await startConsole({ ...w, allowHalt: true });
    try {
      const base = {
        Host: `127.0.0.1:${c.port}`,
        Cookie: cookie(c.token),
        'Content-Type': 'application/json',
      };
      const noOrigin = await hit(c.port, {
        path: '/api/halt',
        method: 'POST',
        headers: { ...base, 'X-Sakk-Token': c.token },
        body: '{}',
      });
      assert.equal(noOrigin.status, 403, 'missing Origin');
      const noHeader = await hit(c.port, {
        path: '/api/halt',
        method: 'POST',
        headers: { ...base, Origin: `http://127.0.0.1:${c.port}` },
        body: '{}',
      });
      assert.equal(noHeader.status, 403, 'missing token header');
      const ok = await hit(c.port, {
        path: '/api/halt',
        method: 'POST',
        headers: { ...base, Origin: `http://127.0.0.1:${c.port}`, 'X-Sakk-Token': c.token },
        body: '{}',
      });
      assert.equal(ok.status, 200);
      assert.match(ok.body, /"halted":true/);
    } finally {
      await c.close();
    }
  });

  test('token compare is constant-time and failures are counted', async () => {
    // a wrong or wrong-length token never matches and never throws
    assert.equal(tokenOk('wrong', 'abcd'), false);
    assert.equal(tokenOk('', 'abcd'), false);
    assert.equal(tokenOk(undefined, 'abcd'), false);
    assert.equal(tokenOk('abcd', 'abcd'), true);
    const w = world();
    const c = await startConsole({ ...w });
    try {
      await hit(c.port, {
        path: '/api/overview?t=deadbeef',
        headers: { Host: `127.0.0.1:${c.port}` },
      });
      await hit(c.port, { path: '/api/overview', headers: { Host: `127.0.0.1:${c.port}` } });
      const f = await hit(c.port, {
        path: `/api/forbidden?t=${c.token}`,
        headers: { Host: `127.0.0.1:${c.port}` },
      });
      assert.match(f.body, /"forbidden":2/);
    } finally {
      await c.close();
    }
  });

  test('log text is escaped everywhere it is shown', async () => {
    const payload = '<script>alert(1)</script>';
    const w = world({
      decisions: [
        dec({ context: { agent: 'claude-code', action: payload, callId: 'c', estimatedUsd: 0 } }),
      ],
    });
    const c = await startConsole({ ...w });
    try {
      const page = await hit(c.port, {
        path: `/?t=${c.token}`,
        headers: { Host: `127.0.0.1:${c.port}` },
      });
      // the page is a constant template: the log string never reaches the HTML
      assert.ok(!page.body.includes('alert(1)'), 'log text is not reflected into HTML');
      // it is returned only as JSON data (the page renders it with textContent)
      const api = await hit(c.port, {
        path: '/api/records',
        headers: { Host: `127.0.0.1:${c.port}`, Cookie: cookie(c.token) },
      });
      assert.ok(api.body.includes(payload), 'the raw value is present as JSON data');
    } finally {
      await c.close();
    }
  });

  test('the page makes no request to another origin', async () => {
    // the page body carries no absolute URL, and the CSP header forbids one
    const page = renderPage('nonce123', false);
    assert.ok(!/https?:\/\//.test(page), 'no absolute URL in the page');
    const w = world();
    const c = await startConsole({ ...w });
    try {
      const r = await hit(c.port, {
        path: `/?t=${c.token}`,
        headers: { Host: `127.0.0.1:${c.port}` },
      });
      assert.match(r.headers['content-security-policy'], /default-src 'none'/);
      assert.match(r.headers['content-security-policy'], /connect-src 'self'/);
    } finally {
      await c.close();
    }
  });

  test('every response carries the strict security headers, never CORS', async () => {
    const w = world();
    const c = await startConsole({ ...w });
    try {
      const r = await hit(c.port, {
        path: `/?t=${c.token}`,
        headers: { Host: `127.0.0.1:${c.port}` },
      });
      assert.match(r.headers['content-security-policy'], /default-src 'none'/);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.equal(r.headers['access-control-allow-origin'], undefined);
      assert.match(r.headers['set-cookie']?.[0] ?? '', /SameSite=Strict/);
      assert.match(r.headers['set-cookie']?.[0] ?? '', /HttpOnly/);
    } finally {
      await c.close();
    }
  });
});

describe('sakk ui console (M4): data and bounds', () => {
  test('a huge decision log is paged, never loaded whole', () => {
    const w = world();
    // ~2 MiB of lines — more than TAIL_BYTES
    const one =
      JSON.stringify(
        dec({ context: { agent: 'a', action: 'shell.run', callId: 'x', estimatedUsd: 0 } }),
      ) + '\n';
    const n = Math.ceil((2 * 1024 * 1024) / one.length);
    const lines = [];
    for (let i = 0; i < n; i += 1) lines.push(JSON.stringify(dec({ by: `agent-${i}` })));
    writeFileSync(join(w.home, 'decisions.jsonl'), lines.join('\n') + '\n');
    const r = tailDecisions({ home: w.home });
    assert.ok(r.scannedBytes <= TAIL_BYTES, `scanned ${r.scannedBytes} > ${TAIL_BYTES}`);
    assert.ok(r.entries.length <= PAGE_LINES);
    assert.equal(r.truncated, true);
    // the newest line is present (we read from the end)
    assert.equal(r.entries[0].by, `agent-${n - 1}`);
  });

  test('evidence is labelled by its source', async () => {
    const w = world({ cap: 5, ledger: true });
    const o = overviewData({ home: w.home, env: w.env });
    assert.equal(o.source, 'from local logs');
    const c = await startConsole({ ...w, allowHalt: true });
    try {
      const r = await hit(c.port, {
        path: '/api/halt',
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${c.port}`,
          Cookie: cookie(c.token),
          'Content-Type': 'application/json',
          Origin: `http://127.0.0.1:${c.port}`,
          'X-Sakk-Token': c.token,
        },
        body: '{}',
      });
      assert.match(r.body, /self-declared/); // a self-declared stop, never "signed"
    } finally {
      await c.close();
    }
  });

  test('with no data the pages say nothing yet, not an error', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'console-bare-')));
    const home = join(base, '.sakk');
    mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      HOME: base,
      SAKK_HOME: home,
      CLAUDE_CONFIG_DIR: join(base, 'none'),
    };
    const c = await startConsole({ port: 0, home, cwd: base, env });
    try {
      const ov = await hit(c.port, {
        path: '/api/overview',
        headers: { Host: `127.0.0.1:${c.port}`, Cookie: cookie(c.token) },
      });
      assert.equal(ov.status, 200);
      const o = JSON.parse(ov.body);
      assert.equal(o.spend_usd, 0);
      assert.equal(o.cap_usd, null);
      const rec = await hit(c.port, {
        path: '/api/records',
        headers: { Host: `127.0.0.1:${c.port}`, Cookie: cookie(c.token) },
      });
      assert.equal(rec.status, 200);
      assert.deepEqual(JSON.parse(rec.body).decisions, []);
    } finally {
      await c.close();
    }
  });

  test('the console and the CLI report the same numbers', () => {
    const w = world();
    const got = tryData({ cwd: w.cwd, home: w.home, env: w.env, command: 'git push --force' });
    const cli = JSON.parse(
      execFileSync(
        process.execPath,
        [join(ROOT, 'bin', 'sakk.mjs'), 'try', 'git push --force', '--json'],
        {
          cwd: w.cwd,
          env: w.env,
          encoding: 'utf8',
        },
      ),
    );
    assert.equal(got.verdict, cli.verdict);
    assert.equal(got.policyHash, cli.policyHash);
  });

  test('every open-source page is in the nav and the coming-soon window is present', () => {
    const page = renderPage('n', false);
    for (const label of [
      'Overview',
      'Spend ledger',
      'Guard rules',
      'Secret guard',
      'Agents',
      'Records & export',
      'Model prices',
    ])
      assert.ok(page.includes(label), `nav: ${label}`);
    assert.match(page, /Enterprise/);
    assert.match(page, /Sakk for teams/);
    assert.match(page, /coming soon/i);
  });

  test('every page data endpoint answers on fixture data', async () => {
    const w = world({
      decisions: [
        dec(),
        dec({
          ruleId: 'secret',
          context: { agent: 'claude-code', action: 'write', callId: 'c2', estimatedUsd: 0 },
        }),
      ],
      cap: 5,
      ledger: true,
    });
    const c = await startConsole({ ...w, allowHalt: true });
    try {
      for (const name of ['overview', 'ledger', 'rules', 'secret', 'agents', 'records', 'prices']) {
        const r = await hit(c.port, {
          path: `/api/${name}`,
          headers: { Host: `127.0.0.1:${c.port}`, Cookie: cookie(c.token) },
        });
        assert.equal(r.status, 200, name);
        JSON.parse(r.body); // valid JSON
      }
    } finally {
      await c.close();
    }
  });

  test('the agents page reports installed hooks without firing them (read-only, bounded)', async () => {
    const w = world();
    // install the guard for claude-code in the isolated world (writes under HOME=base)
    install('claude-code', { user: false, cwd: w.base, home: w.base });
    const c = await startConsole({ ...w });
    try {
      const r = await hit(c.port, {
        path: '/api/agents',
        headers: { Host: `127.0.0.1:${c.port}`, Cookie: cookie(c.token) },
      });
      assert.equal(r.status, 200);
      const d = JSON.parse(r.body);
      const cc = d.checks.find((x) => x.name.startsWith('claude-code ('));
      assert.ok(cc, 'an installed claude-code hook is reported');
      assert.match(cc.detail, /installed/);
      // the read-only page must NOT have fired the hook (that is the probe path)
      assert.doesNotMatch(
        cc.detail,
        /forced push/,
        'the hook was reported, not run as a subprocess',
      );
    } finally {
      await c.close();
    }
  });
});

describe('sakk ui console (M4): environment', () => {
  test('a port already in use is refused, never silently changed', async () => {
    const w = world();
    const first = await startConsole({ ...w });
    try {
      await assert.rejects(
        startConsole({ ...w, port: first.port }),
        (e) => e && e.code === 'EADDRINUSE',
      );
    } finally {
      await first.close();
    }
  });
});

describe('sakk ui console (M4): typed refusals', () => {
  const H2 = (port, opts) => hit(port, { headers: { Host: `127.0.0.1:${port}` }, ...opts });
  const writeHeaders = (c) => ({
    Host: `127.0.0.1:${c.port}`,
    Cookie: cookie(c.token),
    'Content-Type': 'application/json',
    Origin: `http://127.0.0.1:${c.port}`,
    'X-Sakk-Token': c.token,
  });

  test('the try box refuses an empty command (CONSOLE_TRY_EMPTY)', async () => {
    const w = world();
    const c = await startConsole({ ...w });
    try {
      const r = await H2(c.port, { path: `/api/try?t=${c.token}&cmd=` });
      assert.equal(r.status, 400);
      assert.match(r.body, /CONSOLE_TRY_EMPTY/);
    } finally {
      await c.close();
    }
  });

  test('halt with no ledger, a bad body or a bad agent each refuses typed', async () => {
    const noLedger = await startConsole({ ...world(), allowHalt: true, ledgerPath: null });
    try {
      const r = await hit(noLedger.port, {
        path: '/api/halt',
        method: 'POST',
        headers: writeHeaders(noLedger),
        body: '{}',
      });
      assert.equal(r.status, 409);
      assert.match(r.body, /CONSOLE_NO_LEDGER/);
    } finally {
      await noLedger.close();
    }
    const c = await startConsole({ ...world({ ledger: true }), allowHalt: true });
    try {
      const bad = await hit(c.port, {
        path: '/api/halt',
        method: 'POST',
        headers: writeHeaders(c),
        body: 'not json',
      });
      assert.equal(bad.status, 400);
      assert.match(bad.body, /CONSOLE_BAD_BODY/);
      const agent = await hit(c.port, {
        path: '/api/halt',
        method: 'POST',
        headers: writeHeaders(c),
        body: '{"agent":""}',
      });
      assert.equal(agent.status, 400);
      assert.match(agent.body, /CONSOLE_BAD_AGENT/);
    } finally {
      await c.close();
    }
  });

  test('the stop button halts the ledger sakk init recorded for the hook (F-172)', async () => {
    const bin = join(ROOT, 'bin', 'sakk.mjs');
    const w = world();
    const proj = join(w.base, 'proj');
    mkdirSync(proj);
    const env = { ...w.env };
    delete env.SAKK_LEDGER_PATH;
    const init = spawnSync(process.execPath, [bin, 'init', '--cap', '100'], {
      encoding: 'utf8',
      env,
      cwd: proj,
    });
    assert.equal(init.status, 0, init.stderr);
    // started from another directory, with no --ledger: no ./sakk-ledger.json guess
    const ui = spawn(process.execPath, [bin, 'ui', '--allow-halt'], { env, cwd: w.base });
    try {
      const url = await new Promise((resolve, reject) => {
        let out = '';
        let err = '';
        ui.stdout.on('data', (b) => {
          out += b;
          const m = out.match(/Sakk console: (\S+)/);
          if (m) resolve(new URL(m[1]));
        });
        ui.stderr.on('data', (b) => (err += b));
        ui.on('exit', (code) => reject(new Error(`sakk ui exited ${code}: ${err}`)));
      });
      const tok = url.searchParams.get('t');
      const r = await hit(Number(url.port), {
        path: '/api/halt',
        method: 'POST',
        headers: {
          Host: url.host,
          Origin: url.origin,
          Cookie: cookie(tok),
          'X-Sakk-Token': tok,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(r.status, 200, r.body);
      assert.match(r.body, /"halted":true/);
    } finally {
      ui.kill('SIGINT');
    }
    const ev = {
      hook_event_name: 'PreToolUse',
      cwd: proj,
      session_id: 's-f172',
      tool_use_id: 'c-f172',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
    };
    const out = evaluate(normalize('claude-code', ev), { env, log: false });
    assert.ok(
      (out.decisions ?? []).some((d) => d.ruleId === 'halt'),
      'the installed hook sees the halt the console wrote',
    );
    assert.equal(out.verdict, 'deny');
  });

  test('sakk ui refuses an invalid, privileged or taken port', async () => {
    const bin = join(ROOT, 'bin', 'sakk.mjs');
    const runFail = (args) => {
      try {
        execFileSync(process.execPath, [bin, 'ui', ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { status: 0, stderr: '' };
      } catch (e) {
        return { status: e.status, stderr: String(e.stderr) };
      }
    };
    const invalid = runFail(['--port', 'notaport']);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /UI_PORT_INVALID/);
    const priv = runFail(['--port', '80']);
    assert.equal(priv.status, 2);
    assert.match(priv.stderr, /UI_PORT_PRIVILEGED/);
    // a port the test is holding: the CLI must refuse, not pick another
    const held = await startConsole({ ...world() });
    try {
      const taken = runFail(['--port', String(held.port)]);
      assert.equal(taken.status, 2);
      assert.match(taken.stderr, /UI_PORT_IN_USE/);
    } finally {
      await held.close();
    }
  });
});

// ---------------------------------------------------------------------------
// P0 UAT backfill — the console (M4) UAT cases that were "手工验证/待补自动化".
// Each test drives the REAL HTTP server (or the real renderPage artifact) so a
// green means the server behaves as the UAT case asserts, not a hand-rolled
// matcher. Where a case turns out to be an open gap, it is pinned with a GAP
// label and filed as a finding — never papered over. (branch oss/p0-uat-backfill)
// ---------------------------------------------------------------------------
describe('P0 UAT backfill — console (M4)', () => {
  const HOSTOK = (port) => ({ Host: `127.0.0.1:${port}` });

  // A sha256 map of every file under a directory, so "did any byte change" is a
  // single deepEqual — used by U-SEC-021 to prove GETs write nothing.
  function snapshotDir(dir) {
    const out = {};
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
      }
    };
    walk(dir);
    return out;
  }

  // U-SEC-003 — token variants, end to end through /api/overview. The exact
  // test name is the guard the C-09.2 ack points at; do not rename it.
  test('U-SEC-003 malformed, uppercased and Bearer-wrapped tokens are all rejected 403', async () => {
    const w = world({ decisions: [dec()] });
    const c = await startConsole({ ...w });
    try {
      const good = c.token;
      // positive control: the real token is accepted, so a blanket 403 below
      // cannot be a broken endpoint masquerading as a rejection.
      const ok = await hit(c.port, {
        path: '/api/overview',
        headers: { ...HOSTOK(c.port), Cookie: cookie(good) },
      });
      assert.equal(ok.status, 200, 'the real token is accepted (positive control)');

      const flip = good.slice(0, -1) + (good.slice(-1) === '0' ? '1' : '0'); // same length, one byte off
      const variants = [
        ['garbage / wrong length', 'not-a-real-token'],
        ['same length, one byte off', flip],
        ['Bearer-wrapped', `Bearer ${good}`],
      ];
      const up = good.toUpperCase();
      if (up !== good) variants.push(['uppercased', up]); // hex all-but-always has a-f; the freak all-digit token would equal itself, so skip it rather than flake

      for (const [label, tok] of variants) {
        const viaQuery = await hit(c.port, {
          path: `/api/overview?t=${encodeURIComponent(tok)}`,
          headers: HOSTOK(c.port),
        });
        assert.equal(viaQuery.status, 403, `${label} via ?t= must be 403`);
        const viaCookie = await hit(c.port, {
          path: '/api/overview',
          headers: { ...HOSTOK(c.port), Cookie: cookie(tok) },
        });
        assert.equal(viaCookie.status, 403, `${label} via cookie must be 403`);
      }
    } finally {
      await c.close();
    }
  });

  // U-SEC-007 — DNS-rebinding: a request carrying the right token but a Host
  // that is not the loopback literal the server bound to is refused, so a
  // rebinding attacker who reaches the port with a hostname gets nothing.
  test('U-SEC-007 a rebound Host (valid token, wrong Host) is refused 403', async () => {
    const w = world({ decisions: [dec()] });
    const c = await startConsole({ ...w });
    try {
      for (const host of ['attacker.example', `attacker.example:${c.port}`, 'localhost.evil']) {
        const r = await hit(c.port, {
          path: '/api/overview',
          headers: { Host: host, Cookie: cookie(c.token) },
        });
        assert.equal(r.status, 403, `Host ${host} must be refused`);
      }
    } finally {
      await c.close();
    }
  });

  // U-SEC-010 — cross-origin CSRF against the one write (halt): a foreign
  // Origin, and a form-style POST with no Origin/token header, are both
  // refused, and the agent is left un-halted in the ledger.
  test('U-SEC-010 cross-origin and form-style POST /api/halt are refused, agent stays un-halted', async () => {
    const w = world({ ledger: true });
    const c = await startConsole({ ...w, allowHalt: true });
    try {
      const foreign = await hit(c.port, {
        path: '/api/halt',
        method: 'POST',
        headers: {
          ...HOSTOK(c.port),
          Cookie: cookie(c.token),
          'Content-Type': 'application/json',
          Origin: 'http://attacker.example',
          'X-Sakk-Token': c.token,
        },
        body: '{}',
      });
      assert.equal(foreign.status, 403, 'a cross-origin halt must be refused');

      const formCsrf = await hit(c.port, {
        path: '/api/halt',
        method: 'POST',
        // a browser form-POST carries the cookie but cannot set X-Sakk-Token
        headers: { ...HOSTOK(c.port), Cookie: cookie(c.token), 'Content-Type': 'text/plain' },
        body: '{}',
      });
      assert.equal(formCsrf.status, 403, 'a form-style CSRF halt must be refused');

      const doc = readLedger({ ledgerPath: w.ledgerPath });
      assert.ok(
        !doc.halt || !doc.halt.global,
        'no cross-origin request may have halted the ledger',
      );
    } finally {
      await c.close();
    }
  });

  // U-SEC-012 — path traversal / static-file fishing: with a valid token, any
  // path that is not '/' or '/api/*' is a 404 with no file bytes, so the
  // process cannot be made to serve its own source or a dotfile.
  test('U-SEC-012 traversal and static paths 404, never serving file content', async () => {
    const w = world({ decisions: [dec()] });
    const c = await startConsole({ ...w });
    try {
      const paths = [
        '/etc/passwd',
        '/src/console.mjs',
        '/package.json',
        '/.env',
        '/%2e%2e%2f%2e%2e%2fpackage.json',
        '/..%2f..%2fsrc%2fhook.mjs',
      ];
      for (const path of paths) {
        const r = await hit(c.port, {
          path,
          headers: { ...HOSTOK(c.port), Cookie: cookie(c.token) },
        });
        assert.equal(r.status, 404, `${path} must be 404`);
        assert.ok(!/\bimport\b|root:|"name":|sk-ant/.test(r.body), `${path} leaked file content`);
      }
    } finally {
      await c.close();
    }
  });

  // U-SEC-016 / U-SEC-017 — the console can never show or export a plaintext
  // secret, because the value never reaches the decision log it reads from.
  // Drive the REAL hook on a secret-bearing command, then read the log and
  // every view (overview, the secrets panel, the export source) and assert the
  // value appears nowhere while the secret deny (rule + fingerprint) is present.
  test('U-SEC-016/017 a planted secret never reaches the log, the panel or the export', () => {
    const w = world();
    const SECRET = ['AKIA', 'IOSFODNN7EXAMPLE'].join(''); // assembled at runtime so no secret-shaped literal sits in source (the no-secrets-in-tree meta-test); still fires aws_access_key
    const r = evaluate(
      normalize('claude-code', {
        hook_event_name: 'PreToolUse',
        cwd: w.cwd,
        session_id: 's-sec',
        tool_use_id: 'c-sec-1',
        tool_name: 'Bash',
        tool_input: { command: `aws s3 cp x s3://b --metadata key=${SECRET}` },
      }),
      { env: w.env, log: true },
    );
    // the guard fired: the call is denied by the secret rule, not silently allowed
    assert.equal(r.verdict, 'deny');
    assert.ok(
      r.decisions.some((d) => d.ruleId === 'secret'),
      'the command must be denied by the secret rule',
    );

    // what landed on disk, and what every view renders from it
    const logText = readFileSync(join(w.home, 'decisions.jsonl'), 'utf8');
    const overview = JSON.stringify(overviewData({ home: w.home, env: w.env }));
    const panel = secretData({ home: w.home });
    const panelText = JSON.stringify(panel);
    for (const [where, text] of [
      ['decisions.jsonl', logText],
      ['overview (panel + export source)', overview],
      ['secrets panel', panelText],
    ]) {
      assert.ok(!text.includes(SECRET), `the plaintext secret must never appear in ${where}`);
    }
    // the panel still records that a secret was blocked, attributed to the agent,
    // but as a card built from rule + fingerprint — never the value
    assert.ok(panel.cards.length >= 1, 'a blocked secret must show as a card');
    assert.equal(panel.cards[0].agent, 'claude-code');
  });

  // U-SEC-018 — the shipped page carries the CSV formula-injection guard, so a
  // cell beginning =,+,-,@ (or a tab/CR) is prefixed with a quote on export.
  test('U-SEC-018 the shipped page ships the CSV formula-injection guard', () => {
    const page = renderPage('nonce-csv', false);
    // the neutralizing char class and the quote-prefix both live in the page JS
    assert.ok(page.includes('/^[=+\\-@\\t\\r]/'), 'the formula-injection char class is present');
    assert.ok(page.includes('v="\'"+v'), 'a cell matching it is prefixed with a quote');
  });

  // U-SEC-021 — every GET is read-only: hitting each page-data endpoint,
  // including the /api/try box that evaluates a command, changes no byte on disk.
  test('U-SEC-021 no GET endpoint writes anything, not even the try box', async () => {
    const w = world({ decisions: [dec()], ledger: true });
    const c = await startConsole({ ...w });
    try {
      const before = snapshotDir(w.base);
      const gets = [
        '/',
        '/api/overview',
        '/api/rules',
        '/api/secret',
        '/api/agents',
        '/api/prices',
        '/api/ledger',
        '/api/records',
        '/api/forbidden',
        '/api/try?cmd=ls%20-la',
        '/api/try?cmd=rm%20-rf%20%2F', // even a destructive command only gets judged, never run
      ];
      for (const path of gets) {
        const sep = path.includes('?') ? '&' : '?';
        await hit(c.port, { path: `${path}${sep}t=${c.token}`, headers: HOSTOK(c.port) });
      }
      assert.deepEqual(snapshotDir(w.base), before, 'a GET changed a file on disk');
    } finally {
      await c.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The spend ledger page (feat/console-gateway-ledger). Ledgers are written by
// the ledger's own initLedger / reserve / settle, and the server is the real
// startConsole, so a green here is the page the user opens.
// ---------------------------------------------------------------------------
describe('sakk ui console: spend ledger', () => {
  const own = (port, tok) => ({ Host: `127.0.0.1:${port}`, Cookie: cookie(tok) });
  async function getLedger(c) {
    const r = await hit(c.port, { path: '/api/ledger', headers: own(c.port, c.token) });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    return { r, d: JSON.parse(r.body) };
  }
  // bytes, mtime and the listing of every file under dir
  function fingerprint(dir) {
    const out = {};
    const walk = (d) => {
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else
          out[relative(dir, p)] = {
            sha: createHash('sha256').update(readFileSync(p)).digest('hex'),
            mtimeMs: st.mtimeMs,
          };
      }
    };
    walk(dir);
    return out;
  }
  const spend = (ledgerPath, callId, est, actual, agentId = 'litellm-gateway') => {
    reserve({ ledgerPath, callId, estimatedMaxUsd: est, agentId });
    if (actual !== undefined) settle({ ledgerPath, callId, actualUsd: actual });
  };

  test('with no ledger set the ledger view says so, never $0', async () => {
    const w = world();
    const c = await startConsole({ ...w, ledgerPath: null });
    try {
      const { r, d } = await getLedger(c);
      assert.equal(d.configured, false);
      assert.match(d.note, /--ledger/);
      assert.match(d.note, /config\.json/);
      // no figure at all, so the page cannot print a $0 cap or $0 spent
      assert.equal(d.status, undefined);
      assert.doesNotMatch(r.body, /cap_usd|settled_usd/);
    } finally {
      await c.close();
    }
    assert.equal(ledgerData({ ledgerPath: '' }).configured, false);
  });

  test('a ledger path that does not exist answers LEDGER_MISSING, not an empty ledger', async () => {
    const w = world();
    const missing = join(w.base, 'no-such-ledger.json');
    const c = await startConsole({ ...w, ledgerPath: missing });
    try {
      const { d } = await getLedger(c);
      assert.equal(d.configured, true);
      assert.equal(d.error, 'LEDGER_MISSING');
      assert.equal(d.ledger, missing);
      assert.equal(d.status, undefined);
      assert.equal(d.entries, undefined);
    } finally {
      await c.close();
    }
  });

  test('the ledger view and sakk status --json report the same numbers', async () => {
    const w = world({ ledger: true });
    spend(w.ledgerPath, 'g1', 0.5, 0.0123);
    spend(w.ledgerPath, 'g2', 0.25, 0.004);
    spend(w.ledgerPath, 'g3', 1.5); // still reserved: outstanding is non-zero
    const env = { ...w.env };
    delete env.SAKK_LEDGER_PATH;
    const cli = spawnSync(
      process.execPath,
      [join(ROOT, 'bin', 'sakk.mjs'), 'status', '--json', '--ledger', w.ledgerPath],
      { encoding: 'utf8', env, cwd: w.base },
    );
    assert.equal(cli.status, 0, cli.stderr);
    const fromCli = JSON.parse(cli.stdout);
    const c = await startConsole({ ...w });
    try {
      const { d } = await getLedger(c);
      // the whole object, not a chosen subset
      assert.deepEqual(d.status, fromCli);
      assert.equal(d.status.entries.SETTLED, 2);
      assert.equal(d.status.entries.RESERVED, 1);
      assert.ok(Math.abs(d.status.settled_usd - 0.0163) < 1e-12);
      assert.equal(d.status.outstanding_usd, 1.5);
      assert.equal(d.status.cap_usd, 100);
      assert.equal(d.entries_total, 3);
      assert.equal(d.source, 'from the ledger');
    } finally {
      await c.close();
    }
  });

  test('reading the ledger view leaves the ledger and its folder untouched', async () => {
    const w = world({ ledger: true });
    spend(w.ledgerPath, 'r1', 0.5, 0.1);
    assert.throws(() => spend(w.ledgerPath, 'r2', 500)); // writes an alert
    const before = fingerprint(w.base);
    const c = await startConsole({ ...w });
    try {
      for (let i = 0; i < 3; i += 1) {
        await getLedger(c);
        await hit(c.port, { path: '/api/overview', headers: own(c.port, c.token) });
      }
    } finally {
      await c.close();
    }
    assert.deepEqual(fingerprint(w.base), before, 'a GET changed a byte, an mtime or a file');
  });

  test('refusals from the alerts log show newest first with the cap they were judged against', async () => {
    const w = world({ ledger: true });
    spend(w.ledgerPath, 'ok1', 1, 0.5);
    assert.throws(() => spend(w.ledgerPath, 'big1', 200));
    assert.throws(() => spend(w.ledgerPath, 'big2', 300));
    const c = await startConsole({ ...w });
    try {
      const { d } = await getLedger(c);
      const a = d.alerts;
      assert.equal(a.source, 'from the alerts log');
      assert.match(a.note, /shared by every ledger/);
      assert.equal(a.path, alertsPathFor(w.ledgerPath));
      assert.equal(a.present, true);
      assert.equal(a.skipped, null);
      const refused = a.entries.filter((x) => x.kind === 'BUDGET_REFUSED');
      assert.deepEqual(
        refused.map((x) => x.callId),
        ['big2', 'big1'],
      );
      assert.equal(refused[0].estimatedMaxUsd, 300);
      assert.equal(refused[0].capUsd, 100);
      assert.equal(refused[1].estimatedMaxUsd, 200);
      // a refused call never became an entry
      assert.deepEqual(
        d.entries.map((e) => e.callId),
        ['ok1'],
      );
    } finally {
      await c.close();
    }
  });

  test('an oversized ledger is refused before it is read', () => {
    const w = world();
    const big = join(w.base, 'big-ledger.json');
    writeFileSync(big, 'x'.repeat(4096)); // not JSON: parsing it would say LEDGER_MALFORMED
    const d = ledgerData({ ledgerPath: big, maxBytes: 1024 });
    assert.equal(d.error, 'CONSOLE_LEDGER_TOO_BIG');
    assert.match(d.message, /4096 bytes/);
    assert.equal(d.status, undefined);
    // control: under the limit the same file reaches the parser
    assert.equal(ledgerData({ ledgerPath: big, maxBytes: 8192 }).error, 'LEDGER_MALFORMED');
    // the default limit sits far above a full hot file (seal + in-flight cap)
    assert.ok(LEDGER_VIEW_BYTES >= 16 * 1024 * 1024);
  });

  test('the entries list is capped and says when it is cut', () => {
    const w = world({ ledger: true });
    for (let i = 1; i <= 5; i += 1) spend(w.ledgerPath, `call-${i}`, 0.1, 0.01);
    const cut = ledgerData({ ledgerPath: w.ledgerPath, limit: 3 });
    assert.equal(cut.entries.length, 3);
    assert.equal(cut.entries_total, 5);
    assert.equal(cut.truncated, true);
    assert.deepEqual(
      cut.entries.map((e) => e.callId),
      ['call-5', 'call-4', 'call-3'],
    );
    const whole = ledgerData({ ledgerPath: w.ledgerPath });
    assert.equal(whole.entries.length, 5);
    assert.equal(whole.truncated, false);
    assert.ok(PAGE_LINES >= 5);
  });

  test('hostile ledger text is returned as data, never put into the page', async () => {
    const w = world({ ledger: true });
    const evilAgent = '<img src=x onerror=alert(1)>';
    const evilCall = '<script>alert(1)</script>';
    spend(w.ledgerPath, evilCall, 0.1, 0.01, evilAgent);
    // a hand-written alerts log: a nested value, an array line and a broken line
    appendFileSync(
      alertsPathFor(w.ledgerPath),
      JSON.stringify({
        at: '2026-10-31T00:00:00.000Z',
        kind: { nested: '<b>x</b>' },
        callId: evilCall,
      }) + '\n[1,2]\nnot json\n',
    );
    const c = await startConsole({ ...w });
    try {
      const { r, d } = await getLedger(c);
      assert.match(r.headers['content-security-policy'], /default-src 'none'; script-src 'none'/);
      assert.equal(d.entries[0].agentId, evilAgent);
      assert.equal(d.entries[0].callId, evilCall);
      const alert = d.alerts.entries.find((x) => x.callId === evilCall);
      assert.equal(alert.kind, null, 'a nested value is dropped, not passed to the page');
      assert.equal(d.alerts.unreadable, 2);
    } finally {
      await c.close();
    }
    // the page only ever sets text, never markup
    const page = renderPage('n', false);
    assert.doesNotMatch(page, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.ok(page.includes('ledger:async'), 'the ledger page is rendered by the same helpers');
  });

  test('sakk ui started elsewhere shows the ledger config.json points at', async () => {
    const bin = join(ROOT, 'bin', 'sakk.mjs');
    const w = world();
    const drill = join(w.base, 'drill');
    mkdirSync(drill);
    const ledgerPath = join(drill, 'drill-ledger.json');
    initLedger({ ledgerPath, capUsd: 0.3 });
    spend(ledgerPath, 'gw-1', 0.01, 0.00123);
    const cfgPath = join(w.home, 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, ledgerPath }));
    const elsewhere = join(w.base, 'elsewhere');
    mkdirSync(elsewhere);
    const env = { ...w.env };
    delete env.SAKK_LEDGER_PATH;
    const ui = spawn(process.execPath, [bin, 'ui'], { env, cwd: elsewhere });
    try {
      const url = await new Promise((resolve, reject) => {
        let out = '';
        let err = '';
        ui.stdout.on('data', (b) => {
          out += b;
          const m = out.match(/Sakk console: (\S+)/);
          if (m) resolve(new URL(m[1]));
        });
        ui.stderr.on('data', (b) => (err += b));
        ui.on('exit', (code) => reject(new Error(`sakk ui exited ${code}: ${err}`)));
      });
      const tok = url.searchParams.get('t');
      const r = await hit(Number(url.port), {
        path: '/api/ledger',
        headers: { Host: url.host, Cookie: cookie(tok) },
      });
      assert.equal(r.status, 200);
      const d = JSON.parse(r.body);
      assert.equal(d.configured, true);
      assert.equal(d.status.ledger, ledgerPath);
      assert.equal(d.status.cap_usd, 0.3);
      assert.equal(d.entries_total, 1);
      assert.equal(d.entries[0].agentId, 'litellm-gateway');
    } finally {
      ui.kill('SIGINT');
    }
  });

  test('a symlinked ledger is refused, not read through the link', async () => {
    const w = world({ ledger: true });
    spend(w.ledgerPath, 's1', 0.1, 0.01);
    const link = join(w.base, 'linked-ledger.json');
    symlinkSync(w.ledgerPath, link);
    assert.equal(ledgerData({ ledgerPath: link }).error, 'LEDGER_PATH_NOT_CANONICAL');
    const c = await startConsole({ ...w, ledgerPath: link });
    try {
      const { d } = await getLedger(c);
      assert.equal(d.error, 'LEDGER_PATH_NOT_CANONICAL');
      assert.equal(d.entries, undefined);
    } finally {
      await c.close();
    }
  });

  test('an alerts file that is not a regular file is skipped, never blocks', () => {
    const kinds = {
      fifo: (p) => execFileSync('mkfifo', [p]),
      directory: (p) => mkdirSync(p),
      symlink: (p) => {
        const real = join(dirname(p), 'real-alerts.jsonl');
        writeFileSync(real, JSON.stringify({ at: 'x', kind: 'BUDGET_REFUSED' }) + '\n');
        symlinkSync(real, p);
      },
    };
    for (const [kind, make] of Object.entries(kinds)) {
      const w = world({ ledger: true });
      spend(w.ledgerPath, 'k1', 0.1, 0.01);
      make(alertsPathFor(w.ledgerPath));
      const d = ledgerData({ ledgerPath: w.ledgerPath });
      assert.equal(d.alerts.skipped, 'not a regular file', kind);
      assert.equal(d.alerts.present, false, kind);
      assert.deepEqual(d.alerts.entries, [], kind);
      // the ledger itself still shows
      assert.equal(d.entries_total, 1, kind);
    }
    // the decisions tail shares the reader, so a fifo there is skipped too
    const w = world();
    execFileSync('mkfifo', [join(w.home, 'decisions.jsonl')]);
    assert.deepEqual(tailDecisions({ home: w.home }).entries, []);
  });
});
