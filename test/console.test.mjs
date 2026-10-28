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
} from '../src/console.mjs';
import { initLedger, readLedger } from '../src/ledger.mjs';
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
      for (const path of ['/', '/api/overview', '/api/records', '/api/rules']) {
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
      for (const name of ['overview', 'rules', 'secret', 'agents', 'records', 'prices']) {
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
    const w = world({ decisions: [dec()] });
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
