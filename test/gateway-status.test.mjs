import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gatewayStatus,
  gatewayStatusPathFor,
  gatewayView,
  probeGateway,
  GATEWAY_STATUS_MAX_BYTES,
  DEFAULT_GATEWAY_URL,
} from '../src/gateway-status.mjs';
import { initLedger } from '../src/ledger.mjs';

/**
 * The gateway's outage record as `sakk status` and the console read it
 * (integrations/litellm/README.md "When Sakk cannot answer"). The file is
 * written by the Python gateway; these tests write it by hand, including in
 * shapes the gateway never writes, because anyone who can write the folder can.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A temp HOME with a ledger, so no real ~/.sakk is ever read. */
function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gateway-status-')));
  const home = join(base, '.sakk');
  mkdirSync(home, { recursive: true });
  const ledgerPath = join(base, 'ledger.json');
  initLedger({ ledgerPath, capUsd: 100 });
  const env = { ...process.env, HOME: base, SAKK_HOME: home };
  delete env.SAKK_GATEWAY_STATUS;
  delete env.SAKK_GATEWAY_URL;
  delete env.SAKK_LEDGER_PATH;
  return { base, home, ledgerPath, env, statusPath: `${ledgerPath}.gateway.json` };
}

const OUTAGE = {
  since: '2026-11-02T06:02:11.408Z',
  allowed_calls: 3,
  est_max_unrecorded_usd: 0.004213,
  last_reason: 'sakk_reserve: TimeoutError: ',
  last_at: '2026-11-02T06:09:58.120Z',
};
const doc = (over = {}) => ({
  version: 1,
  updatedAt: '2026-11-02T06:10:00.000Z',
  mode: 'allow',
  outage: null,
  last_outage: null,
  ...over,
});
const put = (path, d) => writeFileSync(path, typeof d === 'string' ? d : JSON.stringify(d));

function cli(w, ...args) {
  return spawnSync(
    process.execPath,
    [join(ROOT, 'bin', 'sakk.mjs'), 'status', ...args, '--ledger', w.ledgerPath],
    { encoding: 'utf8', env: w.env, cwd: w.base },
  );
}

