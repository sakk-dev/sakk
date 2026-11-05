// SPDX-License-Identifier: Apache-2.0
//
// `sakk ui` — a local, read-only console (open-source v1, M4; specs/console/).
// It listens on loopback only, gates every request on a fresh 128-bit token,
// and shows only what M1–M3 recorded, through the same functions the CLI uses
// (contract #3). The one write is stopping an agent, behind --allow-halt.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openSync, fstatSync, readSync, closeSync, lstatSync, constants as FS } from 'node:fs';
import { userInfo, homedir } from 'node:os';
import { join } from 'node:path';
import { URLSearchParams } from 'node:url';
import { PASSWORD_MAX, USERNAME_MAX, createLoginGate, loadConsoleLogin } from './console-login.mjs';

import {
  DOCTOR_BY,
  sakkHome,
  readConfig,
  repoRootOf,
  choosePolicy,
  evaluate,
  normalize,
} from './hook.mjs';
import { loadPrices } from './prices.mjs';
import { gatewayStatus, gatewayView } from './gateway-status.mjs';
import { daySpend, systemZone, dayOf, SpendError } from './spend.mjs';
import { doctor } from './guard-install.mjs';
import { halt, LedgerError, readLedger, ledgerStatus, alertsPathFor } from './ledger.mjs';

export class ConsoleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ConsoleError';
  }
}

// A decision line is bounded (M1 caps every context string), so the last page
// of the log lives in a bounded tail: a 5 GB file is never loaded whole.
export const TAIL_BYTES = 1024 * 1024; // read at most this from the end
export const PAGE_LINES = 500; // show at most this many, newest first
export const MAX_QUERY = 8 * 1024; // a request line over this is refused (input-space)
export const LOGIN_BODY_CAP = 2048; // a sign-in body over this is refused before it is read
// The hot ledger holds at most SEAL_AT settled plus MAX_INFLIGHT outstanding
// entries (a few MB); a file far past that is refused before it is read.
export const LEDGER_VIEW_BYTES = 32 * 1024 * 1024;
const TOKEN_BYTES = 16; // 128-bit

const token = () => randomBytes(TOKEN_BYTES).toString('hex');

/** Constant-time token check; a missing or wrong-length token still compares. */
export function tokenOk(given, want) {
  const b = Buffer.from(want);
  if (typeof given !== 'string' || Buffer.byteLength(given) !== b.length) {
    timingSafeEqual(b, b); // keep the timing flat on the reject path
    return false;
  }
  return timingSafeEqual(Buffer.from(given), b);
}

const hostOk = (host, port) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;
const originOk = (origin, port) =>
  origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;

function parseCookie(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * The last page of the decision log, newest first, read from the end within a
 * byte cap. Returns the parsed entries plus the counters a test asserts on:
 * `scannedBytes` (<= TAIL_BYTES however big the file) and `unreadable`.
 */
export function tailDecisions({ home, limit = PAGE_LINES, cap = TAIL_BYTES }) {
  const tail = tailJsonl(join(home, 'decisions.jsonl'), { limit, cap });
  // a line that parses but is not a record (null, a number, a list) is unreadable, as in the alerts log
  const entries = tail.entries.filter(
    (d) => d !== null && typeof d === 'object' && !Array.isArray(d),
  );
  return {
    entries,
    scannedBytes: tail.scannedBytes,
    unreadable: tail.unreadable + tail.entries.length - entries.length,
    truncated: tail.truncated,
  };
}

/**
 * The last `limit` lines of a JSON-lines log, newest first, read from the end
 * within `cap` bytes. A missing file is `present: false`; a path that is not a
 * regular file (a fifo would block a plain open forever) is skipped as
 * `notAFile: true`, never read. `noFollow` refuses a symlink the same way.
 */
export function tailJsonl(path, { limit = PAGE_LINES, cap = TAIL_BYTES, noFollow = false } = {}) {
  const none = { entries: [], scannedBytes: 0, unreadable: 0, truncated: false };
  let fd;
  try {
    fd = openSync(path, FS.O_RDONLY | FS.O_NONBLOCK | (noFollow ? FS.O_NOFOLLOW : 0));
  } catch (e) {
    if (e?.code === 'ENOENT') return { ...none, present: false };
    if (e?.code === 'ELOOP') return { ...none, present: true, notAFile: true };
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ...none, present: true, notAFile: true };
    const size = st.size;
    const start = size > cap ? size - cap : 0;
    const len = size - start;
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const text = buf.subarray(0, read).toString('utf8');
    // if we began mid-file, the first line is a fragment of an earlier record
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    let unreadable = 0;
    const entries = [];
    for (const line of lines) {
      if (line === '') continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        unreadable += 1;
      }
    }
    entries.reverse(); // newest first
    return {
      entries: entries.slice(0, limit),
      scannedBytes: read,
      unreadable,
      truncated: start > 0 || entries.length > limit,
      present: true,
    };
  } finally {
    closeSync(fd);
  }
}

// What the page may show of a ledger entry or an alert: these fields, and
// only plain values (a nested object in a hostile file is dropped, not shown).
const ENTRY_FIELDS = [
  'callId',
  'agentId',
  'runId',
  'taskId',
  'status',
  'estimatedMaxUsd',
  'actualUsd',
  'createdAt',
  'settledAt',
];
const ALERT_FIELDS = [
  'at',
  'kind',
  'scope',
  'callId',
  'agentId',
  'estimatedMaxUsd',
  'committedUsd',
  'capUsd',
  'by',
  'reason',
];
const plain = (v) =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const pick = (o, fields) => {
  const out = {};
  for (const f of fields) out[f] = plain(o?.[f]) ? o[f] : null;
  return out;
};
const timeOf = (s) => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
};

/**
 * The spend ledger as the console shows it: the same status object as
 * `sakk status --json` (one function, ledgerStatus), the newest entries, and
 * the alert trail beside the ledger. Read-only: readLedger and a read-only
 * open of the alerts file, never reserve, settle or halt. The path is the one
 * the console was started with — a request cannot choose another file.
 */
export function ledgerData({
  ledgerPath,
  env = process.env,
  now = Date.now(),
  limit = PAGE_LINES,
  maxBytes = LEDGER_VIEW_BYTES,
}) {
  const source = 'from the ledger';
  if (!ledgerPath)
    return {
      configured: false,
      source,
      note: 'No ledger is set — start with --ledger <path> or set ledgerPath in ~/.sakk/config.json',
    };
  let st = null;
  try {
    st = lstatSync(ledgerPath);
  } catch {
    // missing or unreachable: readLedger names it (LEDGER_MISSING / _UNREADABLE)
  }
  if (st?.isFile() && st.size > maxBytes)
    return {
      configured: true,
      ledger: ledgerPath,
      source,
      error: 'CONSOLE_LEDGER_TOO_BIG',
      message: `the ledger is ${st.size} bytes, over the ${maxBytes}-byte view limit — not read; use sakk status`,
    };
  let doc;
  try {
    doc = readLedger({ ledgerPath, maxAgeMs: Number.POSITIVE_INFINITY, now });
  } catch (e) {
    if (!(e instanceof LedgerError)) throw e;
    return { configured: true, ledger: ledgerPath, source, error: e.code, message: e.message };
  }
  // newest first; reversed before the stable sort so calls in the same millisecond
  // still list the later one first
  const sorted = [...doc.entries]
    .reverse()
    .sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
  const alertsPath = alertsPathFor(ledgerPath);
  const tail = tailJsonl(alertsPath, { limit, noFollow: true });
  let unreadable = tail.unreadable;
  const alerts = [];
  for (const a of tail.entries) {
    if (a === null || typeof a !== 'object' || Array.isArray(a)) unreadable += 1;
    else alerts.push(pick(a, ALERT_FIELDS));
  }
  return {
    configured: true,
    source,
    // the same object as `sakk status --json`, gateway key included
    status: {
      ...ledgerStatus({ ledgerPath, doc, now }),
      gateway: gatewayStatus({ ledgerPath, env }),
    },
    entries: sorted.slice(0, limit).map((e) => pick(e, ENTRY_FIELDS)),
    entries_total: doc.entries.length,
    truncated: doc.entries.length > limit,
    archive: doc.archive
      ? { settledCount: doc.archive.settledCount ?? 0, settledUsd: doc.archive.settledUsd ?? 0 }
      : null,
    alerts: {
      source: 'from the alerts log',
      path: alertsPath,
      note: 'shared by every ledger in this folder',
      present: tail.present === true && tail.notAFile !== true,
      skipped: tail.notAFile === true ? 'not a regular file' : null,
      entries: alerts,
      unreadable,
      truncated: tail.truncated,
    },
  };
}

/** The policy the hook would use for `cwd` — the same resolution as `sakk try`. */
export function policyInUse({ cwd, home }) {
  const chosen = choosePolicy({ repoRoot: repoRootOf(cwd), home, keep: false });
  return {
    policyPath: chosen.policyPath,
    policyHash: chosen.loaded?.policyHash ?? null,
    rules: chosen.loaded?.policy?.rules ?? [],
    defaultVerdict: chosen.loaded?.policy?.default_verdict ?? null,
    broken: chosen.unknown ? (chosen.unknown.code ?? 'HOOK_FAILED') : null,
    fallback: chosen.fallback
      ? { from: chosen.fallback.local, savedAt: chosen.fallback.savedAt }
      : null,
  };
}

// --- the data each page shows, from M1-M3's own functions (contract #3) ---

