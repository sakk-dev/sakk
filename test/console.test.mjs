import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startConsole,
  tailDecisions,
  tokenOk,
  renderPage,
  overviewData,
  tryData,
  TAIL_BYTES,
  PAGE_LINES,
} from '../src/console.mjs';
import { initLedger } from '../src/ledger.mjs';

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
      assert.match(r.body, /name typed by the user/); // a self-declared stop, never "signed"
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