/** A local HTTP server whose handler the test chooses; closes every socket. */
async function server(handler) {
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${s.address().port}`,
    close: () =>
      new Promise((r) => {
        s.closeAllConnections?.();
        s.close(() => r());
      }),
  };
}

describe('gateway status file: read, never trusted blindly', () => {
  test('no status file reads as null, never as a healthy gateway', () => {
    const w = world();
    assert.equal(gatewayStatus({ ledgerPath: w.ledgerPath, env: w.env }), null);
    // nothing to locate it by: null, not a guess
    assert.equal(gatewayStatus({ env: {} }), null);
    // the same path rule as status_path_for in sakk_gateway.py
    assert.equal(gatewayStatusPathFor(w.ledgerPath, {}), w.statusPath);
    const elsewhere = join(w.base, 'elsewhere.json');
    assert.equal(gatewayStatusPathFor(w.ledgerPath, { SAKK_GATEWAY_STATUS: elsewhere }), elsewhere);
    put(elsewhere, doc({ outage: OUTAGE }));
    // the default path is still empty; the override finds the file
    assert.equal(gatewayStatus({ ledgerPath: w.ledgerPath, env: {} }), null);
    const got = gatewayStatus({
      ledgerPath: w.ledgerPath,
      env: { SAKK_GATEWAY_STATUS: elsewhere },
    });
    assert.equal(got.path, elsewhere);
    assert.equal(got.outage.allowed_calls, 3);
  });

  test('a relative ledger path, or one through a linked folder, names the file the gateway writes', () => {
    // status_path_for in sakk_gateway.py resolves the folder the same way;
    // test_u7 in integrations/litellm/test_sakk_gateway.py checks that side
    // with the same four shapes.
    const w = world();
    const linked = join(w.base, 'linked');
    symlinkSync(w.base, linked, 'dir');
    put(w.statusPath, doc({ outage: OUTAGE }));
    const shapes = [
      w.ledgerPath,
      relative(process.cwd(), w.ledgerPath),
      join(linked, 'ledger.json'),
      relative(process.cwd(), join(linked, 'ledger.json')),
    ];
    for (const p of shapes) {
      assert.equal(gatewayStatusPathFor(p, {}), w.statusPath, p);
      const got = gatewayStatus({ ledgerPath: p, env: {} });
      assert.equal(got?.path, w.statusPath, p);
      assert.equal(got.outage.allowed_calls, 3, p);
    }
    // the CLI, given the ledger through the linked folder, reads the same file
    const r = spawnSync(
      process.execPath,
      [
        join(ROOT, 'bin', 'sakk.mjs'),
        'status',
        '--json',
        '--ledger',
        join('linked', 'ledger.json'),
      ],
      { encoding: 'utf8', env: w.env, cwd: w.base },
    );
    assert.equal(JSON.parse(r.stdout).gateway?.outage?.allowed_calls, 3, r.stderr);
  });

  test('a well-formed status file is read field by field, nothing else', () => {
    const w = world();
    const ended = { ...OUTAGE, allowed_calls: 1, ended_at: '2026-11-01T09:00:00.000Z' };
    put(w.statusPath, doc({ outage: { ...OUTAGE, extra: 'x' }, last_outage: ended, junk: 1 }));
    const got = gatewayStatus({ ledgerPath: w.ledgerPath, env: w.env });
    assert.deepEqual(got, {
      path: w.statusPath,
      source: 'from the gateway status file',
      version: 1,
      updatedAt: '2026-11-02T06:10:00.000Z',
      mode: 'allow',
      outage: OUTAGE,
      last_outage: ended,
    });
  });

  test('a broken, oversized or linked status file is a typed error, not a healthy gateway', () => {
    const w = world();
    const read = () => gatewayStatus({ ledgerPath: w.ledgerPath, env: w.env });
    const bad = [
      '{not json',
      '[]',
      doc({ version: 2 }),
      doc({ updatedAt: 5 }),
      doc({ mode: 'sometimes' }),
      doc({ outage: { ...OUTAGE, allowed_calls: -1 } }),
      doc({ outage: { ...OUTAGE, allowed_calls: '3' } }),
      doc({ outage: { ...OUTAGE, est_max_unrecorded_usd: Number.NaN } }),
      doc({ outage: { ...OUTAGE, since: null } }),
      doc({ outage: 'down' }),
      doc({ last_outage: OUTAGE }), // an ended outage without ended_at
    ];
    for (const d of bad) {
      put(w.statusPath, d);
      const got = read();
      assert.equal(got?.error, 'GATEWAY_STATUS_INVALID', JSON.stringify(d));
      assert.equal(got.outage, undefined, 'an error carries no outage figures');
    }
    // over the cap: refused by size before it is parsed
    put(w.statusPath, ' '.repeat(GATEWAY_STATUS_MAX_BYTES + 1));
    assert.equal(read().error, 'GATEWAY_STATUS_TOO_BIG');
    put(w.statusPath, doc({ outage: OUTAGE }));
    assert.equal(
      gatewayStatus({ ledgerPath: w.ledgerPath, env: w.env, maxBytes: 16 }).error,
      'GATEWAY_STATUS_TOO_BIG',
    );
    // a link planted at the path is not followed, even to a valid file
    const real = join(w.base, 'real.json');
    put(real, doc({ outage: OUTAGE }));
    const linked = join(w.base, 'linked.json');
    symlinkSync(real, linked);
    const viaLink = gatewayStatus({ env: { SAKK_GATEWAY_STATUS: linked } });
    assert.equal(viaLink.error, 'GATEWAY_STATUS_UNREADABLE');
    assert.equal(viaLink.outage, undefined);
    // a directory is not a status file
    const dir = join(w.base, 'a-dir');
    mkdirSync(dir);
    assert.equal(
      gatewayStatus({ env: { SAKK_GATEWAY_STATUS: dir } }).error,
      'GATEWAY_STATUS_UNREADABLE',
    );
  });
});

describe('gateway health probe', () => {
  test('probeGateway reports a gateway that does not answer', async () => {
    // the default is LiteLLM's own default port, on loopback
    assert.equal(DEFAULT_GATEWAY_URL, 'http://127.0.0.1:4000');
    const paths = [];
    const up = await server((req, res) => {
      paths.push(req.url);
      res.writeHead(200).end('"I\'m alive!"');
    });
    const sick = await server((req, res) => res.writeHead(503).end());
    const hung = await server(() => {}); // accepts, never answers
    try {
      assert.deepEqual(await probeGateway({ url: up.url }), { url: up.url, ok: true, status: 200 });
      assert.deepEqual(await probeGateway({ url: `${up.url}/` }), {
        url: `${up.url}/`,
        ok: true,
        status: 200,
      });
      assert.deepEqual(paths, ['/health/liveliness', '/health/liveliness']);
      assert.deepEqual(await probeGateway({ url: sick.url }), {
        url: sick.url,
        ok: false,
        status: 503,
      });
      // a gateway that never answers is reported, not waited on forever
      assert.deepEqual(await probeGateway({ url: hung.url, timeoutMs: 50 }), {
        url: hung.url,
        ok: false,
        error: 'timeout',
      });
    } finally {
      await Promise.all([up.close(), sick.close(), hung.close()]);
    }
    // nothing listens any more: the refusal is reported
    const gone = await probeGateway({ url: up.url });
    assert.equal(gone.ok, false);
    assert.equal(gone.error, 'ECONNREFUSED');
    // only http and https are probed
    for (const url of ['file:///etc/passwd', 'ftp://127.0.0.1/', 'not a url'])
      assert.deepEqual(await probeGateway({ url }), {
        url,
        ok: false,
        error: 'GATEWAY_URL_INVALID',
      });
  });

  test('gatewayView probes only with a status file, at most once per window', async () => {
    const w = world();
    let t = 1_000_000;
    const probes = [];
    const probe = ({ url }) => {
      probes.push(url);
      return Promise.resolve({ url, ok: false, error: 'ECONNREFUSED' });
    };
    const env = { ...w.env, SAKK_GATEWAY_URL: 'http://127.0.0.1:1' };
    const view = gatewayView({ ledgerPath: w.ledgerPath, env, now: () => t, probe });
    // no status file: no gateway in use, no probe, no banner data
    assert.deepEqual(await view(), {
      source: 'from the gateway status file',
      status: null,
      probe: null,
    });
    assert.equal(probes.length, 0);
    put(w.statusPath, doc({ outage: OUTAGE }));
    const first = await view();
    assert.equal(first.status.outage.allowed_calls, 3);
    assert.deepEqual(first.probe, { url: 'http://127.0.0.1:1', ok: false, error: 'ECONNREFUSED' });
    await view();
    t += 4999;
    await view();
    assert.equal(probes.length, 1, 'page loads inside the window share one probe');
    t += 1;
    await view();
    assert.equal(probes.length, 2, 'the window ended, so the next load probes again');
    // the status file is re-read every time; only the probe is cached
    put(w.statusPath, doc());
    assert.equal((await view()).status.outage, null);
    assert.equal(probes.length, 2);
  });
});

describe('sakk status: the gateway line', () => {
  test('sakk status --json carries the gateway key, null without a status file', () => {
    const w = world();
    const none = cli(w, '--json');
    assert.equal(none.status, 0, none.stderr);
    assert.ok(Object.hasOwn(JSON.parse(none.stdout), 'gateway'));
    assert.equal(JSON.parse(none.stdout).gateway, null);
    put(w.statusPath, doc({ outage: OUTAGE }));
    const out = cli(w, '--json');
    // an outage is reported, not turned into a failing exit
    assert.equal(out.status, 0, out.stderr);
    const g = JSON.parse(out.stdout).gateway;
    assert.equal(g.path, w.statusPath);
    assert.deepEqual(g.outage, OUTAGE);
    assert.equal(g.last_outage, null);
    assert.equal(g.mode, 'allow');
    put(w.statusPath, '{broken');
    const broken = cli(w, '--json');
    assert.equal(broken.status, 0, broken.stderr);
    assert.equal(JSON.parse(broken.stdout).gateway.error, 'GATEWAY_STATUS_INVALID');
  });

  test('sakk status prints the outage line, with hostile text escaped', () => {
    const w = world();
    const quiet = cli(w);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.doesNotMatch(quiet.stdout, /^gateway/m, 'no status file, no gateway line');
    put(w.statusPath, doc());
    assert.match(cli(w).stdout, /^gateway {5}no outage recorded \(mode allow\)$/m);
    put(
      w.statusPath,
      doc({ outage: { ...OUTAGE, last_reason: 'boom\u001b[2J\nfake line\u2028' } }),
    );
    const down = cli(w);
    assert.equal(down.status, 0, down.stderr);
    assert.match(
      down.stdout,
      /^gateway {5}⚠ SAKK UNREACHABLE since 2026-11-02T06:02:11\.408Z: 3 call\(s\) let through unmetered, up to \$0\.004213 not in this ledger/m,
    );
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(down.stdout, /\u001b|\u2028/);
    assert.match(down.stdout, /boom\\x1b\[2J\\x0afake line\\u2028/);
    assert.doesNotMatch(down.stdout, /^fake line/m);
    put(
      w.statusPath,
      doc({ mode: 'deny', outage: { ...OUTAGE, allowed_calls: 0, est_max_unrecorded_usd: 0 } }),
    );
    const deny = cli(w);
    assert.equal(deny.status, 0, deny.stderr);
    assert.match(
      deny.stdout,
      /^gateway {5}⚠ SAKK UNREACHABLE since 2026-11-02T06:02:11\.408Z: deny mode, calls refused with HTTP 503; 0 call\(s\) let through unmetered earlier/m,
    );
    const ended = { ...OUTAGE, ended_at: '2026-11-02T06:20:00.000Z' };
    put(w.statusPath, doc({ last_outage: ended }));
    assert.match(
      cli(w).stdout,
      /^gateway {5}no outage now; last one 2026-11-02T06:02:11\.408Z to 2026-11-02T06:20:00\.000Z: 3 call\(s\) unmetered/m,
    );
  });
});