export function overviewData({ home, now = Date.now() }) {
  const config = readConfig(home);
  const { table } = loadPrices({ home });
  const zone = config.timeZone || systemZone();
  const day = dayOf(now, zone);
  let spend;
  try {
    // read-only: the hook maintains the spend index; the console only reads it,
    // so a GET never writes (M4 review). Spend is current whenever a cap is set.
    spend = daySpend({ home, day, table });
  } catch (e) {
    if (!(e instanceof SpendError)) throw e;
    spend = { day, usd: 0, calls: 0, unpriced: {}, unreadable: 0, byModel: {}, error: e.code };
  }
  // when the index was last counted: updateIndex rewrites files.json on every
  // count. A day never counted has no day file, which reads as $0 — so the
  // page shows today's figure only once it has been counted today (F-231)
  let indexedAt = null;
  try {
    indexedAt = lstatSync(join(home, 'spend', 'files.json')).mtimeMs;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const recent = tailDecisions({ home, limit: 50 });
  // the doctor's own probe is no agent's action: kept in records, left out of the feed (F-229)
  const agentRows = recent.entries.filter((d) => d && d.by !== DOCTOR_BY);
  const counts = { allow: 0, deny: 0, require_approval: 0 };
  for (const d of agentRows) if (d.verdict in counts) counts[d.verdict] += 1;
  return {
    source: 'from local logs', // never billed (F-126 / evidence label)
    day,
    zone,
    cap_usd: config.capUsd ?? null,
    spend_usd: spend.usd,
    calls: spend.calls,
    by_model: spend.byModel,
    unpriced: spend.unpriced,
    unreadable_spend: spend.unreadable,
    indexed_at: indexedAt === null ? null : new Date(indexedAt).toISOString(),
    counted_today: indexedAt !== null && dayOf(indexedAt, zone) === day,
    recent: agentRows.slice(0, 20),
    recent_counts: counts,
  };
}

export function secretData({ home }) {
  const tail = tailDecisions({ home, limit: PAGE_LINES });
  // a secret found in what an agent wrote, and a secret file an agent tried to read (F-226)
  const cards = tail.entries
    .filter(
      (d) =>
        d?.by !== DOCTOR_BY &&
        (d?.ruleId === 'secret' || (d?.verdict === 'deny' && d?.context?.action === 'secret.read')),
    )
    .map((d) => ({
      at: d.at ?? null,
      agent: d.by ?? null,
      rule: d.ruleId ?? null,
      action: d.context?.action ?? null,
      scope: d.context?.scope ?? null,
    }));
  return { note: 'A secret block records the rule and a fingerprint, never the value.', cards };
}

export function pricesData({ home }) {
  const { table, path } = loadPrices({ home });
  const models = Object.entries(table.models ?? table).map(([id, m]) => ({ id, ...m }));
  return { source: path, approximate: Boolean(table.approximate), count: models.length, models };
}

export function tryData({ cwd, home, env = process.env, command }) {
  if (typeof command !== 'string' || command === '')
    throw new ConsoleError('CONSOLE_TRY_EMPTY', 'try needs a command');
  const r = evaluate(
    normalize('claude-code', {
      hook_event_name: 'PreToolUse',
      cwd,
      session_id: 'sakk-ui',
      tool_use_id: `ui-${Date.now()}`,
      tool_name: 'Bash',
      tool_input: { command },
    }),
    { env, log: false }, // read-only: nothing is written
  );
  return {
    verdict: r.verdict,
    reason: r.reason,
    policyPath: r.policyPath,
    policyHash: r.policyHash,
    decisions: r.decisions.map((d) => ({
      action: d.context.action,
      scope: d.context.scope ?? null,
      verdict: d.verdict,
      rule: d.ruleId,
    })),
  };
}

/**
 * The console server. Binds 127.0.0.1 only. Resolves once listening with the
 * address, the token and a close(). `port: 0` takes a random free port.
 */
export function startConsole({
  port = 0,
  allowHalt = false,
  cwd = process.cwd(),
  home = sakkHome(),
  ledgerPath = process.env.SAKK_LEDGER_PATH || null,
  env = process.env,
  now = Date.now,
  log = (line) => process.stderr.write(`sakk ui: ${line}\n`),
} = {}) {
  const tok = token();
  const state = { forbidden: 0 };
  const gateway = gatewayView({ ledgerPath, env, now });
  // opt-in sign-in: no credential file, no sign-in, the console is token-only as before;
  // a file that cannot be trusted refuses the start (CONSOLE_LOGIN_UNSAFE / _INVALID)
  let gate = null;
  try {
    const rec = loadConsoleLogin({ home });
    if (rec) gate = createLoginGate({ rec, now, log });
  } catch (e) {
    return Promise.reject(e);
  }
  let bound = port;
  const headers = (nonce) => ({
    // non-HTML responses carry no script/style, so their CSP allows none at all
    'Content-Security-Policy': `default-src 'none'; script-src ${nonce ? `'self' 'nonce-${nonce}'` : "'none'"}; style-src ${nonce ? `'self' 'nonce-${nonce}'` : "'none'"}; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store', // tokens and log data never land in a shared cache
  });
  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, ...headers(''), ...extra });
    res.end(body);
  };
  const json = (res, obj, status = 200) =>
    send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
  const forbid = (res) => {
    state.forbidden += 1;
    send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
  };

  const server = createServer((req, res) => {
    try {
      // 1. a request line over the cap never reaches a handler
      if (req.url.length > MAX_QUERY) return send(res, 414, 'text/plain', 'request too long');
      const url = new URL(req.url, `http://127.0.0.1:${bound}`);
      // 2. Host must be our loopback address (blocks DNS rebinding)
      if (!hostOk(req.headers.host, bound)) return forbid(res);
      // 2b. a cross-site Origin is refused on EVERY route, GET included, before
      // dispatch — one gate for current and future routes (F-195). An absent
      // Origin (typed URL, curl, same-origin GET) stays allowed; the halt write
      // below still requires the Origin to be present.
      if (req.headers.origin !== undefined && !originOk(req.headers.origin, bound))
        return forbid(res);
      // 3. the token, from the first-load query or the cookie after that — or,
      // when a password is set, a live session from POST /login
      const path = url.pathname;
      const fromQuery = url.searchParams.get('t');
      const cookies = parseCookie(req.headers.cookie);
      const cookie = cookies.sakk_t;
      if (gate && req.method === 'POST' && (path === '/login' || path === '/logout'))
        return signInOut(req, res, path, cookies.sakk_s);
      if (!tokenOk(fromQuery, tok) && !tokenOk(cookie, tok) && !gate?.sessionOk(cookies.sakk_s)) {
        // the sign-in page is a GET: it writes nothing and sets no cookie
        if (gate && req.method === 'GET' && path === '/') {
          const nonce = randomBytes(16).toString('base64');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers(nonce) });
          return res.end(renderLoginPage(nonce));
        }
        return forbid(res);
      }
      if (req.method === 'GET' && path === '/') {
        const nonce = randomBytes(16).toString('base64');
        const extra = {};
        // promote a valid query token to a strict, http-only cookie
        if (tokenOk(fromQuery, tok))
          extra['Set-Cookie'] = `sakk_t=${tok}; Path=/; SameSite=Strict; HttpOnly`;
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          ...headers(nonce),
          ...extra,
        });
        return res.end(renderPage(nonce, allowHalt, Boolean(gate)));
      }
      if (req.method === 'GET' && path.startsWith('/api/')) {
        const name = path.slice(5);
        if (name === 'overview') return json(res, overviewData({ home, env }));
        if (name === 'rules') return json(res, policyInUse({ cwd, home }));
        if (name === 'secret') return json(res, secretData({ home }));
        if (name === 'agents')
          return json(res, {
            allowHalt,
            haltReady: Boolean(ledgerPath),
            checks: doctor({ cwd, home: env.HOME || homedir(), env, probe: false }),
          });
        // the path is the one the console started with; the request cannot pick a file
        if (name === 'ledger') return json(res, ledgerData({ ledgerPath, env }));
        // the probe is bounded (500 ms) and shared for 5 s; it runs only when
        // the gateway has written a status file
        if (name === 'gateway')
          return void gateway().then(
            (d) => json(res, d),
            (e) => json(res, { error: 'CONSOLE_GATEWAY_FAILED', message: String(e?.message ?? e) }),
          );
        if (name === 'prices') {
          try {
            return json(res, pricesData({ home }));
          } catch (e) {
            return json(res, { error: e.code ?? 'PRICES_UNREADABLE', message: String(e.message) });
          }
        }
        if (name === 'records') {
          const tail = tailDecisions({ home, limit: PAGE_LINES });
          return json(res, {
            source: 'decisions from the hook, spend from local logs',
            truncated: tail.truncated,
            unreadable: tail.unreadable,
            decisions: tail.entries,
          });
        }
        if (name === 'try') {
          try {
            return json(res, tryData({ cwd, home, env, command: url.searchParams.get('cmd') }));
          } catch (e) {
            return json(
              res,
              { error: e.code ?? 'CONSOLE_TRY_FAILED', message: String(e.message) },
              400,
            );
          }
        }
        if (name === 'forbidden') return json(res, { forbidden: state.forbidden });
        return send(res, 404, 'text/plain', 'not found');
      }
      if (req.method === 'POST' && path === '/api/halt') {
        if (!allowHalt) return send(res, 405, 'text/plain', 'read-only: start with --allow-halt');
        // a write needs the Origin and the token header too, not just the cookie
        if (!originOk(req.headers.origin, bound) || !tokenOk(req.headers['x-sakk-token'], tok))
          return forbid(res);
        if (!ledgerPath)
          return json(res, { error: 'CONSOLE_NO_LEDGER', message: 'no ledger configured' }, 409);
        return readBody(req, 4096, (body) => {
          let agentId;
          try {
            agentId = JSON.parse(body || '{}').agent;
          } catch {
            return json(res, { error: 'CONSOLE_BAD_BODY' }, 400);
          }
          if (agentId !== undefined && (typeof agentId !== 'string' || agentId === ''))
            return json(res, { error: 'CONSOLE_BAD_AGENT' }, 400);
          try {
            const by = (userInfo().username || 'console').slice(0, 200);
            const r = halt({ ledgerPath, by, reason: 'self-declared via sakk ui', agentId });
            return json(res, {
              halted: true,
              scope: agentId ?? 'all',
              by,
              note: 'self-declared (the OS account name, not a verified identity)',
              already: Boolean(r.alreadyHalted),
            });
          } catch (e) {
            const code = e instanceof LedgerError ? e.code : 'CONSOLE_HALT_FAILED';
            return json(res, { error: code, message: String(e.message) }, 409);
          }
        });
      }
      return send(res, 404, 'text/plain', 'not found');
    } catch {
      try {
        send(res, 500, 'text/plain', 'error');
      } catch {
        /* response already sent */
      }
    }
  });

  const JSON_TYPE = 'application/json; charset=utf-8';
  /** POST /login and /logout: our own Origin, a capped body, one generic refusal. */
  function signInOut(req, res, path, sid) {
    // a write: the Origin must be present and ours, as for the stop route
    if (!originOk(req.headers.origin, bound)) return forbid(res);
    if (path === '/logout') {
      gate.end(sid);
      return send(res, 200, JSON_TYPE, JSON.stringify({ signedOut: true }), {
        'Set-Cookie': [
          'sakk_s=; Path=/; SameSite=Strict; HttpOnly; Max-Age=0',
          'sakk_t=; Path=/; SameSite=Strict; HttpOnly; Max-Age=0',
        ],
      });
    }
    const len = Number(req.headers['content-length'] ?? 0);
    if (!(len <= LOGIN_BODY_CAP))
      return json(res, { error: 'CONSOLE_LOGIN_TOO_BIG', message: 'sign-in body too large' }, 413);
    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (type !== 'application/json' && type !== 'application/x-www-form-urlencoded')
      return json(res, { error: 'CONSOLE_LOGIN_BAD_TYPE', message: 'send JSON or a form' }, 415);
    return readBody(req, LOGIN_BODY_CAP, (body) => {
      let u;
      let p;
      try {
        if (type === 'application/json') ({ username: u, password: p } = JSON.parse(body) ?? {});
        else {
          const f = new URLSearchParams(body);
          u = f.get('username');
          p = f.get('password');
        }
      } catch {
        u = undefined;
      }
      if (typeof u !== 'string' || typeof p !== 'string')
        return json(
          res,
          { error: 'CONSOLE_LOGIN_BAD_BODY', message: 'username and password' },
          400,
        );
      gate.signIn(u, p).then(
        (r) => {
          if (r.locked)
            return send(
              res,
              429,
              JSON_TYPE,
              JSON.stringify({
                error: 'CONSOLE_LOGIN_LOCKED',
                retryAfter: r.retryAfter,
                message: `Too many failed sign-ins. Try again in ${Math.ceil(r.retryAfter / 60)} min, or open the address sakk ui printed.`,
              }),
              { 'Retry-After': String(r.retryAfter) },
            );
          if (r.busy)
            return json(
              res,
              { error: 'CONSOLE_LOGIN_BUSY', message: 'A sign-in is being checked. Try again.' },
              429,
            );
          if (!r.ok)
            return json(
              res,
              { error: 'CONSOLE_LOGIN_FAILED', message: 'Wrong username or password.' },
              401,
            );
          return send(res, 200, JSON_TYPE, JSON.stringify({ signedIn: true }), {
            'Set-Cookie': `sakk_s=${r.id}; Path=/; SameSite=Strict; HttpOnly`,
          });
        },
        () => send(res, 500, 'text/plain', 'error'),
      );
    });
  }

  server.listen(port, '127.0.0.1'); // never 0.0.0.0
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      bound = server.address().port;
      resolve({
        server,
        port: bound,
        token: tok,
        url: `http://127.0.0.1:${bound}/?t=${tok}`,
        address: server.address().address,
        state,
        login: gate,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function readBody(req, cap, cb) {
  let data = '';
  let over = false;
  req.on('data', (c) => {
    data += c;
    if (data.length > cap) {
      over = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (!over) cb(data);
  });
}

// the console's one stylesheet: the tokens and classes both pages use
const PAGE_CSS = `:root{--ground:#f2f4f6;--surface:#ffffff;--sunk:#eef1f4;--ink:#17212b;--muted:#5a6673;--faint:#8a95a1;--rule:#dde2e8;--accent:#0d6b57;--accent-ink:#ffffff;--accent-soft:#e2f2ed;--ok:#1d7a3e;--ok-soft:#e5f3e9;--warn:#9a5a06;--warn-soft:#fbf0dc;--bad:#b3261e;--bad-soft:#fbe9e7;--info:#2f5f9e;--info-soft:#e7eef8;--m1:#0d6b57;--m2:#2f5f9e;--m3:#b27a12;--ent:#6b3fb3;--ent-soft:#f0e9fb;--scrim:rgba(15,22,30,.42);--shadow:0 10px 30px rgba(15,22,30,.16);--font-ui:system-ui,-apple-system,"Segoe UI",sans-serif;--font-num:ui-monospace,"SF Mono",Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#0f1419;--surface:#161d24;--sunk:#1c242c;--ink:#e5eaef;--muted:#9aa6b2;--faint:#6f7b87;--rule:#2a333c;--accent:#4cc3a4;--accent-ink:#0b1a16;--accent-soft:#15322b;--ok:#5cc27e;--ok-soft:#163020;--warn:#e2a64a;--warn-soft:#33270f;--bad:#f08a80;--bad-soft:#3a1c1a;--info:#8db4ea;--info-soft:#1b2a3f;--m1:#4cc3a4;--m2:#8db4ea;--m3:#e2b04a;--ent:#c3a6f2;--ent-soft:#2a2140;--scrim:rgba(0,0,0,.55);--shadow:0 10px 30px rgba(0,0,0,.5);color-scheme:dark}
}
:root[data-theme="dark"]{--ground:#0f1419;--surface:#161d24;--sunk:#1c242c;--ink:#e5eaef;--muted:#9aa6b2;--faint:#6f7b87;--rule:#2a333c;--accent:#4cc3a4;--accent-ink:#0b1a16;--accent-soft:#15322b;--ok:#5cc27e;--ok-soft:#163020;--warn:#e2a64a;--warn-soft:#33270f;--bad:#f08a80;--bad-soft:#3a1c1a;--info:#8db4ea;--info-soft:#1b2a3f;--m1:#4cc3a4;--m2:#8db4ea;--m3:#e2b04a;--ent:#c3a6f2;--ent-soft:#2a2140;--scrim:rgba(0,0,0,.55);--shadow:0 10px 30px rgba(0,0,0,.5);color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);font-family:var(--font-ui);font-size:14px;line-height:1.55;margin:0}
button{font:inherit;color:inherit}
.shell{display:grid;grid-template-columns:220px minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);min-height:100vh}
header.top{grid-column:1 / -1;display:flex;align-items:center;gap:12px;padding-block:10px;padding-inline:18px;background:var(--surface);border-bottom:1px solid var(--rule);position:sticky;top:env(safe-area-inset-top,0px);z-index:20;flex-wrap:wrap}
.brand{font-weight:600;font-size:16px;display:inline-flex;align-items:center;gap:8px}
.brand small{color:var(--faint);font-weight:400;font-size:12px;margin-left:6px}
.proj{padding:4px 10px;border:1px solid var(--rule);border-radius:6px;font-size:13px;color:var(--muted)}
.top .grow{flex:1}
.sample{font-size:12px;color:var(--warn);background:var(--warn-soft);border-radius:999px;padding:2px 10px;border:0;cursor:pointer}
.stopbtn{cursor:pointer;border:1px solid var(--bad);color:var(--bad);background:var(--surface);padding:5px 12px;border-radius:6px;font-size:13px;font-weight:500}
.stopbtn.on{background:var(--bad);color:#fff}
.userchip{display:flex;align-items:center;gap:8px;cursor:pointer;border:1px solid var(--rule);border-radius:999px;padding:3px 10px 3px 4px;background:var(--surface)}
.avatar{width:26px;height:26px;border-radius:50%;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;font-size:12px;font-weight:600;flex:none}
.userchip .r{font-size:12px;color:var(--muted)}
nav.side{background:var(--surface);border-right:1px solid var(--rule);padding-block:14px;padding-inline:10px;display:flex;flex-direction:column;gap:2px;position:sticky;top:57px;height:calc(100vh - 57px);overflow-y:auto}
.grp{font-size:11px;letter-spacing:.08em;color:var(--faint);padding:12px 10px 4px}
.nav{all:unset;cursor:pointer;display:flex;justify-content:flex-start;gap:10px;align-items:center;padding:7px 10px;border-radius:6px;color:var(--muted)}
.nav:hover{background:var(--sunk);color:var(--ink)}
.nav[aria-current="page"]{background:var(--accent-soft);color:var(--accent);font-weight:500}
.nav:focus-visible,.btn:focus-visible,.q:focus-visible,.linkish:focus-visible,.stopbtn:focus-visible,.chk:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.badge{font-family:var(--font-num);font-size:11px;min-width:18px;text-align:center;padding:0 5px;border-radius:9px;background:var(--bad);color:#fff}
main{padding-block:20px 60px;padding-inline:24px;min-width:0}
.ph{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:16px}
.ph h1{font-size:20px;font-weight:600;margin:0}
.ph .acts{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.q{all:unset;cursor:pointer;width:18px;height:18px;border-radius:50%;border:1px solid var(--rule);color:var(--muted);font-size:11px;display:inline-grid;place-items:center;vertical-align:1px;background:var(--surface);flex:none}
.q:hover{color:var(--accent);border-color:var(--accent)}
.btn{cursor:pointer;border:1px solid var(--rule);background:var(--surface);padding:6px 12px;border-radius:6px;font-size:13px;white-space:nowrap}
.btn:hover{border-color:var(--faint)}
.btn.pri{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.danger{background:var(--bad);border-color:var(--bad);color:#fff}
.btn.ghost{border-color:transparent;background:transparent;color:var(--accent);padding-inline:6px}
.btn.sm{padding:3px 10px}
.linkish{all:unset;cursor:pointer;color:var(--accent)}
.grid{display:grid;gap:14px}
.kpis{grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:14px}
.card{background:var(--surface);border:1px solid var(--rule);border-radius:12px;padding:16px 18px;min-width:0;box-shadow:var(--lift);overflow-x:auto}
.card h2{font-size:14.5px;font-weight:600;margin:0 0 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.card + .card{margin-top:14px}
.kpi .l{color:var(--muted);font-size:12px;display:flex;gap:6px;align-items:center}
.kpi .v{font-family:var(--font-num);font-size:24px;font-weight:500;font-variant-numeric:tabular-nums;margin-top:4px}
.kpi .s{color:var(--muted);font-size:12px}
.kpi.alert{border-color:color-mix(in srgb,var(--warn) 45%,var(--rule))}
.bar{height:6px;background:var(--sunk);border-radius:3px;overflow:hidden;margin-top:6px}
.bar i{display:block;height:100%;background:var(--accent)}
.two{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);align-items:start}
.half{grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:8px 10px;border-bottom:1px solid var(--rule);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--rule);vertical-align:top}
tr:last-child td{border-bottom:0}
.num{text-align:right;font-family:var(--font-num);font-variant-numeric:tabular-nums;white-space:nowrap}
.mono{font-family:var(--font-num);font-size:12px;color:var(--muted);white-space:nowrap}
.nw{white-space:nowrap}
tr.click{cursor:pointer}
tr.click:hover td{background:var(--sunk)}
tr.pending td:first-child{box-shadow:inset 3px 0 0 var(--warn)}
.sub{color:var(--muted);font-size:12px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.p-ok{background:var(--ok-soft);color:var(--ok)}
.p-warn{background:var(--warn-soft);color:var(--warn)}
.p-bad{background:var(--bad-soft);color:var(--bad)}
.p-info{background:var(--info-soft);color:var(--info)}
.p-mute{background:var(--sunk);color:var(--muted)}
.tag{display:inline-block;font-size:11px;padding:0 6px;border-radius:4px;border:1px solid var(--rule);color:var(--muted);white-space:nowrap}
.tag.now{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent)}
.tag.todo{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent)}
.tag.man{color:var(--info);border-color:color-mix(in srgb,var(--info) 40%,transparent)}
.chipr{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;background:var(--sunk);margin:0 4px 4px 0;white-space:nowrap}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--rule);margin-bottom:14px;flex-wrap:wrap}
.tabs button{all:unset;cursor:pointer;padding:7px 12px;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px;display:inline-flex;gap:6px;align-items:center}
.tabs button[aria-selected="true"]{color:var(--accent);border-bottom-color:var(--accent);font-weight:500}
.empty{color:var(--faint);padding:14px 0}
.chart text{fill:var(--muted);font-family:var(--font-num);font-size:10px}
.chart .gl{stroke:var(--rule);stroke-width:1}
.swatch{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px}
.legendrow{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--muted);margin-top:6px}
.chk{all:unset;cursor:pointer;width:20px;height:20px;border-radius:5px;border:1px solid var(--rule);display:inline-grid;place-items:center;font-size:13px;color:transparent}
.chk.on{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.chk[disabled]{cursor:default}
.matrix td:not(:first-child),.matrix th:not(:first-child){text-align:center}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
.box{border-radius:8px;padding:10px 12px;font-size:13px}
.box b{display:block;margin-bottom:4px}
.box ul{margin:0;padding-left:18px}
.box.stop{background:var(--bad-soft);color:var(--bad)}
.box.keep{background:var(--sunk);color:var(--muted)}
.box.stop li,.box.keep li{color:var(--ink)}
.checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.check{border:1px solid var(--rule);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}
.check .v{font-weight:600;color:var(--ok)}
.scrimbg{position:fixed;inset:0;background:var(--scrim);z-index:40}
.modal{position:fixed;z-index:42;top:50%;left:50%;transform:translate(-50%,-50%);width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow-y:auto;background:var(--surface);border-radius:12px;box-shadow:var(--shadow);display:flex;flex-direction:column}
.modal.lg{width:min(680px,calc(100vw - 32px))}
.modal .mh{display:flex;align-items:center;gap:10px;padding:16px 20px 10px}
.modal .mh h3{margin:0;font-size:16px;font-weight:600;flex:1}
.modal .mb{padding:4px 20px 16px;display:flex;flex-direction:column;gap:14px}
.modal .mf{padding:12px 20px 16px;border-top:1px solid var(--rule);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;position:sticky;bottom:0;background:var(--surface)}
.field{display:flex;flex-direction:column;gap:4px}
.field label{font-size:12px;color:var(--muted)}
input,select,textarea{font:inherit;font-size:13px;padding:7px 9px;border:1px solid var(--rule);border-radius:6px;background:var(--surface);color:var(--ink);width:100%}
textarea{min-height:64px;resize:vertical}
.err{color:var(--bad);font-size:12px}
.kv{display:grid;grid-template-columns:104px minmax(0,1fr);gap:6px 12px;font-size:13px;margin:0}
.kv dt{color:var(--muted)}
.kv dd{margin:0;overflow-wrap:anywhere}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.steps li{display:grid;grid-template-columns:18px minmax(0,1fr);gap:10px;position:relative;padding-bottom:12px}
.steps li::before{content:"";width:12px;height:12px;border-radius:50%;margin-top:4px;background:var(--rule);border:2px solid var(--surface);box-shadow:0 0 0 1px var(--rule)}
.steps li.done::before{background:var(--ok);box-shadow:0 0 0 1px var(--ok)}
.steps li.now::before{background:var(--warn);box-shadow:0 0 0 1px var(--warn)}
.steps li.no::before{background:var(--bad);box-shadow:0 0 0 1px var(--bad)}
.steps li:not(:last-child)::after{content:"";position:absolute;left:6px;top:20px;bottom:0;width:2px;background:var(--rule)}
.note{background:var(--sunk);border-radius:8px;padding:10px 12px;font-size:13px;color:var(--muted)}
.note.warn{background:var(--warn-soft);color:var(--warn)}
.act{background:var(--sunk);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.act h4{margin:0;font-size:14px}
.sec h4{margin:0 0 6px;font-size:13px;color:var(--muted);font-weight:500}
.tree{font-family:var(--font-num);font-size:12px;line-height:1.7;margin:0;padding:0;list-style:none}
.tree li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;border-bottom:1px dashed var(--rule);padding:3px 0}
.tree li span:first-child{overflow-wrap:anywhere}
.tree .d{color:var(--muted);font-family:var(--font-ui);font-size:12px}
.tree li .tag{align-self:start;margin-top:3px}
.pop{position:fixed;z-index:60;max-width:310px;background:var(--ink);color:var(--surface);border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.55;box-shadow:var(--shadow)}
.pop b{display:block;margin-bottom:4px}
.toast{position:fixed;z-index:70;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:var(--ink);color:var(--surface);padding:9px 14px;border-radius:8px;font-size:13px;box-shadow:var(--shadow);max-width:calc(100vw - 32px)}
.tourhole{position:fixed;z-index:55;border-radius:8px;box-shadow:0 0 0 9999px var(--scrim);pointer-events:none;transition:all .2s}
.tourcard{position:fixed;z-index:56;width:min(320px,calc(100vw - 32px));background:var(--surface);border-radius:10px;box-shadow:var(--shadow);padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.tourcard .n{font-size:12px;color:var(--faint)}
.tourcard h4{margin:0;font-size:15px}
.tourcard p{margin:0;color:var(--muted);font-size:13px}
.tourcard .row{display:flex;justify-content:space-between;gap:8px;margin-top:4px}
.login{min-height:100vh;display:grid;place-items:center;padding-inline:16px;padding-block:56px 24px;position:relative}
.login .lbox{width:min(440px,100%);background:var(--surface);border:1px solid var(--rule);border-radius:14px;padding:26px 26px 20px;display:flex;flex-direction:column;gap:14px}
.login .lbox h2{margin:0;font-size:18px;font-weight:600}
.who{display:grid;gap:8px}
.who button{all:unset;cursor:pointer;display:flex;align-items:center;gap:10px;border:1px solid var(--rule);border-radius:8px;padding:9px 12px}
.who button:hover,.who button:focus-visible{border-color:var(--accent);background:var(--accent-soft)}
.who .t{display:flex;flex-direction:column}
.who .t span{font-size:12px;color:var(--muted)}
.menu{position:fixed;z-index:50;background:var(--surface);border:1px solid var(--rule);border-radius:8px;box-shadow:var(--shadow);padding:6px;display:flex;flex-direction:column;min-width:180px}
.menu button{all:unset;cursor:pointer;padding:7px 10px;border-radius:6px;font-size:13px}
.menu button:hover{background:var(--sunk)}
@media (max-width:860px){.shell{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto 1fr}
nav.side{position:static;height:auto;align-self:start;flex-direction:row;overflow-x:auto;min-width:0;border-right:0;border-bottom:1px solid var(--rule);padding-block:8px;padding-inline:12px}
.rolewrap{grid-template-columns:minmax(0,1fr)}
.grp{display:none}
.nav{white-space:nowrap}
main{padding-inline:16px}
.two,.half,.cols{grid-template-columns:minmax(0,1fr)}
.scroll table{min-width:680px}
.userchip .r,.brand small,.proj{display:none}
}
@media (prefers-reduced-motion:reduce){.tourhole{transition:none}
}
.pagedesc{color:var(--muted);font-size:13px;margin:-8px 0 14px;max-width:70ch}
.rolewrap{display:grid;grid-template-columns:250px minmax(0,1fr);gap:14px;align-items:start}
.rolelist{display:flex;flex-direction:column;gap:2px}
.rolelist button{all:unset;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 12px;border-radius:8px}
.rolelist button:hover{background:var(--sunk)}
.rolelist button[aria-current="true"]{background:var(--accent-soft);color:var(--accent);font-weight:500}
.rolelist button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.permlist{display:flex;flex-direction:column}
.permlist label{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--rule)}
.permlist label:last-child{border-bottom:0}
.permlist input{width:auto;margin-top:3px}
.proc{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;counter-reset:s}
.proc li{border:1px solid var(--rule);border-radius:8px;padding:10px 12px;counter-increment:s;display:flex;flex-direction:column;gap:4px}
.proc li::before{content:counter(s);width:22px;height:22px;border-radius:50%;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;font-size:12px;font-weight:600}
.proc li b{font-size:13px}
.proc li span{font-size:12px;color:var(--muted)}
.flowchips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.arrowsm{color:var(--faint)}
.wiz{display:flex;gap:14px;font-size:12px;color:var(--faint);padding:0 20px}
.wiz .on{color:var(--accent);font-weight:600}
.big{font-size:15px;padding:5px 14px}
.haltbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;background:var(--bad-soft);color:var(--bad);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:13px}
.haltbar .grow{flex:1}
.haltbar span{color:var(--ink)}
.stopbtn[aria-disabled="true"]{opacity:.55;cursor:not-allowed}
.pop.tip{max-width:340px;pointer-events:none}
.pop.tip b:not(:first-child){margin-top:8px}
.pop ul{margin:0;padding-left:18px}
.pop li{margin:1px 0}
.resumecard{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;border:1px solid color-mix(in srgb,var(--warn) 45%,var(--rule));background:var(--warn-soft);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:13px}
.resumecard .grow{flex:1}
.grid > .card + .card,.rolewrap > .card + .card{margin-top:0}
.crumb{display:flex;gap:6px;align-items:center;font-size:13px;color:var(--faint);margin-bottom:6px}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.toolbar input[type="search"]{flex:1 1 260px;width:auto;min-width:0}
.toolbar select{width:auto;flex:0 0 auto}
.grow-r{margin-left:auto;white-space:nowrap}
.pager{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;align-items:center;margin-top:12px}
.pager .sub{margin-right:6px}
.pager .btn{min-width:34px}
.btn[disabled]{opacity:.45;cursor:default}
.scroll table.wide{min-width:920px}
:root{--lift:0 1px 2px rgba(15,22,30,.05)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--lift:none}
}
:root[data-theme="dark"]{--lift:none}
.logo{width:26px;height:26px;border-radius:7px;background:var(--accent);color:var(--accent-ink);display:grid;place-items:center;flex:none}
.logo svg{width:16px;height:16px}
.nav .ic{width:16px;height:16px;flex:none}
.nav .badge{margin-left:auto}
.lang{display:inline-flex;border:1px solid var(--rule);border-radius:7px;overflow:hidden;background:var(--surface);flex:none}
.lang button{all:unset;cursor:pointer;padding:4px 10px;font-size:12px;color:var(--muted)}
.lang button[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent);font-weight:600}
.lang button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.ph{margin-bottom:4px}
.ph h1{font-size:22px;letter-spacing:-.01em}
.pagesub{color:var(--muted);font-size:13.5px;margin:0 0 18px;max-width:78ch}
.kpi{container-type:inline-size}
.kpi .v{font-size:clamp(18px,16cqi,26px);overflow-wrap:anywhere}
.kpi .v .of{font-size:.55em;font-weight:400;color:var(--muted);white-space:nowrap}
.mono{font-variant-numeric:tabular-nums}
html[lang="en"] th,html[lang="en"] .kpi .l{text-transform:uppercase;letter-spacing:.06em;font-size:11px}
html[lang="en"] .grp{text-transform:uppercase;letter-spacing:.1em;font-size:10.5px}
.loginwrap{width:min(1040px,100%);display:grid;grid-template-columns:minmax(0,1fr) minmax(0,420px);gap:56px;align-items:center}
.hero .brand{font-size:18px}
.hero h1{font-size:34px;line-height:1.15;margin:18px 0 12px;letter-spacing:-.02em;font-weight:600;text-wrap:balance}
.hero .lead{color:var(--muted);font-size:15px;line-height:1.6;max-width:46ch;margin:0 0 26px}
.points{list-style:none;margin:0;padding:0;display:grid;gap:16px}
.points li{display:grid;grid-template-columns:32px minmax(0,1fr);gap:12px;align-items:start}
.points .pi{width:32px;height:32px;border-radius:8px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center}
.points .pi svg{width:17px;height:17px}
.points b{display:block;font-size:14px;font-weight:600;color:var(--ink)}
.points span{color:var(--muted);font-size:13px}
.login .lbox{box-shadow:var(--shadow);width:100%}
.login > .lang{position:absolute;top:16px;right:16px}
.loginfoot{margin-top:28px;font-size:12px;color:var(--faint)}
.minis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:14px;border-top:1px solid var(--rule);padding-top:12px}
.minis div{display:flex;flex-direction:column;gap:2px;min-width:0}
.minis b{font-family:var(--font-num);font-size:15px;font-weight:500;font-variant-numeric:tabular-nums}
.scroll table.tight{min-width:0}
@media (max-width:860px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (max-width:700px){.userchip > span:nth-child(2){display:none}
.userchip{padding-right:4px}
}
@media (max-width:480px){.minis{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:860px){.loginwrap{grid-template-columns:minmax(0,1fr);gap:28px}
.hero h1{font-size:26px}
}
.newtag{display:inline-flex;align-items:center;margin-left:6px;padding:0 6px;border-radius:4px;font-size:10.5px;font-weight:700;line-height:1.6;letter-spacing:.02em;color:var(--accent-ink);background:var(--info);vertical-align:1px;white-space:nowrap}
.nav .newtag{margin-left:auto}
.nav .newtag + .badge{margin-left:4px}
.edsw{display:inline-flex;border:1px solid var(--rule);border-radius:7px;overflow:hidden;background:var(--surface);flex:none}
.edsw button{all:unset;cursor:pointer;padding:4px 10px;font-size:12px;color:var(--muted);white-space:nowrap}
.edsw button[aria-pressed="true"]{background:var(--ink);color:var(--surface);font-weight:600}
.edsw button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.newsw{all:unset;cursor:pointer;font-size:12px;color:var(--muted);display:inline-flex;gap:6px;align-items:center;white-space:nowrap}
.newsw .box8{width:14px;height:14px;border-radius:3px;border:1px solid var(--rule);display:inline-grid;place-items:center;font-size:10px;color:transparent}
.newsw[aria-pressed="true"] .box8{background:var(--info);border-color:var(--info);color:var(--accent-ink)}
.newsw:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.edtag{font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid var(--rule);color:var(--muted);white-space:nowrap}
.edtag.oss{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,transparent)}
.hint{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;justify-content:space-between;border:1px dashed var(--rule);border-radius:10px;padding:9px 14px;margin:14px 0;font-size:13px;color:var(--muted);background:var(--surface)}
.card + .hint,.hint + .card{margin-top:14px}
.tryres{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center;margin-top:12px;font-size:13px}
code{font-family:var(--font-num);font-size:12px;background:var(--sunk);border-radius:4px;padding:1px 6px;color:var(--ink);overflow-wrap:anywhere}
.intgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.intgrid > .card + .card{margin-top:0}
.intgrid .card{display:flex;flex-direction:column}
.intgrid .card .btn{align-self:flex-start;margin-top:auto}
.ih{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px}
.upgrid{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.uplist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.uplist li{display:flex;flex-direction:column;gap:2px}
.uplist b{font-size:13.5px;font-weight:600}
.uplist span{font-size:13px;color:var(--muted)}
.upcta{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.upcta > span{flex:1 1 200px}
.minirow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:4px 0;font-size:13px}
.edpick{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;justify-content:space-between;font-size:13px;color:var(--muted);border:1px dashed var(--rule);border-radius:8px;padding:8px 12px}
.checkrow{display:flex;gap:8px;align-items:flex-start;font-size:13px}
.checkrow input{width:auto;margin-top:3px}
@media (max-width:860px){.newsw,.edtag{display:none}
}
.enttag{display:inline-flex;align-items:center;margin-left:6px;padding:0 6px;border-radius:4px;font-size:10.5px;font-weight:700;line-height:1.6;color:var(--ent);background:var(--ent-soft);border:1px solid color-mix(in srgb,var(--ent) 40%,transparent);vertical-align:1px;white-space:nowrap}
.nav .enttag{margin-left:auto}
.marksw{display:inline-flex;align-items:center;border:1px solid var(--rule);border-radius:7px;overflow:hidden;background:var(--surface);flex:none;font-size:12px}
.marksw .ml{padding:4px 4px 4px 10px;color:var(--faint)}
.marksw button{all:unset;cursor:pointer;padding:4px 9px;color:var(--muted);white-space:nowrap}
.marksw button[aria-pressed="true"]{background:var(--sunk);color:var(--ink);font-weight:600}
.marksw button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.toast.wide{max-width:min(640px,calc(100vw - 32px));text-align:center}
@media (max-width:1180px){.marksw .ml{display:none}
}
@media (max-width:860px){.marksw{display:none}
}
.tl{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.tl li{display:grid;grid-template-columns:26px 92px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 6px;border-bottom:1px solid var(--rule)}
.tl li:last-child{border-bottom:0}
.tl li.click{cursor:pointer;border-radius:6px}
.tl li.click:hover{background:var(--sunk)}
.tl .ico{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700}
.tl .ico::before{display:none}
.tl .what{display:flex;flex-direction:column;min-width:0}
.tl .what b{font-weight:500;overflow-wrap:anywhere}
.tl li.deny .what b{color:var(--bad)}
.conn{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px 14px;align-items:center;padding:10px 0;border-top:1px solid var(--rule)}
.conn:first-of-type{border-top:0}
@media (max-width:860px){.tl li{grid-template-columns:26px minmax(0,1fr) auto}
.tl li .mono{display:none}
.conn{grid-template-columns:minmax(0,1fr) auto}
.conn code{grid-column:1 / -1}
}
.tourcard{width:min(360px,calc(100vw - 32px));gap:8px}
.tourcard .tg{display:flex;flex-direction:column;gap:2px}
.tourcard .tg b{font-size:11.5px;font-weight:600;color:var(--accent);letter-spacing:.04em}
.tourcard .tg p{color:var(--ink)}
.tourcard .row .grow{flex:1}
.tprog{display:flex;gap:3px;margin-top:2px}
.tprog i{flex:1;height:3px;border-radius:2px;background:var(--rule)}
.tprog i.done{background:color-mix(in srgb,var(--accent) 45%,var(--rule))}
.tprog i.on{background:var(--accent)}
.tourbtn{cursor:pointer;font-size:12px;color:var(--accent);background:var(--accent-soft);border-radius:999px;padding:2px 10px;border:0;white-space:nowrap}
.tourbtn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.soon{max-width:640px;display:flex;flex-direction:column;gap:12px}
.soon h2{margin:0;font-size:18px}
.soontag{align-self:flex-start;font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--accent);background:var(--accent-soft);border-radius:999px;padding:3px 10px}
.soonlist{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px}
.soonlist li{color:var(--ink)}
.soon .row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.navsoon{margin-left:auto;font-size:10.5px;color:var(--muted);white-space:nowrap}
.src{color:var(--muted);font-size:12px;overflow-wrap:anywhere}
code,.mono{font-family:var(--font-num);overflow-wrap:anywhere}.ml-auto{margin-left:auto}.mt4{margin-top:4px}.mt10{margin-top:10px}.mt14{margin-top:14px}.mb10{margin-bottom:10px}.mb14{margin-bottom:14px}.m10t{margin:10px 0 0}.m12t{margin:12px 0 0}.m0{margin:0}.m6-12{margin:6px 0 12px}.m0-10{margin:0 0 10px}.phtight{margin-top:-6px}.ink{color:var(--ink)}.v-bad{color:var(--bad)}.v-warn{color:var(--warn)}.tr{text-align:right}.bold{font-weight:600}.hide{display:none}.sw0{background:var(--m1)}.sw1{background:var(--m2)}.sw2{background:var(--m3)}.sw3{background:var(--ent)}.sw4{background:var(--faint)}.chart .f0{fill:var(--m1)}.chart .f1{fill:var(--m2)}.chart .f2{fill:var(--m3)}.chart .f3{fill:var(--ent)}.chart .f4{fill:var(--faint)}.chart text.bold{fill:var(--ink);font-weight:600}
.wrap{white-space:normal;overflow-wrap:anywhere}
/* F-224: a re-render must not move the nav: reserve the bold width of every label, and keep the page from shifting when a scrollbar appears */
html{scrollbar-gutter:stable}
.nav .lbl{display:inline-flex;flex-direction:column}
.nav .lbl::after{content:attr(data-label);content:attr(data-label) / "";font-weight:500;height:0;overflow:hidden;visibility:hidden;pointer-events:none;user-select:none}
.nav .navsoon,.nav .badge{font-weight:400}`;

/**
 * The sign-in page, shown only when a password is set and the request has no
 * token and no live session. Static markup under the same nonce CSP as the
 * console; the one script posts to /login (same origin, so the browser sends
 * our Origin) and shows the answer with textContent.
 */
export function renderLoginPage(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Sakk console</title>
<style nonce="${nonce}">${PAGE_CSS}
.login label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
.login .lbox .btn{align-self:flex-start}</style>
</head>
<body>
<main class="login">
<form class="lbox" id="signin" method="post" action="/login" novalidate>
<h2>Sign in to the Sakk console</h2>
<p class="note">Open source · local. The address <code>sakk ui</code> printed also opens the console: it carries the token for this run.</p>
<label>Username<input name="username" id="u" autocomplete="username" required maxlength="${USERNAME_MAX}"></label>
<label>Password<input name="password" id="p" type="password" autocomplete="current-password" required maxlength="${PASSWORD_MAX}"></label>
<p class="note warn" id="err" role="alert" hidden></p>
<button class="btn pri" type="submit">Sign in</button>
</form>
</main>
<script nonce="${nonce}">"use strict";
(function(){
const f=document.getElementById("signin"),e=document.getElementById("err"),b=f.querySelector("button");
const show=(t)=>{e.textContent=t;e.hidden=false;b.disabled=false;};
f.addEventListener("submit",(ev)=>{ev.preventDefault();b.disabled=true;e.hidden=true;
fetch("/login",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:f.username.value,password:f.password.value})})
.then((r)=>r.json().catch(()=>({error:"HTTP_"+r.status})).then((j)=>{if(r.ok&&j.signedIn){location.replace("/");return;}f.password.value="";show(j.message||("Sign-in failed ("+(j.error||r.status)+")."));}))
.catch((x)=>show("The console did not answer: "+String(x&&x.message||x)));});
})();
</script>
</body>
</html>
`;
}

/**
 * The page: one HTML file, inline script and style under a nonce, no other
 * origin. It fetches /api/* (connect-src 'self') with the strict cookie and
 * renders every value with textContent, so no log string is ever HTML.
 */
export function renderPage(nonce, allowHalt, signIn = false) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sakk console</title>
<style nonce="${nonce}">${PAGE_CSS}</style>
</head>
<body>
<template id="icons">
<svg data-i="overview" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
<svg data-i="data" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/></svg>
<svg data-i="prices" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/></svg>
<svg data-i="logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h14M5 12h9M5 17h6"/><path d="m14 17 2 2 4-4"/></svg>
<svg data-i="agents" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4"/><circle cx="9.5" cy="13.5" r="1.2"/><circle cx="14.5" cy="13.5" r="1.2"/></svg>
<svg data-i="policy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/><path d="M10 12h6M10 16h6"/></svg>
<svg data-i="dlp" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
<svg data-i="upgrade" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/></svg>
<svg data-i="chartproto"><rect/><line/><text></text><title></title></svg>
</template>
<div id="app"></div>
<script nonce="${nonce}">"use strict";
(function(){
const ALLOW_HALT=${allowHalt ? 'true' : 'false'};
const SIGN_IN=${signIn ? 'true' : 'false'};
const TOKEN=new URLSearchParams(location.search).get("t")||"";
const AGENTS=["claude-code","cursor","codex"];
const NAMES={"claude-code":"Claude Code","cursor":"Cursor","codex":"Codex","sakk-mcp":"MCP gate"};
const DOCTOR_BY=${JSON.stringify(DOCTOR_BY)};
const VIA={"claude-code":"Claude Code hook","cursor":"Cursor hook","codex":"Codex hook","sakk-mcp":"MCP gate",[DOCTOR_BY]:"Doctor self-test"};
const TITLES={overview:"Overview",calls:"Spend log",blocks:"Blocked actions",agents:"Agents",policy:"Guard rules",dlp:"Secret guard",data:"Records & export",prices:"Model prices",upgrade:"Enterprise"};
const PARENT={calls:"overview",blocks:"overview"};
const GROUPS=[["Monitor",["overview"]],["Guard",["policy","dlp","agents"]],["Records",["data"]],["Settings",["prices"]],["",["upgrade"]]];
const ICON={overview:"overview",policy:"policy",dlp:"dlp",agents:"agents",data:"data",prices:"prices",upgrade:"upgrade"};
const SUBS={
overview:"What your agents did today, what they spent and what was blocked, from local logs and the guard’s record. Nothing goes online.",
policy:"Every agent action passes here first: risky ones are blocked, borderline ones ask you, the rest go through. Type a command to try it.",
calls:"Every call the gateway ledger reserved and settled: which agent, which task and what it cost. Click a row for its trail.",
blocks:"Every action Sakk stopped, and why. Actions that need approval ask you in your agent first.",
dlp:"Agents reading, printing or committing secrets are stopped first; only fingerprints are kept.",
data:"Local records and exports.",
agents:"Every connected agent: how it connects, what it spent and how often it was blocked. Stop any one of them.",
prices:"Per-model prices. All spend is computed from this list.",
upgrade:"A version for teams, in the works."};
const HELP={
spend:"Read from the usage Claude Code logs on this machine and priced from the list; nothing to wire up. With a daily cap set, the next call over it is blocked.",
cap:"The cap is a hard wall. If spend so far plus the most this call could cost reaches the cap, the call is denied.",
source:"“Local logs” means the token usage Claude Code records on this machine, priced by Sakk.",
ledger:"From the gateway ledger: each call the gateway reserved and settled. Committed is what is settled plus what is still reserved; a call that would pass the cap is refused before it starts.",
recon:"A call’s final cost could not be confirmed, so new spend is paused until a person checks it. Run sakk reconcile --by <your name> in a terminal.",
halt:"A stop refuses new ledger reservations, and the hooks refuse every command that does not just read the project. A call already in flight finishes; nothing already done is undone.",
prices:"Prices come from LiteLLM’s public price list (MIT licence), trimmed and shipped with Sakk; you can override it with prices.json in Sakk’s folder. Calls to an unlisted model are denied rather than guessed.",
blocks:"Policy denials, secret blocks, budget refusals and stops, newest first. Open items are the ones a person still has to handle.",
policy:"The first rule from the top that matches an action decides it. Nothing matches: the default decision applies.",
dlp:"The pre-commit scan and the agent hooks share one rule set taken from gitleaks. A block keeps the rule name and a fingerprint, never the value.",
agents:"An agent is guarded once its hook is installed. Gateway agents are the ones the ledger has seen.",
data:"Everything Sakk records stays in files on this machine.",
upgrade:"The open-source edition stays free and keeps every feature it has."};
const TYPES={deny:["Policy denied","p-bad"],approval:["Needs approval","p-warn"],secret:["Secret found","p-bad"],recon:["Awaiting reconciliation","p-warn"],budget:["Over budget","p-bad"],halted:["Stopped","p-bad"],price:["Model not priced","p-warn"]};
const ABILITY={
recon:"Run sakk reconcile --by <your name> in a terminal to confirm the cost; new spend resumes right after.",
secret:"Revoke the token, switch to an environment variable and commit again; the hook checks again.",
price:"Add this model to the price list, then retry.",
approval:"Open source: actions that need approval ask you in Claude Code or Cursor and you decide there; this page shows the record.",
deny:"Nothing to do unless the rule is wrong. To change it, edit the policy file shown on Guard rules.",
budget:"Raise the cap or wait for the next day; the refused call never started.",
halted:"Agents are stopped. A person resumes with sakk resume --by <your name> in a terminal."};
const TOUR=[
["overview",".kpis .card:first-child","Today’s spend and daily cap","Keep daily spend in check so an agent can’t burn the budget overnight.","Spend is read from the logs Claude Code keeps on this machine; nothing to wire up. It is counted when an agent calls a tool with a cap set, or when you run sakk spend; until today is counted the card shows a dash. Set a daily cap in Sakk’s config; once it’s reached, the agent’s next call is blocked. The Gateway ledger card next to it counts calls made through the gateway."],
["overview","#timeline","What your agents did lately","See the outcome of every agent action, so after an incident you know exactly what it did.","Green ✓ allowed, red ✕ blocked, amber ? asked you first. Click a row for the rule and the reason; All blocked actions opens the full, searchable list."],
["overview",".kpis .card:last-child","Open items","A few things need you personally: reconciling a cost, a secret alert, pricing a new model.","Click See what to do; each item tells you the command to run."],
["overview","#spendcard","Where the money went","See which model and which agent the money went to.","Click an agent to see each of its calls; View details lists every call with search, filters and pages."],
["overview","#stopbtn","Emergency stop","Cut losses first when an agent misbehaves, then investigate.","Click it, choose all agents or one, then type STOP. The console records your OS account name as self-declared; to give a name and reason use sakk halt. Resume with sakk resume --by <name>. Hover the button to see what a stop covers."],
["policy","#trycard","Try a request","Know whether a command would be blocked before an agent runs it.","Type a command such as rm -rf ~/ or cat .env, click Check, and read the decision and the matching rule."],
["policy","#rulescard","Guard rules","One table showing what is allowed, what is blocked and what asks you first.","The rules live in the policy file shown above; the first match from the top wins."],
["dlp","main .card","Pre-commit secret scan","Keep secrets out of the repository.","Run sakk scan --install-hook once. From then on, commits with secrets are refused; only a fingerprint is kept, never the secret."],
["dlp","#secretacts","Agents reaching for secrets","Agents can’t get at secrets either.","Works once the hook is connected: an agent trying to read a secret file or print a secret is blocked and listed here."],
["agents","#conncard","Connections","Connect Claude Code and Cursor; the guard and the spend cap only work once they are connected.","Run one command for each; Connected appears on the right. The MCP gate is for agents you wire up in code and is experimental."],
["agents","main .scroll","Agent list","See what each agent spent and how often it was blocked.","Click a row for details; you can stop just that agent while the others keep working."],
["data","main .card","Records & export","Every record stays on your machine; export it.","Export the decision log as CSV or JSONL."],
["prices","main .card","Model prices","Spend is priced from this list.","Calls to an unlisted model are refused rather than guessed."],
["upgrade","#soon","Enterprise · coming soon","A version for teams is in the works.","Open-source features stay free and stay put. Leave a note in the project’s discussions to hear first or to tell us about your setup; nothing else in the open-source edition will nag you."]];
const TOUR_KEY="sakk-tour10-oss";

const S={page:"overview",d:{},calls:{q:"",agent:"",status:"",pg:0},blocks:{tab:"open",q:"",type:"",pg:0},pr:{q:"",pg:0},tour:-1,modal:null,pop:null,tip:null};
let D={};

/* ---------- small helpers ---------- */
const $=(t,a={},...k)=>{const e=document.createElement(t);for(const[n,v]of Object.entries(a)){if(v==null||v===false)continue;if(n==="class")e.className=v;else if(n==="text")e.textContent=v;else e.setAttribute(n,v===true?"":v);}for(const c of k){if(c==null||c===false)continue;e.append(c);}return e;};
const api=p=>fetch("/api/"+p,{credentials:"same-origin"}).then(r=>r.json().catch(()=>({error:"HTTP_"+r.status,message:"The console answered "+r.status+"."})));
const TPL=document.getElementById("icons");
function icon(n){const s=TPL&&TPL.content.querySelector('[data-i="'+n+'"]');if(!s)return $("span");const c=document.importNode(s,true);c.removeAttribute("data-i");return c;}
function svgEl(tag){const p=TPL.content.querySelector('[data-i="chartproto"]');if(tag==="svg"){const c=p.cloneNode(false);c.removeAttribute("data-i");return c;}return p.querySelector(tag).cloneNode(false);}
function sattr(e,o){for(const k in o)e.setAttribute(k,String(o[k]));return e;}
function usd(v){if(v==null||typeof v!=="number"||!isFinite(v))return "—";const a=Math.abs(v);const d=a>=1||v===0?2:a>=0.0001?4:Math.min(12,1-Math.floor(Math.log10(a)));return "$"+v.toFixed(d);}
/* a KPI "spent / cap": the cap is smaller and kept whole, so a long amount never splits the pair mid-line (F-238) */
function kpiOf(main,of){return $("div",{class:"v"},main," ",$("span",{class:"of",text:"/ "+of}));}
function num(v){return typeof v==="number"&&isFinite(v)?v.toLocaleString("en-GB"):"—";}
function plural(n,w){return n+" "+w+(n===1?"":"s");}
function arr(x){return Array.isArray(x)?x:[];}
function scopeText(s){if(s==null)return "";return Array.isArray(s)?s.join(", "):String(s);}
function short(s,n){s=String(s==null?"":s);return s.length>n?s.slice(0,n-1)+"…":s;}
function errText(x){return (x&&(x.message||x.error))||"unknown error";}
let ZONE,FMT_T,FMT_D,FMT_K,FMT_W,TODAY;
function mkfmt(o){try{return new Intl.DateTimeFormat("en-GB",Object.assign({timeZone:ZONE,hourCycle:"h23"},o));}catch(_){return new Intl.DateTimeFormat("en-GB",Object.assign({hourCycle:"h23"},o));}}
function setZone(z){ZONE=z||undefined;FMT_T=mkfmt({hour:"2-digit",minute:"2-digit"});FMT_D=mkfmt({day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});try{FMT_K=new Intl.DateTimeFormat("en-CA",{timeZone:ZONE,year:"numeric",month:"2-digit",day:"2-digit"});}catch(_){FMT_K=new Intl.DateTimeFormat("en-CA",{year:"numeric",month:"2-digit",day:"2-digit"});}FMT_W=new Intl.DateTimeFormat("en-GB",{timeZone:"UTC",weekday:"short",day:"numeric"});}
function dt(s){if(!s)return null;const d=new Date(s);return isNaN(d)?null:d;}
function dayKey(s){const d=dt(s);return d?FMT_K.format(d):"";}
function when(s){const d=dt(s);if(!d)return "—";return dayKey(s)===TODAY?FMT_T.format(d):FMT_D.format(d);}
function fullWhen(s){const d=dt(s);return d?FMT_D.format(d)+(ZONE?" ("+ZONE+")":""):"—";}
function days7(){const out=[];const base=new Date((TODAY||new Date().toISOString().slice(0,10))+"T12:00:00Z");for(let i=6;i>=0;i--){const d=new Date(base.getTime()-i*864e5);out.push(d.toISOString().slice(0,10));}return out;}
function in7(s){const k=dayKey(s);return k!==""&&k>=D.days[0]&&k<=D.days[6];}
function toast(msg){const t=$("div",{class:"toast",role:"status",text:msg});document.body.append(t);setTimeout(()=>t.remove(),2800);}
function pill(text,cls){return $("span",{class:"pill "+cls,text:text});}
function q(key){return $("button",{class:"q","aria-label":"What is this?","data-help":key,type:"button",text:"?"});}
function empty(t){return $("p",{class:"empty",text:t});}
function errNote(x,what){return $("p",{class:"note warn",text:"Could not read "+what+": "+errText(x)});}
function code(t){return $("code",{text:t});}
function btn(text,cls,on,attrs){const b=$("button",Object.assign({class:"btn"+(cls?" "+cls:""),type:"button",text:text},attrs||{}));if(on)b.addEventListener("click",on);return b;}
function linkish(text,on){const b=$("button",{class:"linkish",type:"button",text:text});b.addEventListener("click",on);return b;}
function td(t,cls){return $("td",{class:cls||null,text:t==null?"—":String(t)});}
function table(cls,heads,rows){const tb=$("tbody");rows.forEach(r=>tb.append(r));return $("div",{class:"scroll"},$("table",{class:cls||null},$("thead",{},$("tr",{},...heads.map(h=>$("th",{text:h})))),tb));}
function clickRow(tr,fn){tr.classList.add("click");tr.tabIndex=0;tr.addEventListener("click",fn);tr.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();fn();}});return tr;}

/* ---------- derived data ---------- */
function derive(){
const ov=S.d.overview||{};setZone(ov.zone);TODAY=ov.day||FMT_K.format(new Date());
const led=S.d.ledger||{};const ledOk=Boolean(led.configured&&!led.error&&led.status);
const st=ledOk?led.status:null;const entries=ledOk?arr(led.entries):[];
const alerts=led.alerts&&!led.alerts.skipped?arr(led.alerts.entries):[];
const decs=arr(S.d.records&&S.d.records.decisions).filter(d=>d&&d.by!==DOCTOR_BY);
const days=days7();
let halt=null;
if(st&&st.halted)halt={scope:"all",by:st.halted.by,reason:st.halted.reason,at:st.halted.at||st.updated_at,agents:[]};
else if(st&&st.halted_agents){const ks=Object.keys(st.halted_agents);if(ks.length){const h=st.halted_agents[ks[0]]||{};halt={scope:ks.length===1?ks[0]:ks.length+" agents",by:h.by,reason:h.reason,at:h.at,agents:ks};}}
const blocks=[];
decs.forEach((d,i)=>{if(d.verdict!=="deny"&&d.verdict!=="require_approval")return;const c=d.context||{};const r=d.ruleId;
const type=r==="secret"?"secret":r==="spend-cap"?"budget":r==="halt"?"halted":d.verdict==="require_approval"?"approval":"deny";
blocks.push({id:c.callId||("record "+(i+1)),at:d.at,type:type,who:c.agent||d.by||"—",via:VIA[d.by]||d.by||"—",action:(c.action||"")+(c.scope?" "+scopeText(c.scope):""),why:d.why||("Matched rule "+r),rule:r,open:type==="secret"&&in7x(d.at,days),src:d});});
alerts.forEach(a=>{if(a.kind!=="BUDGET_REFUSED"&&a.kind!=="HALT_REFUSED")return;const budget=a.kind==="BUDGET_REFUSED";
blocks.push({id:a.callId||"—",at:a.at,type:budget?"budget":"halted",who:a.agentId||"—",via:"Gateway ledger",action:"Model call"+(a.callId?" "+a.callId:""),
why:budget?("This call could cost up to "+usd(a.estimatedMaxUsd)+"; with "+usd(a.committedUsd)+" committed it would pass the "+usd(a.capUsd)+" cap"):("Agents were stopped"+(a.by?" by "+a.by:"")+(a.reason?" — "+a.reason:"")),
rule:budget?"spend-cap":"halt",open:false,src:a});});
if(st&&st.reconciliation_required)blocks.push({id:"ledger",at:st.updated_at,type:"recon",who:"Gateway ledger",via:"Gateway ledger",action:"New spend through the gateway",why:st.reconciliation_reason||"A call’s final cost could not be confirmed",rule:"reconcile",open:true,src:st});
const unp=ov.unpriced&&typeof ov.unpriced==="object"?ov.unpriced:{};
Object.keys(unp).forEach(m=>blocks.push({id:m,at:null,type:"price",who:"—",via:"Local logs",action:"Calls to "+m,why:"No price for this model; "+plural(unp[m],"call")+" today not counted",rule:"unpriced",open:true,src:null}));
blocks.sort((a,b)=>(b.at?Date.parse(b.at):Infinity)-(a.at?Date.parse(a.at):Infinity));
const openN=blocks.filter(b=>b.open).length;
/* spend by day and agent, from the ledger */
const byDay={};const agentsSeen=[];
entries.forEach(e=>{const k=dayKey(e.settledAt||e.createdAt);if(days.indexOf(k)<0)return;const a=e.agentId||"unknown";if(agentsSeen.indexOf(a)<0)agentsSeen.push(a);const v=typeof e.actualUsd==="number"?e.actualUsd:0;byDay[k]=byDay[k]||{};byDay[k][a]=(byDay[k][a]||0)+v;});
const ledAgents={};
entries.forEach(e=>{const a=e.agentId||"unknown";const o=ledAgents[a]=ledAgents[a]||{calls:0,usd:0,last:null,calls7:0,usd7:0,blocked:0};o.calls++;if(typeof e.actualUsd==="number")o.usd+=e.actualUsd;const t=e.createdAt;if(t&&(!o.last||t>o.last))o.last=t;if(in7x(e.settledAt||e.createdAt,days)){o.calls7++;if(typeof e.actualUsd==="number")o.usd7+=e.actualUsd;}});
alerts.forEach(a=>{if((a.kind==="BUDGET_REFUSED"||a.kind==="HALT_REFUSED")&&a.agentId){const o=ledAgents[a.agentId]=ledAgents[a.agentId]||{calls:0,usd:0,last:null,calls7:0,usd7:0,blocked:0};if(in7x(a.at,days))o.blocked++;}});
D={ov:ov,led:led,ledOk:ledOk,st:st,entries:entries,alerts:alerts,decs:decs,days:days,halt:halt,blocks:blocks,openN:openN,byDay:byDay,agentsSeen:agentsSeen,ledAgents:ledAgents};
}
function in7x(s,days){const k=dayKey(s);return k!==""&&k>=days[0]&&k<=days[6];}
function agentHalted(id){const h=D.halt;if(!h)return false;return h.scope==="all"||h.agents.indexOf(id)>=0;}
function hookState(id){const cs=arr(S.d.agents&&S.d.agents.checks);const inst=cs.filter(c=>c.name.indexOf(id+" (")===0);const fo=cs.find(c=>c.name===id+" fail-open"&&c.warn);if(inst.length)return {on:true,detail:inst.map(c=>c.detail).join("; "),where:inst.map(c=>c.name.slice(id.length+2,-1)).join(", "),failOpen:fo?fo.detail:null};const off=cs.find(c=>c.name===id);return {on:false,detail:off?off.detail:"Not checked",where:""};}

/* ---------- shell ---------- */
const app=document.getElementById("app");
function render(){
closePop();
const oldNav=app.querySelector("nav.side");const navX=oldNav?oldNav.scrollLeft:0,navY=oldNav?oldNav.scrollTop:0;
app.textContent="";
const h=D.halt;
const gw=S.d.gateway||{},gst=gw.status,gpr=gw.probe;
let state;
if(h)state=pill("Stopped ("+h.scope+")","p-bad");
else if(gst&&gst.outage)state=pill(gst.mode==="deny"?"Sakk unreachable · calls refused":"Sakk unreachable · calls unmetered","p-bad");
else if(gpr&&!gpr.ok)state=pill("Gateway not answering","p-bad");
else if(D.st&&D.st.reconciliation_required)state=pill("Needs reconciling · new spend paused","p-warn");
else state=pill("Running normally","p-ok");
let stop;
if(h){stop=$("button",{class:"stopbtn on",id:"stopbtn",type:"button","data-tip":"halt",text:"Stopped · view"});stop.addEventListener("click",mHalt);}
else{stop=$("button",{class:"stopbtn",id:"stopbtn",type:"button","data-tip":"halt","aria-disabled":ALLOW_HALT?null:"true",text:"Emergency stop"});stop.addEventListener("click",()=>{if(!ALLOW_HALT){toast("Read-only console: start it with sakk ui --allow-halt to use the stop button.");return;}mHaltWizard();});}
const tourb=$("button",{class:"tourbtn",id:"tourbtn",type:"button",text:"Tour"});tourb.addEventListener("click",()=>startTour(0));
const user=$("button",{class:"userchip",type:"button","aria-label":"Local user","aria-haspopup":"true"},$("span",{class:"avatar",text:"LO"}),$("span",{text:"Local user"}),$("span",{class:"r",text:"Local CLI"}));
user.addEventListener("click",()=>userMenu(user));
const logo=$("span",{class:"logo"},icon("logo"));
const top=$("header",{class:"top"},$("span",{class:"brand"},logo,"Sakk",$("small",{text:"Console"})),$("span",{class:"edtag oss",text:"Open source · local"}),state,$("span",{class:"grow"}),tourb,stop,user);
const side=$("nav",{class:"side","aria-label":"Main"});
const cur=PARENT[S.page]||S.page;
GROUPS.forEach(g=>{side.append($("div",{class:"grp",text:g[0]||" "}));g[1].forEach(p=>{const b=$("button",{class:"nav",type:"button","data-page":p,"aria-current":cur===p?"page":null},$("span",{class:"ic"},icon(ICON[p])),$("span",{class:"lbl","data-label":TITLES[p],text:TITLES[p]}));if(p==="upgrade")b.append($("span",{class:"navsoon",text:"coming soon"}));if(p==="overview"&&D.openN)b.append($("span",{class:"badge",text:String(D.openN)}));b.addEventListener("click",()=>go(p));side.append(b);});});
const main=$("main",{id:"main"});
if(h){const v=btn("View","sm",mHalt);main.append($("div",{class:"haltbar",role:"status"},$("b",{text:"Stopped · "+h.scope}),$("span",{class:"grow",text:(h.by||"Someone")+" stopped agents at "+when(h.at)+". New requests are refused until a person runs sakk resume."}),v));}
gatewayBanners(main);
if(PARENT[S.page])main.append($("div",{class:"crumb"},linkish("Overview",()=>go("overview")),$("span",{text:" › "}),$("span",{text:TITLES[S.page]})));
const helpKey={overview:"source",calls:"ledger",blocks:"blocks",policy:"policy",dlp:"dlp",agents:"agents",data:"data",prices:"prices",upgrade:"upgrade"}[S.page];
main.append($("div",{class:"ph"},$("h1",{text:TITLES[S.page]}),q(helpKey)));
main.append($("p",{class:"pagesub",text:SUBS[S.page]}));
try{PAGES[S.page](main);}catch(e){main.append($("p",{class:"note warn",text:"This page could not be drawn: "+String(e&&e.message||e)}));}
const fb=S.d.forbidden;if(fb&&fb.forbidden)main.append($("p",{class:"sub mt14",text:plural(fb.forbidden,"request")+" without the token were refused since the console started."}));
app.append($("div",{class:"shell"},top,side,main));
keepNav(side,navX,navY);
}
/* F-224: the whole shell is rebuilt on every action; put the nav back where it was and bring the chosen item into view by scrolling the nav only, never the page */
function keepNav(side,x,y){side.scrollLeft=x;side.scrollTop=y;const a=side.querySelector('[aria-current="page"]');if(!a)return;const n=side.getBoundingClientRect(),r=a.getBoundingClientRect(),pad=12;
if(side.scrollWidth>side.clientWidth){if(r.left<n.left)side.scrollLeft-=n.left-r.left+pad;else if(r.right>n.right)side.scrollLeft+=r.right-n.right+pad;}
if(side.scrollHeight>side.clientHeight){if(r.top<n.top)side.scrollTop-=n.top-r.top+pad;else if(r.bottom>n.bottom)side.scrollTop+=r.bottom-n.bottom+pad;}}
function go(p,opts){S.page=p;if(opts)Object.assign(S[p==="calls"?"calls":"blocks"],opts);try{history.replaceState(null,"","#"+p);}catch(_){}render();window.scrollTo(0,0);}

/* ---------- overview ---------- */
const PAGES={};
PAGES.overview=function(m){
const ov=D.ov;const k=$("div",{class:"grid kpis"});
/* 1: today / cap */
{const c=$("div",{class:"card kpi"});const lab=$("div",{class:"l"},"Today / daily cap ",q("spend"));c.append(lab);
if(ov.error&&!ov.day){c.append($("div",{class:"v",text:"—"}),$("div",{class:"s",text:errText(ov)}));}
else{const cap=ov.cap_usd;const counted=ov.counted_today===true;const tail=" · from local logs"+(ov.error?" · "+ov.error:"")+(ov.unreadable_spend?" · "+ov.unreadable_spend+" unreadable":"");
/* a day not counted yet has no figure: a dash, never $0 (F-231) */
c.append(kpiOf(counted?usd(ov.spend_usd):"—",cap==null?"no cap":usd(cap)));
if(cap&&counted){const i=$("i");i.style.width=Math.min(100,Math.max(0,(ov.spend_usd||0)/cap*100)).toFixed(1)+"%";c.append($("div",{class:"bar"},i));}
c.append($("div",{class:"s",text:counted?plural(ov.calls||0,"call")+" · counted "+when(ov.indexed_at)+tail:(ov.indexed_at?"Not counted today":"Not counted yet")+" · run sakk spend to count it"+tail}));
c.append(linkish("See every call",()=>go("calls")));}
k.append(c);}
/* 2: gateway ledger */
{const c=$("div",{class:"card kpi"});c.append($("div",{class:"l"},"Gateway ledger ",q("ledger")));const L=D.led;
if(!L.configured){c.append($("div",{class:"v",text:"—"}),$("div",{class:"s",text:"Not set up: start sakk ui --ledger <path>"}));}
else if(!D.ledOk){c.append($("div",{class:"v",text:"—"}),$("div",{class:"s",text:errText(L)}));}
else{const s=D.st;c.append(kpiOf(usd(s.committed_usd),usd(s.cap_usd)));if(s.cap_usd){const i=$("i");i.style.width=Math.min(100,Math.max(0,(s.committed_usd||0)/s.cap_usd*100)).toFixed(1)+"%";c.append($("div",{class:"bar"},i));}
c.append($("div",{class:"s",text:"settled "+usd(s.settled_usd)+" · "+plural(L.entries_total||0,"call")+" · "+usd(s.remaining_usd)+" left"}));}
k.append(c);}
/* 3: blocked today */
{const today=D.decs.filter(d=>dayKey(d.at)===TODAY);const n=v=>today.filter(d=>d.verdict===v).length;
const c=$("div",{class:"card kpi"},$("div",{class:"l",text:"Risky actions blocked today"}),$("div",{class:"v v-bad",text:String(n("deny"))}),$("div",{class:"s",text:n("allow")+" allowed · "+n("require_approval")+" asked"}));
c.append(linkish("All blocked actions",()=>go("blocks",{tab:"all",pg:0})));k.append(c);}
/* 4: open items */
{const c=$("div",{class:"card kpi"+(D.openN?" alert":"")},$("div",{class:"l",text:"Open items"}),$("div",{class:"v",text:String(D.openN)}),$("div",{class:"s",text:D.openN?"Need a person":"Nothing waiting on you"}));
c.append(linkish("See what to do",()=>go("blocks",{tab:"open",pg:0})));k.append(c);}
m.append(k);
/* timeline */
const tl=$("div",{class:"card mb14",id:"timeline"});
tl.append($("div",{class:"ph"},$("h2",{class:"m0",text:"What your agents did lately"}),$("span",{class:"ml-auto"},linkish("All blocked actions ›",()=>go("blocks",{tab:"all",pg:0})))));
const rec=arr(ov.recent).slice(0,8);
if(ov.recent==null&&ov.error)tl.append(errNote(ov,"the decision log"));
else if(!rec.length)tl.append(empty("Nothing recorded yet. Once a hook is connected, every agent action shows here."));
else{const ol=$("ol",{class:"tl"});rec.forEach(d=>{const c=d.context||{};const v=d.verdict;const ico=v==="allow"?["✓","p-ok"]:v==="deny"?["✕","p-bad"]:["?","p-warn"];
const li=$("li",{class:"click"+(v==="deny"?" deny":""),tabindex:"0"},$("span",{class:"ico "+ico[1],text:ico[0],"aria-hidden":"true"}),$("span",{class:"mono sub",text:when(d.at)}),$("span",{class:"what"},$("b",{text:short((c.action||"")+(c.scope?" "+scopeText(c.scope):""),120)}),$("div",{class:"sub",text:(VIA[d.by]||d.by||"—")+" · "+(d.ruleId||"—")})),pill(v==="allow"?"Allowed":v==="deny"?"Blocked":"Asked you",ico[1]));
const open=()=>mRecord(recordFromDecision(d));li.addEventListener("click",open);li.addEventListener("keydown",e=>{if(e.key==="Enter"){open();}});ol.append(li);});
tl.append(ol);}
tl.append($("p",{class:"sub",text:"Allowed actions are recorded too, so you can always see what an agent actually did."}));
m.append(tl);
/* chart + where the money went */
const two=$("div",{class:"grid two"});
two.append(chartCard());two.append(spendCard());m.append(two);
};
function recordFromDecision(d){const c=d.context||{};const r=d.ruleId;const type=d.verdict==="allow"?null:r==="secret"?"secret":r==="spend-cap"?"budget":r==="halt"?"halted":d.verdict==="require_approval"?"approval":"deny";
return {id:c.callId||"—",at:d.at,type:type,verdict:d.verdict,who:c.agent||d.by||"—",via:VIA[d.by]||d.by||"—",action:(c.action||"")+(c.scope?" "+scopeText(c.scope):""),why:d.why||("Matched rule "+r),rule:r,open:type==="secret",src:d};}
const SW=["sw0","sw1","sw2","sw3","sw4"];
function axisTicks(max){const raw=Math.max(max,0.0001)/4,b=Math.pow(10,Math.floor(Math.log10(raw)));const step=[1,1.5,2,2.5,3,4,5,6,8,10].find(m=>m*b>=raw*(1-1e-9))*b;let d=2;while(d<8&&Math.abs(step*Math.pow(10,d)-Math.round(step*Math.pow(10,d)))>1e-6)d++;const labels=[0,1,2,3,4].map(i=>"$"+(step*i).toFixed(d));return {top:step*4,labels:labels,pad:Math.ceil(Math.max.apply(null,labels.map(s=>s.length))*6.4)+8};}
function chartCard(){
const c=$("div",{class:"card"});c.append($("h2",{text:"Spend over the last 7 days, by agent"}));
if(!D.led.configured){c.append(empty("The chart needs the gateway ledger: start sakk ui --ledger <path>. Today’s local-log spend is on the first card."));return c;}
if(!D.ledOk){c.append(errNote(D.led,"the gateway ledger"));return c;}
const days=D.days;const ags=D.agentsSeen;const tot=days.map(k=>ags.reduce((s,a)=>s+((D.byDay[k]||{})[a]||0),0));
const max=Math.max.apply(null,tot.concat([0]));
if(!max){c.append(empty("No settled calls in the last 7 days."));}
else{const ax=axisTicks(max),W=560,H=180,pl=ax.pad,pb=22,bw=(W-pl-10)/7,top=ax.top;
const svg=sattr(svgEl("svg"),{viewBox:"0 0 "+W+" "+H,class:"chart",role:"img","aria-label":"Spend over the last 7 days, by agent"});
for(let i=0;i<5;i++){const y=(H-pb)-(H-pb-10)*i/4;svg.append(sattr(svgEl("line"),{x1:pl,x2:W-6,y1:y,y2:y,class:"gl"}));const t=sattr(svgEl("text"),{x:pl-4,y:y+3,"text-anchor":"end"});t.textContent=ax.labels[i];svg.append(t);}
days.forEach((k,i)=>{let y=H-pb;const x=pl+i*bw+bw*0.2;ags.forEach((a,j)=>{const v=(D.byDay[k]||{})[a]||0;if(!v)return;const h=(H-pb-10)*v/top;y-=h;const r=sattr(svgEl("rect"),{x:x,y:y,width:bw*0.6,height:Math.max(h,1),rx:2,class:"f"+Math.min(j,4)});const tt=svgEl("title");tt.textContent=a+" · "+k+" · "+usd(v);r.append(tt);svg.append(r);});
const lab=sattr(svgEl("text"),{x:pl+i*bw+bw/2,y:H-6,"text-anchor":"middle",class:i===6?"bold":""});lab.textContent=i===6?"Today":FMT_W.format(new Date(k+"T12:00:00Z"));svg.append(lab);});
c.append(svg);
const lg=$("div",{class:"legendrow"});ags.forEach((a,j)=>lg.append($("span",{},$("span",{class:"swatch "+SW[Math.min(j,4)]}),a)));c.append(lg);}
const sum=tot.reduce((a,b)=>a+b,0);const prev=tot.slice(0,6);const busiest=tot.indexOf(max);
c.append($("div",{class:"minis"},$("div",{},$("span",{class:"sub",text:"7-day total"}),$("b",{text:usd(sum)})),$("div",{},$("span",{class:"sub",text:"Daily average, excl. today"}),$("b",{text:usd(prev.reduce((a,b)=>a+b,0)/6)})),$("div",{},$("span",{class:"sub",text:"Busiest day"}),$("b",{text:max?(busiest===6?"Today":FMT_W.format(new Date(days[busiest]+"T12:00:00Z")))+" · "+usd(max):"—"}))));
c.append($("p",{class:"sub",text:"From the gateway ledger: settled cost by the day it settled. Calls made outside the gateway are not in this chart."}));
return c;}
function spendCard(){
const c=$("div",{class:"card",id:"spendcard"});
const n7=D.entries.filter(e=>in7(e.settledAt||e.createdAt));const s7=n7.reduce((s,e)=>s+(typeof e.actualUsd==="number"?e.actualUsd:0),0);
c.append($("div",{class:"ph"},$("h2",{class:"m0",text:"Where the money went"}),$("span",{class:"ml-auto"},btn("View details ›","sm",()=>go("calls",{q:"",agent:"",status:"",pg:0})))));
c.append($("p",{class:"sub m0-10",text:D.ledOk?(plural(n7.length,"call")+" in 7 days · "+usd(s7)+" through the gateway"):"By model: today, from local logs"}));
const bm=D.ov.by_model&&typeof D.ov.by_model==="object"?D.ov.by_model:{};const ms=Object.keys(bm).sort((a,b)=>bm[b]-bm[a]);
c.append($("h4",{class:"m6-12",text:"By model · today, local logs"}));
if(!ms.length)c.append(empty("No priced model calls today."));
else c.append(table("tight",["Model","Cost"],ms.map(x=>$("tr",{},td(x,"mono"),td(usd(bm[x]),"num")))));
c.append($("h4",{class:"m6-12",text:"By agent · 7 days, gateway ledger"}));
const la=D.ledAgents;const as=Object.keys(la).sort((a,b)=>la[b].usd7-la[a].usd7);
if(!D.ledOk)c.append(empty(D.led.configured?"The ledger could not be read.":"No gateway ledger configured."));
else if(!as.length)c.append(empty("No gateway calls yet."));
else{c.append(table("tight",["Agent","Calls","Cost"],as.map(a=>clickRow($("tr",{},td(a,"mono"),td(la[a].calls7,"num"),td(usd(la[a].usd7),"num")),()=>go("calls",{q:"",agent:a,status:"",pg:0})))));c.append($("p",{class:"sub",text:"Click an agent to see each of its calls."}));}
return c;}

/* ---------- spend log ---------- */
PAGES.calls=function(m){
const F=S.calls;
if(!D.led.configured){m.append($("div",{class:"card"},empty("No gateway ledger configured. Start sakk ui --ledger <path> to see each call the gateway reserved and settled. Today’s local-log spend is on Overview.")));return;}
if(!D.ledOk){m.append($("div",{class:"card"},errNote(D.led,"the gateway ledger")));return;}
const all=D.entries;const ags=[];all.forEach(e=>{const a=e.agentId||"unknown";if(ags.indexOf(a)<0)ags.push(a);});
const qv=F.q.trim().toLowerCase();
const rows=all.filter(e=>(!F.agent||(e.agentId||"unknown")===F.agent)&&(!F.status||e.status===F.status)&&(!qv||[e.taskId,e.runId,e.agentId,e.callId].some(x=>x&&String(x).toLowerCase().indexOf(qv)>=0)));
const tot=rows.reduce((s,e)=>s+(typeof e.actualUsd==="number"?e.actualUsd:0),0);
const sIn=$("input",{type:"search",id:"cfq",placeholder:"Search task, run, agent or call ID","aria-label":"Search calls",value:F.q});
sIn.addEventListener("input",()=>{F.q=sIn.value;F.pg=0;rerenderKeep("cfq");});
const aSel=$("select",{"aria-label":"Agent"},$("option",{value:"",text:"All agents"}),...ags.map(a=>$("option",{value:a,text:a,selected:F.agent===a})));aSel.addEventListener("change",()=>{F.agent=aSel.value;F.pg=0;render();});
const stSel=$("select",{"aria-label":"Status"},...[["","All statuses"],["SETTLED","Settled"],["RESERVED","Reserved"],["RECONCILIATION_REQUIRED","Needs reconciling"]].map(o=>$("option",{value:o[0],text:o[1],selected:F.status===o[0]})));stSel.addEventListener("change",()=>{F.status=stSel.value;F.pg=0;render();});
m.append($("div",{class:"toolbar"},sIn,aSel,stSel,btn("Clear filters","ghost sm",()=>{S.calls={q:"",agent:"",status:"",pg:0};render();}),$("span",{class:"sub grow-r",text:plural(rows.length,"call")+" · "+usd(tot)+" total"})));
const card=$("div",{class:"card"});
if(D.led.truncated)card.append($("p",{class:"note",text:"Showing the newest "+all.length+" of "+D.led.entries_total+" calls."}));
const P=15;const pg=Math.min(F.pg,Math.max(0,Math.ceil(rows.length/P)-1));const page=rows.slice(pg*P,pg*P+P);
if(!page.length)card.append(empty("No calls match these filters."));
else card.append(table("wide",["Time","Agent","Task / run","Model","Input","Output","Cost","Status","Cost source"],page.map(e=>clickRow($("tr",{},td(when(e.settledAt||e.createdAt),"nw"),td(e.agentId||"unknown","mono"),$("td",{},$("div",{class:"mono",text:e.taskId||"—"}),$("div",{class:"sub mono",text:e.runId||""})),td("—","sub"),td("—","sub num"),td("—","sub num"),costCell(e),$("td",{},statusPill(e.status)),$("td",{},$("span",{class:"tag",text:"Gateway ledger"}))),()=>mCall(e)))));
card.append($("p",{class:"sub",text:"Model and token counts are not in the ledger; the gateway records them in its own log."}));
card.append(pager(rows.length,P,pg,n=>{F.pg=n;render();}));
m.append(card);};
function costCell(e){if(e.status==="SETTLED")return td(usd(e.actualUsd),"num");if(e.status==="RESERVED")return td("≤ "+usd(e.estimatedMaxUsd),"num");return $("td",{},pill("Needs reconciling","p-warn"));}
function statusPill(s){return s==="SETTLED"?pill("Settled","p-ok"):s==="RECONCILIATION_REQUIRED"?pill("Needs reconciling","p-warn"):s==="RESERVED"?pill("Reserved","p-mute"):pill(String(s||"—"),"p-mute");}
function pager(total,P,pg,on){const n=Math.ceil(total/P);const w=$("div",{class:"pager"});if(total<=P){w.append($("span",{class:"sub",text:total?("1–"+total+" of "+total):""}));return w;}
w.append($("span",{class:"sub",text:(pg*P+1)+"–"+Math.min(total,pg*P+P)+" of "+total}));
const prev=btn("Previous","sm",()=>on(pg-1));if(pg===0)prev.disabled=true;w.append(prev);
let gap=false;for(let i=0;i<n;i++){if(n>7&&i>1&&i<n-2&&Math.abs(i-pg)>1){if(!gap)w.append($("span",{class:"sub",text:"…"}));gap=true;continue;}gap=false;const b=btn(String(i+1),"sm"+(i===pg?" pri":""),()=>on(i),{"aria-current":i===pg?"page":null});w.append(b);}
const next=btn("Next","sm",()=>on(pg+1));if(pg>=n-1)next.disabled=true;w.append(next);return w;}
function rerenderKeep(id){const el=document.getElementById(id);const pos=el?el.selectionStart:null;render();const n=document.getElementById(id);if(n){n.focus();try{if(pos!=null)n.setSelectionRange(pos,pos);}catch(_){}}}

/* ---------- blocked actions ---------- */
PAGES.blocks=function(m){
const F=S.blocks;const all=D.blocks;
const sets={open:all.filter(b=>b.open),closed:all.filter(b=>!b.open),all:all};
const tabs=$("div",{class:"tabs",role:"tablist"});
[["open","All open"],["closed","Closed"],["all","All"]].forEach(t=>{const b=$("button",{type:"button",role:"tab","aria-selected":F.tab===t[0]?"true":"false"},t[1],$("span",{class:"chipr",text:String(sets[t[0]].length)}));b.addEventListener("click",()=>{F.tab=t[0];F.pg=0;render();});tabs.append(b);});
m.append(tabs);
const qv=F.q.trim().toLowerCase();
const rows=sets[F.tab].filter(b=>(!F.type||b.type===F.type)&&(!qv||[b.id,b.who,b.action,b.why,b.rule].some(x=>x&&String(x).toLowerCase().indexOf(qv)>=0)));
const sIn=$("input",{type:"search",id:"bfq",placeholder:"Search ID, agent, action or reason","aria-label":"Search blocked actions",value:F.q});sIn.addEventListener("input",()=>{F.q=sIn.value;F.pg=0;rerenderKeep("bfq");});
const tSel=$("select",{"aria-label":"Type"},$("option",{value:"",text:"All types"}),...Object.keys(TYPES).map(k=>$("option",{value:k,text:TYPES[k][0],selected:F.type===k})));tSel.addEventListener("change",()=>{F.type=tSel.value;F.pg=0;render();});
m.append($("div",{class:"toolbar"},sIn,tSel,btn("Clear filters","ghost sm",()=>{F.q="";F.type="";F.pg=0;render();}),$("span",{class:"sub grow-r",text:plural(rows.length,"record")})));
const card=$("div",{class:"card"});
if(S.d.records&&S.d.records.error)card.append(errNote(S.d.records,"the decision log"));
if(S.d.records&&S.d.records.truncated)card.append($("p",{class:"note",text:"Only the newest records of the decision log are read here; export it on Records & export."}));
const P=10;const pg=Math.min(F.pg,Math.max(0,Math.ceil(rows.length/P)-1));const page=rows.slice(pg*P,pg*P+P);
if(!page.length)card.append(empty(F.tab==="open"?"Nothing is waiting on you.":"No blocked actions match these filters."));
else card.append(table("wide",["Time","Type","Who","Attempted action","Why it was stopped","Status",""],page.map(b=>{const t=TYPES[b.type];return clickRow($("tr",{},td(b.at?when(b.at):"Today","nw"),$("td",{},pill(t[0],t[1]),$("div",{class:"sub",text:b.via})),td(b.who,"mono"),td(short(b.action,90),"mono"),td(short(b.why,140)),$("td",{},blockStatus(b)),$("td",{},$("span",{class:"linkish",text:"View"}))),()=>mRecord(b));})));
card.append(pager(rows.length,P,pg,n=>{F.pg=n;render();}));
m.append(card);};
function blockStatus(b){if(b.type==="approval")return pill("Asks you · confirm in your agent","p-mute");if(b.type==="recon")return pill("Needs reconciling","p-warn");if(b.type==="secret"&&b.open)return pill("Needs handling","p-warn");if(b.type==="price")return pill("Needs a price","p-warn");return $("span",{class:"sub",text:"No action needed"});}

/* ---------- guard rules ---------- */
PAGES.policy=function(m){
const R=S.d.rules||{};
const tc=$("div",{class:"card mb14",id:"trycard"});tc.append($("h2",{text:"Try a request"}),$("p",{class:"sub m0-10",text:"Type an action and see what the policy decides"}));
const inp=$("input",{type:"search",id:"ptq",placeholder:"e.g. rm -rf ~/projects/old, or: cat .env.production","aria-label":"Command to try",maxlength:"2000"});
const res=$("div",{class:"tryres","aria-live":"polite"});
const run=()=>{const v=inp.value.trim();if(!v){res.textContent="";res.append($("span",{class:"sub",text:"Type a command first."}));return;}res.textContent="";res.append($("span",{class:"sub",text:"Checking…"}));
api("try?cmd="+encodeURIComponent(v)).then(r=>{res.textContent="";if(r.error){res.append(pill("Could not check","p-warn")," ",errText(r));return;}const v2=r.verdict;const p=v2==="allow"?pill("Allow","p-ok"):v2==="deny"?pill("Block","p-bad"):pill("Ask you","p-warn");const d0=arr(r.decisions);const rule=d0.length?d0.map(x=>x.rule).join(", "):"—";res.append(p," Matched rule ",$("b",{class:"mono ink",text:rule}));if(r.reason)res.append(" · ",r.reason);}).catch(e=>{res.textContent="";res.append(pill("Could not check","p-warn")," "+String(e&&e.message||e));});};
inp.addEventListener("keydown",e=>{if(e.key==="Enter")run();});
tc.append($("div",{class:"toolbar m0"},inp,btn("Check","pri",run)),res);m.append(tc);
const hc=$("div",{class:"card mb14"});hc.append($("h2",{text:"Current policy"}));
if(R.error){hc.append(errNote(R,"the policy"));m.append(hc);return;}
hc.append($("p",{class:"sub m0-10 mono",text:(R.policyPath||"—")+" · version "+(R.policyHash?String(R.policyHash).slice(0,6):"—")+" · default: "+verdictWord(R.defaultVerdict)}));
if(R.broken)hc.append($("p",{class:"note warn",text:"The guard cannot read this policy ("+R.broken+"). Reading the project still works; everything else is denied until a person fixes the file."}));
if(R.fallback)hc.append($("p",{class:"note warn",text:"The local policy could not be read, so the last good copy saved at "+fullWhen(R.fallback.savedAt)+" is in use."}));
const rules=arr(R.rules);
hc.append($("div",{class:"checks"},check("Rules",String(rules.length),"Top to bottom; the first match wins","ink"),check("Shadowed rules","—","Not checked in this version"),check("Allow-everything","—","Not checked in this version")));
hc.append($("p",{class:"sub m12t",text:"To change the rules, edit this file. The hook reads it on the next call."}));
m.append(hc);
const rc=$("div",{class:"card",id:"rulescard"});rc.append($("h2",{text:"Rules"}));
const hits={};D.decs.forEach(d=>{if(in7(d.at))hits[d.ruleId]=(hits[d.ruleId]||0)+1;});
if(!rules.length)rc.append(empty("No rules in this policy; every action gets the default decision."));
else rc.append(table("wide",["Rule","Applies to","Decision","Hits, 7 days","Why"],rules.map(r=>{const mt=r.match||{};return $("tr",{},td(r.id,"mono"),$("td",{},$("div",{class:"mono",text:mt.action||"any action"}),mt.scope?$("div",{class:"sub mono",text:scopeText(mt.scope)}):null),$("td",{},verdictPill(r.verdict,r.approvers_min)),td(String(hits[r.id]||0),"num"),td(r.why||r.reason||r.description||"—","sub"));})));
m.append(rc);};
function verdictWord(v){return v==="allow"?"allow":v==="deny"?"block":v==="require_approval"?"ask you":"—";}
function verdictPill(v,n){return v==="allow"?pill("Allow","p-ok"):v==="deny"?pill("Block","p-bad"):v==="require_approval"?pill("Ask you"+(n>1?" · "+n+" people":""),"p-warn"):pill(String(v||"—"),"p-mute");}
function check(label,value,sub,vcls){return $("div",{class:"check"},$("span",{class:"sub",text:label}),$("span",{class:"v"+(vcls?" "+vcls:""),text:value}),sub?$("span",{class:"sub",text:sub}):null);}

/* ---------- secret guard ---------- */
PAGES.dlp=function(m){
const sd=S.d.secret||{};const cards=arr(sd.cards);const n7=cards.filter(c=>c&&c.rule==="secret"&&in7(c.at)).length;
const c=$("div",{class:"card"});c.append($("h2",{text:"Pre-commit secret scan"}));
const blocked=$("span",{class:"v v-bad",text:String(n7)});
c.append($("div",{class:"checks"},check("Pre-commit hook","—","The console does not read your repository’s git hooks"),check("Detection rules","—","Taken from gitleaks; not counted here"),$("div",{class:"check"},$("span",{class:"sub",text:"Blocked, 7 days"}),blocked,linkish("See records",()=>go("blocks",{tab:"all",type:"secret",pg:0}))),check("What’s stored","Fingerprints only","The secret itself is never written","ink")));
c.append($("p",{class:"sub m12t"},"Install the hook: ",code("sakk scan --install-hook"),". Scanning runs locally and never goes online."));
m.append(c);
const a=$("div",{class:"card mt14",id:"secretacts"});a.append($("h2",{text:"Agents reaching for secrets"}));
if(sd.error)a.append(errNote(sd,"the decision log"));
else if(!cards.length)a.append(empty("No agent has reached for a secret. Once a hook is connected, an agent trying to read or print one is blocked and listed here."));
else a.append(table("wide",["Time","Tool","Attempted","Result"],cards.slice(0,50).map(x=>$("tr",{},td(when(x.at),"nw"),td(VIA[x.agent]||x.agent||"—"),td(short((x.action||"")+(x.scope?" "+scopeText(x.scope):""),100),"mono"),$("td",{},pill("Blocked","p-bad"))))));
a.append($("p",{class:"sub",text:sd.note||""}));
m.append(a);};

/* ---------- agents ---------- */
PAGES.agents=function(m){
const A=S.d.agents||{};
const cc=$("div",{class:"card mb14",id:"conncard"});cc.append($("h2",{text:"Connections"}));
if(A.error)cc.append(errNote(A,"the agent checks"));
[["claude-code","Claude Code","npx @sakk-dev/sakk guard install claude-code"],["cursor","Cursor","npx @sakk-dev/sakk guard install cursor"],["codex","Codex","npx @sakk-dev/sakk guard install codex"]].forEach(r=>{const h=hookState(r[0]);cc.append($("div",{class:"conn"},$("div",{},$("b",{text:r[1]}),$("div",{class:"sub",text:h.on?"Hook installed ("+h.where+")"+(h.failOpen?" · "+h.failOpen:""):h.detail})),code(r[2]),h.on?(h.failOpen?pill("Connected · fails open","p-warn"):pill("Connected","p-ok")):pill("Not connected","p-mute")));});
cc.append($("div",{class:"conn"},$("div",{},$("b",{text:"MCP gate "}),$("span",{class:"tag",text:"Experimental"}),$("div",{class:"sub",text:"For agents you wire up in code. The console cannot see whether one is running."})),code("npx sakk mcp"),pill("Not checked","p-mute")));
const warn=arr(A.checks).filter(x=>!x.ok);if(warn.length)cc.append($("p",{class:"note warn",text:warn.map(x=>x.name+": "+x.detail).join(" · ")}));
m.append(cc);
const rows=[];
AGENTS.forEach(id=>{const h=hookState(id);const mine=D.decs.filter(d=>d.by===id);const last=mine.length?mine[0].at:null;const blk=mine.filter(d=>d.verdict==="deny"&&in7(d.at)).length;rows.push({id:id,name:NAMES[id],via:VIA[id],last:last,calls:"—",blocked:blk,status:agentHalted(id)?"stopped":h.on?"on":"off",kind:"hook",hook:h});});
Object.keys(D.ledAgents).forEach(id=>{if(AGENTS.indexOf(id)>=0)return;const o=D.ledAgents[id];rows.push({id:id,name:id,via:"Gateway ledger",last:o.last,calls:o.calls7+" · "+usd(o.usd7),blocked:o.blocked,status:agentHalted(id)?"stopped":"on",kind:"ledger"});});
m.append(table("wide",["Agent","Last seen","7-day calls · spend","Blocked, 7 days","Status"],rows.map(r=>clickRow($("tr",{},$("td",{},$("b",{text:r.name}),$("div",{class:"sub",text:r.via})),td(r.last?when(r.last):"—","nw"),td(r.calls,"num"),td(String(r.blocked),"num"+(r.blocked?" v-bad":"")),$("td",{},r.status==="stopped"?pill("Stopped","p-bad"):r.status==="on"?(r.hook&&r.hook.failOpen?pill("Running · fails open","p-warn"):pill("Running","p-ok")):pill("Not connected","p-mute"))),()=>mAgent(r)))));
m.append($("p",{class:"sub",text:"Click a row to see how it connects and how to stop just this one. Hook agents’ spend is on Overview (local logs); gateway agents’ spend is from the ledger."}));};

/* ---------- records & export ---------- */
PAGES.data=function(m){
const A=S.d.agents||{};const cs=arr(A.checks);const dl=cs.find(c=>c.name==="decision log");
const L=D.led;const R=S.d.rules||{};const P=S.d.prices||{};
const files=[["Decision log",dl?dl.detail.replace(/ is writable$/,"").replace(/ will be created on the first call$/," (not created yet)"):"—","Every allow, block and ask from the hooks"],
["Gateway ledger",L.configured?(L.ledger||(D.st&&D.st.ledger)||"configured"):"Not configured","Each call the gateway reserved and settled"],
["Ledger alerts",L.alerts&&L.alerts.path?L.alerts.path:"—","Refusals, stops and lock events"],
["Policy",R.policyPath||"—","The guard rules"],
["Price list",P.source||"—","Prices spend is computed from"]];
const c=$("div",{class:"card"});c.append($("h2",{text:"Files on this machine"}));
c.append(table("wide",["Record","Where","What it holds"],files.map(f=>$("tr",{},td(f[0]),td(f[1],"mono"),td(f[2],"sub")))));
c.append($("p",{class:"sub",text:"Nothing here is uploaded. Back up or delete these files like any other file on your machine."}));
m.append(c);
const g=$("div",{class:"grid half mt14"});
g.append($("div",{class:"card"},$("h2",{text:"Were records altered?"}),$("div",{class:"checks"},check("Tamper check","—","Not in this version")),$("p",{class:"sub m12t",text:"A check that the decision log was not edited after the fact is planned; until then, keep the files where only you can write them."})));
const recs=arr(S.d.records&&S.d.records.decisions);
const ex=$("div",{class:"card"},$("h2",{text:"Export"}),$("p",{class:"sub m0-10",text:plural(recs.length,"record")+" from the decision log"+(S.d.records&&S.d.records.truncated?" (the newest ones)":"")}));
ex.append($("div",{class:"toolbar m0"},btn("CSV","",()=>{exportRows(recs,"csv");toast("Exported "+plural(recs.length,"record")+" as CSV.");},{disabled:recs.length?null:true}),btn("Audit records (JSONL)","",()=>{exportRows(recs,"jsonl");toast("Exported "+plural(recs.length,"record")+" as JSONL.");},{disabled:recs.length?null:true})));
ex.append($("p",{class:"sub",text:"A cell that starts with = + - @ is prefixed with a quote, so a spreadsheet does not run it."}));
g.append(ex);m.append(g);};
function exportRows(rows,fmt){let text,type;if(fmt==="jsonl"){text=rows.map(r=>JSON.stringify(r)).join("\\n");type="application/x-ndjson";}else{const q=s=>{let v=String(s==null?"":s);if(/^[=+\\-@\\t\\r]/.test(v))v="'"+v;return '"'+v.replace(/"/g,'""')+'"';};text=["at,by,verdict,ruleId,action,scope",...rows.map(r=>[r.at,r.by,r.verdict,r.ruleId,r.context&&r.context.action,r.context&&r.context.scope].map(q).join(","))].join("\\n");type="text/csv";}const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([text],{type}));a.download="sakk-decisions."+(fmt==="jsonl"?"jsonl":"csv");a.click();}

/* ---------- model prices ---------- */
PAGES.prices=function(m){
const P=S.d.prices||{};
if(P.error){m.append($("div",{class:"card"},errNote(P,"the price list")));return;}
m.append($("div",{class:"ph phtight"},$("span",{class:"sub mono wrap",text:"From LiteLLM’s public price list (MIT) · "+(P.source||"—")+" · "+plural(P.count||0,"model")+(P.approximate?" · approximate":"")})));
const F=S.pr;const qv=F.q.trim().toLowerCase();
const ms=arr(P.models).filter(x=>!qv||String(x.id).toLowerCase().indexOf(qv)>=0||vendor(x.id).toLowerCase().indexOf(qv)>=0);
const sIn=$("input",{type:"search",id:"mpq",placeholder:"Search model or vendor","aria-label":"Search models",value:F.q});sIn.addEventListener("input",()=>{F.q=sIn.value;F.pg=0;rerenderKeep("mpq");});
m.append($("div",{class:"toolbar"},sIn,$("span",{class:"sub grow-r",text:plural(ms.length,"model")})));
const c=$("div",{class:"card"});const per=v=>typeof v==="number"?"$"+(v*1e6).toFixed(v*1e6<1?3:2):"—";
const PG=20;const pg=Math.min(F.pg,Math.max(0,Math.ceil(ms.length/PG)-1));
if(!ms.length)c.append(empty("No model matches."));
else c.append(table("wide",["Vendor","Model","Input","Output","Cache read","Source","Method"],ms.slice(pg*PG,pg*PG+PG).map(x=>$("tr",{},td(vendor(x.id)),td(x.id,"mono"),td(per(x.input),"num"),td(per(x.output),"num"),td(per(x.cacheRead),"num"),$("td",{},$("span",{class:"tag",text:"Price list"})),td("Tokens × price","sub")))));
c.append($("p",{class:"sub",text:"USD per million tokens. A model missing from this list is unpriced: calls to it are counted on Blocked actions, never guessed."}));
c.append(pager(ms.length,PG,pg,n=>{F.pg=n;render();}));
m.append(c);};
function vendor(id){id=String(id||"").toLowerCase();if(id.indexOf("/")>0)id=id.split("/").pop();if(id.indexOf("claude")===0)return "Anthropic";if(/^(gpt|o\\d|chatgpt|text-embedding)/.test(id))return "OpenAI";if(id.indexOf("gemini")===0)return "Google";if(id.indexOf("deepseek")===0)return "DeepSeek";if(id.indexOf("minimax")===0)return "MiniMax";if(id.indexOf("grok")===0)return "xAI";if(/^(mistral|codestral|magistral)/.test(id))return "Mistral";if(id.indexOf("qwen")===0)return "Alibaba";return "—";}

/* ---------- enterprise ---------- */
PAGES.upgrade=function(m){
const c=$("div",{class:"card soon",id:"soon"});
c.append($("span",{class:"soontag",text:"Coming soon"}),$("h2",{text:"Sakk for teams"}),$("p",{text:"The open-source edition covers one machine and one person, free for good. A version for teams is in the works:"}));
c.append($("ul",{class:"soonlist"},$("li",{text:"Several people manage agents together, with company sign-in"}),$("li",{text:"Actions that need approval go to an approver instead of being refused"}),$("li",{text:"Evidence for auditors and regulators"})));
c.append($("p",{class:"sub m0",text:"Not shown in the open-source edition: none of this is built yet, and nothing here is for sale."}));
c.append($("p",{class:"sub m0",text:"Nothing already in the open-source edition will move into the enterprise one."}));
c.append($("p",{class:"sub m0"},"Leave a note to hear first, or to tell us about your setup: ",code("github.com/sakk-dev/sakk/discussions"),"."));
m.append(c);};

/* ---------- modals ---------- */
function openModal(title,body,foot,opts){closeModal();const o=opts||{};
const scrim=$("div",{class:"scrimbg"});scrim.addEventListener("click",closeModal);
const mh=$("div",{class:"mh"});if(o.pill)mh.append(o.pill);mh.append($("h3",{id:"mh",text:title}));
const md=$("div",{class:"modal"+(o.lg?" lg":""),role:"dialog","aria-modal":"true","aria-labelledby":"mh"},mh);
if(o.wiz)md.append(o.wiz);
md.append($("div",{class:"mb"},...body),$("div",{class:"mf"},...foot));
document.body.append(scrim,md);S.modal={scrim:scrim,md:md,back:document.activeElement};
const f=md.querySelector("input,select,.mf .btn.pri,.mf .btn.danger,.mf .btn");if(f)f.focus();return md;}
function closeModal(){if(!S.modal)return;S.modal.scrim.remove();S.modal.md.remove();const b=S.modal.back;S.modal=null;if(b&&b.isConnected)try{b.focus();}catch(_){}}
function kv(pairs){const d=$("dl",{class:"kv"});pairs.forEach(p=>{if(p==null)return;d.append($("dt",{text:p[0]}),$("dd",{class:p[2]||null},p[1] instanceof Node?p[1]:document.createTextNode(p[1]==null||p[1]===""?"—":String(p[1]))));});return d;}
function mRecord(b){const t=b.type?TYPES[b.type]:["Allowed","p-ok"];
const body=[kv([["Time",b.at?fullWhen(b.at):"Today"],["Who",b.who+" · "+b.via],["Attempted",b.action,"mono"],[b.type?"Why stopped":"Why",b.why],["Stopped at",b.via],["Rule",b.rule,"mono"],["ID",b.id,"mono"]])];
if(b.type==="recon")body.push($("div",{class:"sec"},$("h4",{text:"Reconciling"}),$("p",{class:"sub m0",text:HELP.recon})));
if(b.type&&ABILITY[b.type])body.push($("p",{class:"note",text:ABILITY[b.type]}));
openModal(b.type?t[0]:"Allowed action",body,[btn("Close","pri",closeModal)],{pill:pill(t[0],t[1])});}
function mCall(e){
const steps=$("ol",{class:"steps"});
steps.append($("li",{class:"done"},$("div",{},$("b",{text:"Reserved"}),$("div",{class:"sub",text:fullWhen(e.createdAt)+" · up to "+usd(e.estimatedMaxUsd)}))));
if(e.status==="SETTLED")steps.append($("li",{class:"done"},$("div",{},$("b",{text:"Settled"}),$("div",{class:"sub",text:fullWhen(e.settledAt)+" · "+usd(e.actualUsd)}))));
else if(e.status==="RECONCILIATION_REQUIRED")steps.append($("li",{class:"no"},$("div",{},$("b",{text:"Needs reconciling"}),$("div",{class:"sub",text:"The final cost was not confirmed. Run sakk reconcile --by <your name>."}))));
else steps.append($("li",{class:"now"},$("div",{},$("b",{text:"In flight"}),$("div",{class:"sub",text:"Not settled yet; up to "+usd(e.estimatedMaxUsd)+" is held against the cap."}))));
openModal("Call "+short(e.callId||"",40),[kv([["Task",e.taskId,"mono"],["Run",e.runId,"mono"],["Agent",e.agentId,"mono"],["Model","— (not in the ledger)"],["Cost",e.status==="SETTLED"?usd(e.actualUsd):e.status==="RESERVED"?"≤ "+usd(e.estimatedMaxUsd):"Needs reconciling"],["Status",statusPill(e.status)],["Call ID",e.callId,"mono"]]),$("div",{class:"sec"},$("h4",{text:"Trail"}),steps)],[btn("Close","pri",closeModal)],{pill:statusPill(e.status)});}
function mAgent(r){
const h=r.hook;const recent=r.kind==="hook"?D.blocks.filter(b=>b.src&&b.src.by===r.id).slice(0,5):D.blocks.filter(b=>b.via==="Gateway ledger"&&b.who===r.id).slice(0,5);
const body=[kv([["Connects via",r.via],["Name source",r.kind==="hook"?"The hook reports itself as "+r.id:"The agent ID the gateway sent"],["Status",r.status==="stopped"?"Stopped":r.status==="on"?(h&&h.failOpen?"Running · fails open":"Running"):"Not connected"],["Last seen",r.last?fullWhen(r.last):"—"],h?["Hook",h.detail]:null,h&&h.failOpen?["Fails open",h.failOpen]:null])];
body.push($("div",{class:"sec"},$("h4",{text:"Recently blocked"}),recent.length?$("div",{},...recent.map(b=>$("div",{class:"minirow"},$("span",{class:"mono sub",text:b.at?when(b.at):"Today"}),$("span",{text:short(b.action,60)}),pill(TYPES[b.type][0],TYPES[b.type][1])))):empty("Nothing blocked recently.")));
body.push($("p",{class:"note",text:"To stop it with your name and a reason, run sakk halt --agent "+r.id+" --by <your name> --reason “…”. A person resumes with sakk resume --by <your name> --agent "+r.id+"."}));
const foot=[btn("Close","",closeModal)];
if(r.status!=="stopped"&&!(D.halt&&D.halt.scope==="all")){const s=btn("Stop "+r.id+" only","danger",()=>{if(!ALLOW_HALT){toast("Read-only console: start it with sakk ui --allow-halt to use the stop button.");return;}mHaltWizard(r.id);});if(!ALLOW_HALT)s.setAttribute("aria-disabled","true");foot.push(s);}
openModal(r.name,body,foot,{pill:r.status==="stopped"?pill("Stopped","p-bad"):r.status==="on"?(h&&h.failOpen?pill("Running · fails open","p-warn"):pill("Running","p-ok")):pill("Not connected","p-mute")});}
function mHalt(){const h=D.halt;if(!h)return;
openModal("Stopped: "+h.scope,[kv([["Stopped by",(h.by||"—")+" (self-declared)"],["Time",fullWhen(h.at)],["Reason",h.reason||"—"],["Scope",h.scope==="all"?"All agents":h.agents.join(", ")]]),
$("div",{class:"cols mt10"},$("div",{class:"box stop"},$("b",{text:"Being denied"}),$("ul",{},$("li",{text:"New model calls through the gateway"}),$("li",{text:"Commands through the guard hooks (reading the project still works)"}),$("li",{text:"New budget reservations"}))),$("div",{class:"box keep"},$("b",{text:"Not affected"}),$("ul",{},$("li",{text:"A call that was already in flight"}),$("li",{text:"Actions outside Sakk"}),$("li",{text:"Anything already done"})))),
$("p",{class:"note",text:"Resuming is done in a terminal, by a person: sakk resume --by <your name>"+(h.scope!=="all"?" --agent "+h.agents[0]:"")+". The console does not resume agents."})],[btn("Close","pri",closeModal)],{pill:pill("Stopped","p-bad")});}
function wiz(n){const w=$("div",{class:"wiz"});["1 Scope and reason","2 Confirm","3 In effect"].forEach((t,i)=>w.append($("span",{class:i===n?"on":null,text:t})));return w;}
function mHaltWizard(pre){
const A=S.d.agents||{};const ready=A.haltReady!==false&&!(S.d.agents&&S.d.agents.error);
const ids=AGENTS.concat(Object.keys(D.ledAgents).filter(a=>AGENTS.indexOf(a)<0));
let scope=pre||"";
const step1=()=>{
const sel=$("select",{id:"hScope"},$("option",{value:"",text:"All agents"}),...ids.map(a=>$("option",{value:a,text:a,selected:scope===a})));
const body=[$("p",{class:"note",text:"A stop covers new requests through Sakk on this machine. The console records your OS account name as the person who stopped it (self-declared, not a verified identity) and the reason “self-declared via sakk ui”. To give your own name and reason use sakk halt in a terminal. Resuming is always done in a terminal with sakk resume."}),
$("div",{class:"field"},$("label",{for:"hScope",text:"Scope"}),sel)];
let blocked=false;
if(!TOKEN){blocked=true;body.push($("p",{class:"note warn",text:"Open the address sakk ui printed (it carries the token), then try again."}));}
if(!ready){blocked=true;body.push($("p",{class:"note warn",text:"A stop is kept in the gateway ledger, and this console has none. Start it with sakk ui --ledger <path> --allow-halt."}));}
const next=btn("Next","pri",()=>{scope=sel.value;step2();});if(blocked)next.disabled=true;
openModal("Emergency stop",body,[btn("Cancel","ghost",closeModal),next],{wiz:wiz(0)});};
const step2=()=>{
const inp=$("input",{id:"hType",autocomplete:"off",spellcheck:"false"});const err=$("p",{class:"err","aria-live":"polite"});
const go2=btn("Stop now","danger",()=>{if(inp.value.trim()!=="STOP"){err.textContent="Type STOP in capitals to confirm.";inp.focus();return;}go2.disabled=true;err.textContent="";
fetch("/api/halt",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Sakk-Token":TOKEN},body:JSON.stringify(scope?{agent:scope}:{})}).then(x=>x.json().catch(()=>({error:"HTTP_"+x.status}))).then(r=>{if(r&&r.halted)step3(r);else{go2.disabled=false;err.textContent=haltErr(r);}}).catch(e=>{go2.disabled=false;err.textContent="The console did not answer: "+String(e&&e.message||e);});});
inp.addEventListener("keydown",e=>{if(e.key==="Enter")go2.click();});
openModal("Confirm stop: "+(scope||"all agents"),[$("div",{class:"cols"},$("div",{class:"box stop"},$("b",{text:"Will stop"}),$("ul",{},$("li",{text:"New model calls through the gateway"}),$("li",{text:"Commands through the guard hooks (reading the project still works)"}),$("li",{text:"New budget reservations"}))),$("div",{class:"box keep"},$("b",{text:"Won’t stop"}),$("ul",{},$("li",{text:"The call already in flight"}),$("li",{text:"Actions outside Sakk"}),$("li",{text:"Nothing already done is undone"})))),
$("div",{class:"field mt10"},$("label",{for:"hType",text:"Type STOP to confirm"}),inp),err],[btn("Back","ghost",step1),go2],{wiz:wiz(1),pill:pill(scope||"All agents","p-bad")});};
const step3=r=>{openModal("Stopped: "+(r.scope==="all"?"all agents":r.scope),[kv([["Stopped by",r.by+" (self-declared)"],["Scope",r.scope==="all"?"All agents":r.scope],["Note",r.note]]),r.already?$("p",{class:"note",text:"It was already stopped; nothing changed."}):null,$("p",{class:"note",text:"New requests are refused from now on. A person resumes with sakk resume --by <your name>"+(r.scope!=="all"?" --agent "+r.scope:"")+" in a terminal."})].filter(Boolean),[btn("Done","pri",()=>{closeModal();load();})],{wiz:wiz(2),pill:pill("Stopped","p-bad")});};
step1();}
function haltErr(r){if(!r)return "No answer from the console.";if(r.error==="HTTP_405")return "This console is read-only. Start it with sakk ui --allow-halt.";if(r.error==="HTTP_403")return "The console refused the request: open the address sakk ui printed (it carries the token) and try again.";if(r.error==="CONSOLE_NO_LEDGER")return "No gateway ledger: start sakk ui --ledger <path> --allow-halt.";return (r.error||"Error")+(r.message?": "+r.message:"");}

/* ---------- help pops and the stop tip ---------- */
function closePop(){if(S.pop){S.pop.remove();S.pop=null;}if(S.tip){S.tip.remove();S.tip=null;}}
function place(p,el){const r=el.getBoundingClientRect();const w=p.offsetWidth;p.style.left=Math.max(12,Math.min(r.right-w,innerWidth-w-12))+"px";let t=r.bottom+8;if(t+p.offsetHeight>innerHeight-8)t=Math.max(8,r.top-p.offsetHeight-8);p.style.top=t+"px";}
document.addEventListener("click",e=>{const b=e.target.closest&&e.target.closest("[data-help]");if(b){e.stopPropagation();const key=b.getAttribute("data-help");if(S.pop&&S.pop.dataset.k===key){closePop();return;}closePop();const p=$("div",{class:"pop",role:"tooltip","data-k":key},$("span",{text:HELP[key]||""}));document.body.append(p);place(p,b);S.pop=p;return;}if(S.pop&&!(e.target.closest&&e.target.closest(".pop,.menu,.userchip")))closePop();},true);
function userMenu(anchor){if(S.pop&&S.pop.classList.contains("menu")){closePop();return;}closePop();
const r=anchor.getBoundingClientRect();const b=$("button",{type:"button",role:"menuitem",text:"Replay the tour"});b.addEventListener("click",()=>{closePop();startTour(0);});
const m=$("div",{class:"menu",role:"menu","aria-label":"Local user"},b);
if(SIGN_IN){const o=$("button",{type:"button",role:"menuitem",text:"Sign out"});o.addEventListener("click",()=>{closePop();fetch("/logout",{method:"POST",credentials:"same-origin"}).then(()=>location.replace("/"),()=>toast("The console did not answer."));});m.append(o);}
m.style.right=Math.max(8,innerWidth-r.right)+"px";m.style.top=(r.bottom+6)+"px";document.body.append(m);S.pop=m;b.focus();}
function tipBody(){const h=D.halt;const p=$("div",{class:"pop tip",role:"tooltip"});
if(h){p.append($("b",{text:"Stopped ("+h.scope+")"}),$("div",{text:(h.by||"Someone")+" stopped agents at "+when(h.at)+". Reason: "+(h.reason||"—")+"."}),$("b",{text:"How to resume"}),$("div",{text:"Run sakk resume --by <your name> in a terminal."}));return p;}
p.append($("b",{text:"Why stop"}),$("div",{text:"Cut losses first when an agent misbehaves, then investigate."}),$("b",{text:"What happens"}),$("ul",{},$("li",{text:"Every new request through Sakk on this machine is refused"}),$("li",{text:"Agents connected through Claude Code, Cursor or Codex hooks can’t run commands"}),$("li",{text:"A call already in flight finishes and is billed"})),$("b",{text:"How to resume"}),$("div",{text:"Run sakk resume --by <your name> in a terminal."}));
if(!ALLOW_HALT)p.append($("b",{text:"Read-only"}),$("div",{text:"This console was started without --allow-halt. Start it with sakk ui --allow-halt to use the button."}));return p;}
document.addEventListener("mouseover",e=>{const t=e.target.closest&&e.target.closest("[data-tip]");if(t&&!S.tip&&S.tour<0){S.tip=tipBody();document.body.append(S.tip);place(S.tip,t);}else if(!t&&S.tip){S.tip.remove();S.tip=null;}});
document.addEventListener("focusin",e=>{const t=e.target.closest&&e.target.closest("[data-tip]");if(S.tip){S.tip.remove();S.tip=null;}if(t&&S.tour<0){S.tip=tipBody();document.body.append(S.tip);place(S.tip,t);}});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){if(S.tour>=0){endTour(true);return;}closePop();closeModal();}});

/* ---------- tour ---------- */
let tourEls=null;
function saveTour(v){try{localStorage.setItem(TOUR_KEY,String(v));}catch(_){}}
function startTour(i){closeModal();closePop();S.tour=i;showStep();}
function endTour(done){S.tour=-1;if(tourEls){tourEls.hole.remove();tourEls.card.remove();tourEls=null;}saveTour(done?"done":"skipped");}
function showStep(){const st=TOUR[S.tour];if(!st){endTour(true);return;}
if(S.page!==st[0])go(st[0]);
const el=document.querySelector(st[1]);
if(tourEls){tourEls.hole.remove();tourEls.card.remove();}
const hole=$("div",{class:"tourhole"});
const i=S.tour;const prog=$("div",{class:"tprog"});TOUR.forEach((_,j)=>prog.append($("i",{class:j<i?"done":j===i?"on":null})));
const row=$("div",{class:"row"},btn("Skip","ghost sm",()=>endTour(false)),$("span",{class:"grow"}));
if(i>0)row.append(btn("Back","sm",()=>{S.tour--;showStep();}));
row.append(btn(i===TOUR.length-1?"Get started":"Next","pri sm",()=>{S.tour++;if(S.tour>=TOUR.length)endTour(true);else{saveTour(S.tour);showStep();}}));
const card=$("div",{class:"tourcard",role:"dialog","aria-label":"Tour"},$("span",{class:"n",text:"Open-source tour · Step "+(i+1)+" of "+TOUR.length}),$("h4",{text:st[2]}),$("div",{class:"tg"},$("b",{text:"Goal"}),$("p",{text:st[3]})),$("div",{class:"tg"},$("b",{text:"How to use it"}),$("p",{text:st[4]})),prog,row);
document.body.append(hole,card);tourEls={hole:hole,card:card};
if(el){el.scrollIntoView({block:"center",behavior:"instant"});}
requestAnimationFrame(()=>{const r=el?el.getBoundingClientRect():{left:innerWidth/2,top:innerHeight/2,width:0,height:0,right:innerWidth/2,bottom:innerHeight/2};
hole.style.left=(r.left-6)+"px";hole.style.top=(r.top-6)+"px";hole.style.width=(r.width+12)+"px";hole.style.height=(r.height+12)+"px";
const cw=card.offsetWidth,ch=card.offsetHeight;let top=r.bottom+14;if(top+ch>innerHeight-12)top=r.top-ch-14;if(top<12)top=Math.max(12,innerHeight-ch-12);
card.style.top=top+"px";card.style.left=Math.max(12,Math.min(r.left,innerWidth-cw-12))+"px";const f=card.querySelector(".btn.pri");if(f)f.focus();});}
window.addEventListener("resize",()=>{if(S.tour>=0)showStep();else closePop();});

/* ---------- start ---------- */
function gatewayBanners(main){const g=S.d.gateway;const st=g&&g.status;if(!st)return;
if(st.error){main.append($("p",{class:"note warn",role:"status",text:"The gateway status file could not be read ("+st.error+"): "+st.message}));}
else if(st.outage){const o=st.outage;const since="The gateway reports Sakk has not answered since "+when(o.since)+". ";
if(st.mode==="deny")main.append($("div",{class:"haltbar",role:"alert"},$("b",{text:"Sakk unreachable · calls refused (deny mode)"}),$("span",{class:"grow",text:since+"SAKK_ON_UNAVAILABLE=deny, so every call gets HTTP 503 until Sakk answers."+(o.allowed_calls>0?" Earlier in this outage "+plural(o.allowed_calls,"call")+" went through unmetered, up to "+usd(o.est_max_unrecorded_usd)+" not recorded in the ledger.":"")})));
else main.append($("div",{class:"haltbar",role:"alert"},$("b",{text:"Sakk unreachable · calls going through unmetered"}),$("span",{class:"grow",text:since+plural(o.allowed_calls,"call")+" let through, up to "+usd(o.est_max_unrecorded_usd)+" not recorded in the ledger and not capped."})));}
else if(st.last_outage){const o=st.last_outage,a=when(o.since),b=when(o.ended_at);main.append($("p",{class:"note warn",role:"status",text:"Last Sakk outage: "+(a===b?a+", under a minute":a+" to "+b)+". "+(o.allowed_calls>0?"The gateway let "+plural(o.allowed_calls,"call")+" through, up to "+usd(o.est_max_unrecorded_usd)+" not recorded in the ledger. Check the provider's bill for that window.":"No calls went through unmetered.")}));}
const p=g.probe;if(p&&!p.ok)main.append($("div",{class:"haltbar",role:"alert"},$("b",{text:"Gateway not answering at "+p.url}),$("span",{class:"grow",text:"The health check got "+(p.status?"HTTP "+p.status:p.error)+". The status above is the last one the gateway wrote."})));}
function load(){return Promise.all([api("overview"),api("ledger"),api("rules"),api("records"),api("agents"),api("prices"),api("secret"),api("forbidden"),api("gateway")].map(p=>p.catch(e=>({error:"FETCH_FAILED",message:String(e&&e.message||e)})))).then(r=>{["overview","ledger","rules","records","agents","prices","secret","forbidden","gateway"].forEach((n,i)=>{S.d[n]=r[i];});derive();render();if(S.tour>=0)showStep();});}
const h0=location.hash.slice(1);if(TITLES[h0])S.page=h0;
load();
})();</script>
</body>
</html>`;
}
