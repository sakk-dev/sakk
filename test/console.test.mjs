import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
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
  utimesSync,
  rmSync,
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
import * as hook from '../src/hook.mjs';
import { install } from '../src/guard-install.mjs';

// literals, not imports: the guards for F-226..F-229 must load on the code
// before the fix, where hook.mjs has no DOCTOR_BY (findings-proof)
const { normalize, evaluate } = hook;
const DOCTOR_BY = 'sakk-doctor';

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

/**
 * The page's own data logic (its constants, helpers, derive and hookState),
 * cut from the rendered page and run on stub data. No DOM is needed: derive
 * only reads S.d and hookState only reads the doctor's checks.
 */
function pageLogic() {
  const page = renderPage('n', true);
  // the page before F-229 starts its constants at VIA
  const doc = page.indexOf('const DOCTOR_BY=');
  const a = doc >= 0 ? doc : page.indexOf('const VIA=');
  const h = page.indexOf('function hookState(');
  assert.ok(a > 0 && h > a, 'the page defines its constants before hookState');
  const src = page.slice(a, page.indexOf('\n', h));
  return new Function(
    'document',
    src + '\nreturn {S, VIA, derive, hookState, in7, get D() { return D; }};',
  )({ getElementById: () => null });
}

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

  test('an uncounted day shows a dash, not $0, until sakk spend counts it (F-231)', async () => {
    // a spent call today, but no cap: the hook never counts it, so only sakk spend does
    const w = world();
    writeFileSync(
      join(w.home, 'config.json'),
      JSON.stringify({ claudeLogDir: join(w.base, 'emptylogs'), timeZone: 'UTC' }),
    );
    writeFileSync(
      join(w.base, 'emptylogs', 'session.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        requestId: 'req_1',
        message: {
          id: 'msg_1',
          model: 'deepseek-chat',
          usage: { input_tokens: 1000, output_tokens: 100 },
        },
      }) + '\n',
    );
    const c = await startConsole({ ...w });
    const overview = async () => {
      const r = await hit(c.port, {
        path: '/api/overview',
        headers: { Host: `127.0.0.1:${c.port}`, Cookie: cookie(c.token) },
      });
      assert.equal(r.status, 200);
      return JSON.parse(r.body);
    };
    const filesJson = join(w.home, 'spend', 'files.json');
    try {
      // never counted: no index at all, so the $0 in the data is not a figure
      let o = await overview();
      assert.equal(o.indexed_at, null);
      assert.equal(o.counted_today, false);

      // the real CLI counts the real fixture log
      const cli = JSON.parse(
        execFileSync(process.execPath, [join(ROOT, 'bin', 'sakk.mjs'), 'spend', '--json'], {
          cwd: w.cwd,
          env: w.env,
          encoding: 'utf8',
        }),
      );
      assert.ok(cli.spend_usd > 0, 'the fixture call is priced');
      o = await overview();
      assert.equal(o.counted_today, true);
      assert.equal(typeof o.indexed_at, 'string');
      assert.equal(o.spend_usd, cli.spend_usd);

      // counted, but on an earlier day: not today's figure either
      // whole seconds: file times do not keep every millisecond
      const twoDaysAgo = new Date(Math.floor(Date.now() / 1000 - 48 * 3600) * 1000);
      utimesSync(filesJson, twoDaysAgo, twoDaysAgo);
      o = await overview();
      assert.equal(o.counted_today, false);
      assert.equal(o.indexed_at, twoDaysAgo.toISOString());

      // the index removed again reads as never counted, not as $0 counted
      rmSync(filesJson);
      o = await overview();
      assert.equal(o.indexed_at, null);
      assert.equal(o.counted_today, false);
    } finally {
      await c.close();
    }
  });

  test('the Today card names sakk spend when today is not counted (F-231)', () => {
    const page = renderPage('n', false);
    // the figure is gated on counted_today, and the uncounted card says how to count
    assert.ok(page.includes('ov.counted_today===true'), 'the card reads counted_today');
    assert.ok(page.includes('counted?usd(ov.spend_usd):"—"'), 'an uncounted day shows a dash');
    assert.ok(page.includes('cap&&counted'), 'no cap bar for an uncounted day');
    assert.ok(page.includes('run sakk spend to count it'), 'the hint names sakk spend');
    assert.ok(page.includes('Not counted yet'), 'never counted');
    assert.ok(page.includes('Not counted today'), 'counted on an earlier day');
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
      'Spend log',
      'Blocked actions',
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

  // The rendered check (every page at 829, 700 and 375 px wide, no sideways
  // scroll) was done in a browser; this pins the stylesheet rules that made it pass.
  test('the console page follows the frozen v10 open-source layout (F-223)', () => {
    const page = renderPage('n', true);
    // the v10 shell: brand bar, side nav, main column, and the edition tag
    for (const cls of ['"top"', '"shell"', '"side"', '"edtag oss"', '"crumb"', '"card kpi"'])
      assert.ok(page.includes(cls), `v10 shell: ${cls}`);
    assert.ok(page.includes('Open source · local'), 'the edition tag');
    // the ledger is the Spend log under Overview, not a page of its own
    assert.ok(!page.includes('Spend ledger'), 'no separate Spend ledger page');
    assert.match(page, /calls:\s*"overview"|calls:"overview"/, 'Spend log sits under Overview');
    assert.match(
      page,
      /blocks:\s*"overview"|blocks:"overview"/,
      'Blocked actions sits under Overview',
    );
    // the 14-step tour, the stop wizard and the help popovers ship with the page
    assert.ok(page.includes('sakk-tour10-oss'), 'the tour');
    assert.ok(page.includes('Type STOP'), 'the stop wizard asks for STOP');
    assert.ok(page.includes('data-help'), 'the ? help popovers');
    // cells with no open-source data source say so instead of a number
    assert.ok(page.includes('"—","Not in this version"'), 'a dash cell carries its reason');
  });

  test('the page sends the halt token from its address, not the HttpOnly cookie (F-223)', () => {
    const page = renderPage('n', true);
    // the cookie is HttpOnly, so script can never read it: the token must come from ?t=
    assert.ok(
      page.includes('new URLSearchParams(location.search).get("t")'),
      'the token is read from the address',
    );
    assert.ok(!page.includes('document.cookie'), 'the page never reads cookies');
    assert.ok(page.includes('"X-Sakk-Token":TOKEN'), 'the stop request carries the token header');
    // without the flag the button explains how to enable it instead of failing
    assert.ok(renderPage('n', false).includes('ALLOW_HALT=false'));
    assert.ok(page.includes('ALLOW_HALT=true'));
    assert.ok(
      page.includes('sakk ui --allow-halt'),
      'the read-only console says how to enable stop',
    );
  });

  test('the page template has no inline style attributes, which the CSP would block (F-223)', () => {
    const page = renderPage('n', true);
    // style-src carries only the nonce, so a style="" attribute would be refused
    assert.doesNotMatch(page, /\sstyle\s*=/i, 'no style="" attribute');
    assert.ok(!page.includes('setAttribute("style"'), 'no style attribute set from script');
    // every <style> and <script> carries the nonce
    const tags = page.match(/<(style|script)\b[^>]*>/g) ?? [];
    assert.ok(tags.length >= 2);
    for (const t of tags) assert.match(t, /nonce="n"/, t);
  });

  test('the stylesheet keeps long unbreakable text from widening the page (F-222)', () => {
    const css = renderPage('n', false).match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
    const rule = (sel) => {
      const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = css.match(new RegExp('(?:^|\\})\\s*' + esc + '\\{([^}]*)\\}', 'm'));
      return m ? m[1] : '';
    };
    assert.match(
      rule('main'),
      /min-width:0/,
      'main is a flex child: without min-width:0 its widest unbreakable text sets its width',
    );
    for (const sel of ['.src', 'code,.mono']) {
      assert.match(rule(sel), /overflow-wrap:anywhere/, sel);
    }
    assert.match(rule('.card'), /overflow-x:auto/, '.card');
  });

  test('the nav keeps its scroll and the chosen item in view across a re-render (F-224)', () => {
    const page = renderPage('n', true);
    const r0 = page.indexOf('function render(){');
    const body = page.slice(r0, page.indexOf('\n}', r0));
    const save = body.indexOf('scrollLeft');
    assert.ok(
      save > 0 && save < body.indexOf('app.textContent=""'),
      'the old nav scroll is read before the shell is wiped',
    );
    assert.ok(
      body.indexOf('keepNav(side,navX,navY)') > body.indexOf('app.append('),
      'the nav is put back after the new shell is in the page',
    );
    const k0 = page.indexOf('function keepNav(');
    const src = page.slice(k0, page.indexOf('\nfunction go(', k0));
    assert.ok(
      k0 > 0 && !/scrollIntoView|scrollTo\(/.test(src),
      'keepNav moves the nav only, never the page',
    );
    const keepNav = new Function(src + '\nreturn keepNav;')();
    // a 829 px strip whose items run to 1200 px; item = [from, to] in strip coordinates
    const strip = (item) => {
      const side = {
        scrollLeft: 0,
        scrollTop: 0,
        scrollWidth: 1200,
        clientWidth: 829,
        scrollHeight: 40,
        clientHeight: 40,
      };
      side.getBoundingClientRect = () => ({ left: 0, right: 829, top: 0, bottom: 40 });
      const a = {
        getBoundingClientRect: () => ({
          left: item[0] - side.scrollLeft,
          right: item[1] - side.scrollLeft,
          top: 4,
          bottom: 36,
        }),
      };
      side.querySelector = () => (item ? a : null);
      return side;
    };
    const kept = strip([300, 400]);
    keepNav(kept, 157.5, 0);
    assert.equal(
      kept.scrollLeft,
      157.5,
      'an item already in view keeps the scroll the person left',
    );
    const right = strip([900, 980]);
    keepNav(right, 0, 0);
    assert.ok(right.scrollLeft + 829 >= 980, 'an item past the right edge is scrolled into view');
    const left = strip([10, 90]);
    keepNav(left, 300, 0);
    assert.ok(left.scrollLeft <= 10, 'an item past the left edge is scrolled into view');
    const none = strip(null);
    keepNav(none, 42, 0);
    assert.equal(none.scrollLeft, 42, 'with no chosen item the scroll is only restored');
  });

  test('nav labels reserve their bold width so the items do not shift (F-224)', () => {
    const page = renderPage('n', false);
    assert.ok(
      page.includes('$("span",{class:"lbl","data-label":TITLES[p],text:TITLES[p]})'),
      'every nav label carries its own text in data-label',
    );
    const css = page.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
    const rule = (sel) => {
      const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = css.match(new RegExp('(?:^|\\})\\s*' + esc + '\\{([^}]*)\\}', 'm'));
      return m ? m[1] : '';
    };
    const bold = rule('.nav[aria-current="page"]').match(/font-weight:(\d+)/)[1];
    const ghost = rule('.nav .lbl::after');
    assert.match(ghost, /content:attr\(data-label\)/);
    assert.match(
      ghost,
      new RegExp('font-weight:' + bold),
      'the hidden copy is as bold as the chosen item',
    );
    assert.match(ghost, /height:0/);
    assert.match(ghost, /visibility:hidden/);
    assert.match(
      rule('.nav .lbl'),
      /flex-direction:column/,
      'the label is as wide as its bold copy',
    );
    assert.match(
      rule('html'),
      /scrollbar-gutter:stable/,
      'a scrollbar appearing does not shift the page',
    );
    assert.match(
      rule('.nav .navsoon,.nav .badge'),
      /font-weight:400/,
      'the coming-soon tag and the count badge keep one weight whether or not their item is chosen',
    );
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

  const OUTAGE = {
    since: '2026-11-02T06:02:11.408Z',
    allowed_calls: 3,
    est_max_unrecorded_usd: 0.004213,
    last_reason: 'sakk_reserve: TimeoutError: ',
    last_at: '2026-11-02T06:09:58.120Z',
  };
  const gatewayFile = (ledgerPath, over = {}) =>
    writeFileSync(
      `${ledgerPath}.gateway.json`,
      JSON.stringify({
        version: 1,
        updatedAt: '2026-11-02T06:10:00.000Z',
        mode: 'allow',
        outage: null,
        last_outage: null,
        ...over,
      }),
    );

  test('with a gateway status file, the ledger view and sakk status --json still agree', async () => {
    const w = world({ ledger: true });
    spend(w.ledgerPath, 'g1', 0.5, 0.0123);
    gatewayFile(w.ledgerPath, { outage: OUTAGE });
    const env = { ...w.env };
    delete env.SAKK_LEDGER_PATH;
    delete env.SAKK_GATEWAY_STATUS;
    const cli = spawnSync(
      process.execPath,
      [join(ROOT, 'bin', 'sakk.mjs'), 'status', '--json', '--ledger', w.ledgerPath],
      { encoding: 'utf8', env, cwd: w.base },
    );
    assert.equal(cli.status, 0, cli.stderr);
    const fromCli = JSON.parse(cli.stdout);
    const c = await startConsole({ ...w, env });
    try {
      const { d } = await getLedger(c);
      assert.deepEqual(d.status, fromCli);
      assert.deepEqual(d.status.gateway.outage, OUTAGE);
      // the outage calls are the gateway's report, not ledger entries
      assert.equal(d.status.entries.SETTLED, 1);
      assert.equal(d.entries_total, 1);
    } finally {
      await c.close();
    }
  });

  test('/api/gateway answers behind the token and probes the gateway it names', async () => {
    const w = world({ ledger: true });
    const up = createServer((req, res) => res.writeHead(200).end('"I\'m alive!"'));
    await new Promise((r) => up.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${up.address().port}`;
    const env = { ...w.env, SAKK_GATEWAY_URL: url };
    delete env.SAKK_GATEWAY_STATUS;
    const c = await startConsole({ ...w, env });
    try {
      const anon = await hit(c.port, {
        path: '/api/gateway',
        headers: { Host: `127.0.0.1:${c.port}` },
      });
      assert.equal(anon.status, 403);
      assert.doesNotMatch(anon.body, /outage|probe/);
      const get = async () =>
        JSON.parse(
          (await hit(c.port, { path: '/api/gateway', headers: own(c.port, c.token) })).body,
        );
      // no status file: no gateway in use, nothing probed
      assert.deepEqual(await get(), {
        source: 'from the gateway status file',
        status: null,
        probe: null,
      });
      gatewayFile(w.ledgerPath, { outage: OUTAGE });
      const d = await get();
      assert.deepEqual(d.status.outage, OUTAGE);
      assert.deepEqual(d.probe, { url, ok: true, status: 200 });
    } finally {
      await c.close();
      await new Promise((r) => up.close(r));
    }
  });

  /** The page's gatewayBanners, cut from the rendered page, on stub elements. */
  function banners(gateway, when = (s) => `<${s}>`) {
    const page = renderPage('n', true);
    const a = page.indexOf('function gatewayBanners(');
    assert.ok(a > 0, 'the page draws gateway banners');
    const end = page.indexOf('\nfunction load(', a);
    assert.ok(end > a, 'gatewayBanners ends before load()');
    const src = page.slice(a, end);
    const $ = (tag, attrs = {}, ...kids) => ({ tag, ...attrs, kids });
    const items = [];
    const main = { append: (x) => items.push(x) };
    new Function('$', 'S', 'when', 'usd', 'plural', 'main', `${src}\ngatewayBanners(main);`)(
      $,
      { d: { gateway } },
      when,
      (v) => `$${v}`,
      (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`,
      main,
    );
    const text = (x) => [x.text ?? '', ...(x.kids ?? []).map(text)].join(' ');
    return items.map((x) => ({ class: x.class, role: x.role, text: text(x) }));
  }

  test('during an outage every page carries a red banner; after it, a warning', () => {
    const ok = { url: 'http://127.0.0.1:4000', ok: true, status: 200 };
    // no status file: no banner
    assert.deepEqual(banners({ status: null, probe: null }), []);
    assert.deepEqual(banners(undefined), []);
    // an outage: red, announced, and it says the calls are not in the ledger
    const down = banners({ status: { outage: OUTAGE, last_outage: null }, probe: ok });
    assert.equal(down.length, 1);
    assert.equal(down[0].class, 'haltbar');
    assert.equal(down[0].role, 'alert');
    assert.match(down[0].text, /Sakk unreachable · calls going through unmetered/);
    assert.match(down[0].text, /since <2026-11-02T06:02:11\.408Z>/);
    assert.match(down[0].text, /3 calls let through, up to \$0\.004213/);
    assert.match(down[0].text, /not recorded in the ledger and not capped/);
    // the outage ended: a warning, not red, with the window to check
    const ended = { ...OUTAGE, allowed_calls: 1, ended_at: '2026-11-02T06:20:00.000Z' };
    const after = banners({ status: { outage: null, last_outage: ended }, probe: ok });
    assert.equal(after.length, 1);
    assert.equal(after[0].class, 'note warn');
    assert.match(
      after[0].text,
      /Last Sakk outage: <2026-11-02T06:02:11\.408Z> to <2026-11-02T06:20:00\.000Z>/,
    );
    assert.match(after[0].text, /1 call through/);
    // a blip inside one minute reads as one time, not "12:11 to 12:11"
    const blip = banners(
      { status: { outage: null, last_outage: ended }, probe: ok },
      () => '12:11',
    );
    assert.match(blip[0].text, /Last Sakk outage: 12:11, under a minute\./);
    assert.doesNotMatch(blip[0].text, /12:11 to 12:11/);
    // the gateway itself does not answer: red, naming the address
    const gone = banners({
      status: { outage: null, last_outage: null },
      probe: { url: 'http://127.0.0.1:4000', ok: false, error: 'ECONNREFUSED' },
    });
    assert.equal(gone.length, 1);
    assert.equal(gone[0].class, 'haltbar');
    assert.match(gone[0].text, /Gateway not answering at http:\/\/127\.0\.0\.1:4000/);
    assert.match(gone[0].text, /ECONNREFUSED/);
    // an unreadable status file is said, never shown as a healthy gateway
    const broken = banners({
      status: { error: 'GATEWAY_STATUS_INVALID', message: 'not JSON' },
      probe: ok,
    });
    assert.equal(broken.length, 1);
    assert.match(broken[0].text, /could not be read \(GATEWAY_STATUS_INVALID\)/);
    // the banner is drawn by render(), which every page goes through
    const page = renderPage('n', true);
    const render = page.slice(page.indexOf('function render('));
    assert.ok(render.indexOf('gatewayBanners(main);') > 0);
    assert.match(page, /api\("gateway"\)/);
  });

  test('in deny mode the banner says calls are refused, never that they go through', () => {
    const ok = { url: 'http://127.0.0.1:4000', ok: true, status: 200 };
    const none = { ...OUTAGE, allowed_calls: 0, est_max_unrecorded_usd: 0 };
    const deny = banners({ status: { mode: 'deny', outage: none, last_outage: null }, probe: ok });
    assert.equal(deny.length, 1);
    assert.equal(deny[0].class, 'haltbar');
    assert.equal(deny[0].role, 'alert');
    assert.match(deny[0].text, /Sakk unreachable · calls refused \(deny mode\)/);
    assert.match(deny[0].text, /every call gets HTTP 503 until Sakk answers/);
    assert.doesNotMatch(deny[0].text, /unmetered|let through/);
    // switched to deny mid-outage: the calls let through before still show
    const mixed = banners({
      status: { mode: 'deny', outage: OUTAGE, last_outage: null },
      probe: ok,
    });
    assert.match(mixed[0].text, /Earlier in this outage 3 calls went through unmetered/);
    // an outage that let nothing through ends with nothing to check
    const ended = { ...none, ended_at: '2026-11-02T06:20:00.000Z' };
    const after = banners({
      status: { mode: 'deny', outage: null, last_outage: ended },
      probe: ok,
    });
    assert.match(after[0].text, /No calls went through unmetered\./);
    assert.doesNotMatch(after[0].text, /provider's bill/);
  });

  /** The header state render() picks, cut from the rendered page. */
  function headerState(gateway, D = {}) {
    const page = renderPage('n', true);
    const a = page.indexOf('\nconst h=D.halt;', page.indexOf('function render('));
    const end = page.indexOf('\nlet stop;', a);
    assert.ok(a > 0 && end > a, 'render() picks the header state');
    return new Function('D', 'S', 'pill', `${page.slice(a, end)}\nreturn state;`)(
      D,
      { d: { gateway } },
      (text, cls) => ({ text, cls }),
    );
  }

  test('the header never says "Running normally" while the gateway reports trouble', () => {
    const ok = { url: 'http://127.0.0.1:4000', ok: true, status: 200 };
    const healthy = { status: { mode: 'allow', outage: null, last_outage: null }, probe: ok };
    assert.deepEqual(headerState(healthy), { text: 'Running normally', cls: 'p-ok' });
    assert.deepEqual(headerState(undefined), { text: 'Running normally', cls: 'p-ok' });
    assert.deepEqual(headerState({ error: 'FETCH_FAILED' }), {
      text: 'Running normally',
      cls: 'p-ok',
    });
    const down = { status: { mode: 'allow', outage: OUTAGE, last_outage: null }, probe: ok };
    assert.deepEqual(headerState(down), {
      text: 'Sakk unreachable · calls unmetered',
      cls: 'p-bad',
    });
    const deny = { status: { mode: 'deny', outage: OUTAGE, last_outage: null }, probe: ok };
    assert.deepEqual(headerState(deny), { text: 'Sakk unreachable · calls refused', cls: 'p-bad' });
    const gone = { ...healthy, probe: { url: ok.url, ok: false, error: 'ECONNREFUSED' } };
    assert.deepEqual(headerState(gone), { text: 'Gateway not answering', cls: 'p-bad' });
    // a past outage is a note on the page, not a header alarm
    const ended = { ...OUTAGE, ended_at: '2026-11-02T06:20:00.000Z' };
    const after = { status: { mode: 'allow', outage: null, last_outage: ended }, probe: ok };
    assert.equal(headerState(after).cls, 'p-ok');
    // a stop still outranks everything; reconciling still shows when the gateway is fine
    assert.equal(headerState(down, { halt: { scope: 'global' } }).text, 'Stopped (global)');
    const rec = { st: { reconciliation_required: true } };
    assert.equal(headerState(healthy, rec).cls, 'p-warn');
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
    assert.ok(page.includes('api("ledger")'), 'the ledger is read by the same page helpers');
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

describe('sakk ui console: UAT 2026-11-01 fixes', () => {
  const ON = '2026-10-22T10:00:00.000Z';
  const ctx = (over = {}) => ({
    agent: 'claude-code',
    action: 'shell.run',
    callId: 'c1',
    estimatedUsd: 0,
    ...over,
  });
  const stage = (L, d) => {
    L.S.d = { overview: { zone: 'UTC', day: '2026-10-22' }, ...d };
    L.derive();
    return L.D;
  };

  test("the doctor's self-test is not counted as a blocked action (F-229)", () => {
    assert.equal(hook.DOCTOR_BY, DOCTOR_BY, "the hook's label");
    const page = renderPage('n', true);
    assert.ok(
      page.includes(`const DOCTOR_BY=${JSON.stringify(DOCTOR_BY)};`),
      "the page uses the hook's label",
    );
    const w = world({
      decisions: [
        dec({
          by: DOCTOR_BY,
          verdict: 'deny',
          ruleId: 'shell-destructive',
          context: ctx({ callId: 'doctor-fire' }),
        }),
        dec({ verdict: 'deny', ruleId: 'shell-destructive', context: ctx({ callId: 'c2' }) }),
        { at: ON, by: 'cursor', verdict: 'allow', ruleId: null, policyHash: H }, // no context
        {
          at: ON,
          verdict: 'deny',
          ruleId: 'shell-destructive',
          policyHash: H,
          context: { action: 'shell.run', callId: 'c4' },
        }, // no by
        null, // parses, but is not a record
      ],
    });
    // the server: counts and feed leave the probe out; a non-record line is unreadable, not a row
    const o = overviewData({ home: w.home, env: w.env });
    assert.deepEqual(o.recent_counts, { allow: 1, deny: 2, require_approval: 0 });
    assert.equal(o.recent.length, 3);
    assert.ok(o.recent.every((d) => d.by !== DOCTOR_BY));
    const tail = tailDecisions({ home: w.home });
    assert.equal(tail.unreadable, 1);
    assert.equal(tail.entries.length, 4);
    assert.ok(
      tail.entries.some((d) => d.by === DOCTOR_BY),
      'records still list the probe',
    );
    // the page: blocks, agents and counts leave it out; records and export keep it
    const D = stage(pageLogic(), { records: { decisions: tail.entries } });
    assert.equal(D.decs.length, 3);
    assert.ok(D.decs.every((d) => d.by !== DOCTOR_BY));
    assert.deepEqual(D.blocks.map((b) => b.id).sort(), ['c2', 'c4']);
    assert.equal(pageLogic().VIA[DOCTOR_BY], 'Doctor self-test');
    assert.ok(
      page.includes('const recs=arr(S.d.records&&S.d.records.decisions);'),
      'export writes every record',
    );
    // a stray null that reaches the page anyway is skipped, not a crash
    assert.equal(
      stage(pageLogic(), { records: { decisions: [null, ...tail.entries] } }).decs.length,
      3,
    );
  });

  test('the Open items count is the number of open rows it links to (F-228)', () => {
    const D = stage(pageLogic(), {
      overview: { zone: 'UTC', day: '2026-10-22', unpriced: { 'm-x': 2 } },
      ledger: {
        configured: true,
        status: {
          halted: { by: 'uat', reason: 'drill', at: ON },
          reconciliation_required: true,
          updated_at: ON,
        },
        entries: [],
        alerts: { entries: [] },
      },
      records: {
        decisions: [
          dec({
            verdict: 'deny',
            ruleId: 'secret',
            context: ctx({ action: 'file.write', callId: 's-today' }),
          }),
          dec({
            at: '2026-09-01T10:00:00.000Z',
            verdict: 'deny',
            ruleId: 'secret',
            context: ctx({ callId: 's-old' }),
          }),
          dec({ verdict: 'deny', ruleId: 'shell-destructive', context: ctx({ callId: 'd1' }) }),
        ],
      },
    });
    assert.ok(D.halt, 'the halt is shown');
    const open = D.blocks.filter((b) => b.open);
    assert.deepEqual(open.map((b) => b.id).sort(), ['ledger', 'm-x', 's-today']);
    assert.equal(
      D.openN,
      open.length,
      'the count is the rows See what to do lists, with no extra one for the halt',
    );
  });

  test('the secret view counts every secret read the guard blocked (F-226)', () => {
    const rows = [
      dec({
        verdict: 'deny',
        ruleId: 'secret',
        context: ctx({ action: 'file.write', callId: 'find', scope: ['/p/app.py'] }),
      }),
      dec({
        verdict: 'deny',
        ruleId: 'protect-secret-files',
        context: ctx({ action: 'secret.read', callId: 'read', scope: ['/p/.env'] }),
      }),
      dec({
        verdict: 'allow',
        ruleId: null,
        context: ctx({ action: 'secret.read', callId: 'read-ok' }),
      }),
      dec({
        by: DOCTOR_BY,
        verdict: 'deny',
        ruleId: 'protect-secret-files',
        context: ctx({ action: 'secret.read', callId: 'doc' }),
      }),
      dec({ verdict: 'deny', ruleId: 'shell-destructive', context: ctx({ callId: 'shell' }) }),
      { at: ON, by: 'cursor', verdict: 'deny', ruleId: 'shell-destructive', policyHash: H }, // no context
    ];
    const w = world({ decisions: rows });
    const { cards } = secretData({ home: w.home });
    assert.deepEqual(cards.map((c) => [c.rule, c.action, c.scope]).sort(), [
      ['protect-secret-files', 'secret.read', ['/p/.env']],
      ['secret', 'file.write', ['/p/app.py']],
    ]);
    // the page keeps v10's meaning: only a Secret found row is type secret and open;
    // a blocked read is a Policy denied record with nothing to do
    const L = pageLogic();
    const D = stage(L, {
      records: { decisions: tailDecisions({ home: w.home }).entries },
      secret: { cards },
    });
    const byId = Object.fromEntries(D.blocks.map((b) => [b.id, b]));
    assert.equal(byId.find.type, 'secret');
    assert.equal(byId.find.open, true);
    assert.equal(byId.read.type, 'deny');
    assert.equal(byId.read.open, false);
    // and the 7-day count counts the finds, the rows its See records link opens
    const expr = renderPage('n', true).match(/const n7=(cards\.filter\(.*?\)\.length);/);
    assert.ok(expr, 'the secret view counts its cards');
    assert.equal(new Function('cards', 'in7', `return ${expr[1]};`)(cards, L.in7), 1);
  });

  test('the agents page says when a hook fails open (F-227)', () => {
    const L = pageLogic();
    const inst = { name: 'claude-code (project)', ok: true, detail: 'installed' };
    L.S.d = {
      agents: {
        checks: [inst, { name: 'claude-code fail-open', ok: true, warn: true, detail: 'fo' }],
      },
    };
    assert.equal(L.hookState('claude-code').failOpen, 'fo');
    L.S.d = {
      agents: { checks: [inst, { name: 'claude-code fail-open', ok: true, detail: 'fo' }] },
    };
    assert.equal(
      L.hookState('claude-code').failOpen,
      null,
      'a check that is not a warning is not shown as one',
    );
    L.S.d = {};
    assert.deepEqual(L.hookState('claude-code'), { on: false, detail: 'Not checked', where: '' });
  });
});

describe('sakk ui console: 7-day chart axis', () => {
  function axisTicks() {
    const page = renderPage('n', true);
    const a = page.indexOf('function axisTicks(');
    assert.ok(a > 0, 'the page builds the chart axis with axisTicks');
    return new Function(`${page.slice(a, page.indexOf('\n', a))}\nreturn axisTicks;`)();
  }

  test('the axis labels are distinct, keep their $, cover the tallest day and fit the margin (F-236)', () => {
    const page = renderPage('n', true);
    assert.ok(page.includes('pl=ax.pad'), 'the chart margin comes from the labels');
    assert.ok(page.includes('t.textContent=ax.labels[i]'), 'the chart prints the axis labels');
    const ticks = axisTicks();
    // from a fraction of a cent (the mock calls in the 2026-11-02 acceptance) to thousands of dollars
    for (const max of [0.00000012, 0.00005, 0.0003, 0.0123, 0.43, 7.5, 99.99, 1234]) {
      const { top, labels, pad } = ticks(max);
      assert.equal(new Set(labels).size, 5, `${max}: ${labels.join(' ')} has two labels alike`);
      assert.ok(top >= max, `${max}: the tallest day fits under ${top}`);
      labels.forEach((s, i) => {
        assert.match(s, /^\$\d+\.\d{2,}$/, `${max}: ${s} keeps its $ and decimals`);
        assert.ok(
          Math.abs(Number(s.slice(1)) - (top * i) / 4) < 1e-9,
          `${max}: ${s} is drawn at its value`,
        );
      });
      const widest = Math.max(...labels.map((s) => s.length));
      // right-aligned at pad - 4; a 10px monospace character is about 6px wide
      assert.ok(pad - 4 >= widest * 6.2, `${max}: ${widest} characters fit in ${pad - 4}px`);
    }
  });
});

describe('sakk ui console: money amounts', () => {
  function usd() {
    const page = renderPage('n', true);
    const a = page.indexOf('function usd(');
    assert.ok(a > 0, 'the page formats money with usd');
    return new Function(`${page.slice(a, page.indexOf('\n', a))}\nreturn usd;`)();
  }
  test('a spend above zero never prints as $0.0000 and keeps the old formats elsewhere (F-237)', () => {
    const fmt = usd();
    for (const v of [0.0000494, 0.00005, 0.000025, 0.00000012, -0.00003, 1e-10]) {
      const s = fmt(v);
      assert.match(s, /^\$-?\d+\.\d+$/, `${v} prints as a plain amount: ${s}`);
      assert.notEqual(Number(s.replace('$', '')), 0, `${v} does not print as zero: ${s}`);
      const rel = Math.abs(Number(s.replace('$', '')) - v) / Math.abs(v);
      assert.ok(rel < 0.06, `${v} prints within 6%: ${s}`);
    }
    assert.equal(fmt(0), '$0.00');
    assert.equal(fmt(0.0007), '$0.0007');
    assert.equal(fmt(0.43), '$0.4300');
    assert.equal(fmt(7.5), '$7.50');
    assert.equal(fmt(1234), '$1234.00');
    assert.equal(fmt(null), '—');
    assert.equal(fmt(Number.NaN), '—');
  });
});

describe('sakk ui console: spend-of-cap figures', () => {
  test('the cap sits in its own smaller unbreakable span on both cards (F-238)', () => {
    const page = renderPage('n', true);
    const a = page.indexOf('function kpiOf(');
    assert.ok(a > 0, 'the page builds spend-of-cap figures with kpiOf');
    // a stand-in for the page's $() helper: records tag, attributes and children
    const el = (t, at = {}, ...k) => ({ t, at, k });
    const kpiOf = new Function('$', `${page.slice(a, page.indexOf('\n', a))}\nreturn kpiOf;`)(el);
    const v = kpiOf('$0.000050', '$1.00');
    assert.equal(v.t, 'div');
    assert.equal(v.at.class, 'v');
    assert.equal(v.k[0], '$0.000050', 'the amount stays the large figure');
    const of = v.k[v.k.length - 1];
    assert.equal(of.t, 'span');
    assert.equal(of.at.class, 'of');
    assert.equal(of.at.text, '/ $1.00', 'the cap keeps its slash');
    assert.equal(kpiOf('—', 'no cap').k[2].at.text, '/ no cap');
    assert.ok(page.includes('kpiOf(counted?usd(ov.spend_usd)'), 'the Today card uses kpiOf');
    assert.ok(
      page.includes('kpiOf(usd(s.committed_usd),usd(s.cap_usd))'),
      'the ledger card uses kpiOf',
    );
    assert.ok(!page.includes('" / "+usd(s.cap_usd)'), 'no card joins amount and cap in one string');
    const rule = page.match(/\.kpi \.v \.of\{([^}]*)\}/);
    assert.ok(rule, 'the cap has its own style');
    assert.match(rule[1], /white-space:nowrap/, 'the cap never breaks inside');
    assert.match(rule[1], /font-size:\.\d+em/, 'the cap is smaller than the amount');
    assert.match(
      page,
      /\.kpi \.v\{[^}]*overflow-wrap:anywhere/,
      'a very long amount wraps inside its card',
    );
    // on a phone a card's content is about 132px; a 9-character amount like $0.000050 in a
    // monospace face at 0.6em per character must fit whole, so the figure scales with its card
    assert.match(page, /\.kpi\{container-type:inline-size\}/, 'each KPI card is a size container');
    const size = page.match(/\.kpi \.v\{font-size:clamp\((\d+)px,(\d+)cqi,(\d+)px\)/);
    assert.ok(size, 'the figure size follows the card width');
    const [, lo, cqi, hi] = size.map(Number);
    assert.equal(hi, 26, 'a wide card keeps the design size');
    const at = (w) => Math.min(hi, Math.max(lo, (w * cqi) / 100));
    assert.ok(9 * 0.6 * at(132) <= 132, `$0.000050 fits a 132px phone card at ${at(132)}px`);
  });
});
