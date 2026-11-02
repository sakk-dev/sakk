/**
 * The LiteLLM gateway's own outage record, written by
 * integrations/litellm/sakk_gateway.py, read here for `sakk status` and the
 * console. Read-only. The file is the gateway's report about itself: calls it
 * let through while Sakk could not answer are in this file, never in the
 * ledger, so nothing here is presented as a ledger record.
 */
import { openSync, fstatSync, readSync, closeSync, realpathSync, constants as FS } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, join, resolve } from 'node:path';

export const GATEWAY_STATUS_MAX_BYTES = 64 * 1024;
export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:4000';
const SOURCE = 'from the gateway status file';

/**
 * The same rule as status_path_for in sakk_gateway.py: the ledger's folder
 * with every link resolved, the ledger's file name, then ".gateway.json". It
 * mirrors the folder half of canonicalLedgerPath in ledger.mjs (not exported,
 * and it also refuses a linked ledger file, which is not this reader's job),
 * so a relative path or a path through a linked folder names the one file the
 * gateway writes. A folder that does not exist falls back to the absolute path;
 * no ledger, and so no gateway, can be there either.
 */
export function gatewayStatusPathFor(ledgerPath, env = process.env) {
  if (env.SAKK_GATEWAY_STATUS) return env.SAKK_GATEWAY_STATUS;
  const abs = resolve(ledgerPath);
  let dir;
  try {
    dir = realpathSync(dirname(abs));
  } catch {
    dir = dirname(abs);
  }
  return `${join(dir, basename(abs))}.gateway.json`;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const amount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const text = (v) => typeof v === 'string';

function outageOf(v, ended) {
  if (v === null || v === undefined) return null;
  if (
    !isObj(v) ||
    !text(v.since) ||
    !count(v.allowed_calls) ||
    !amount(v.est_max_unrecorded_usd) ||
    !text(v.last_reason ?? '') ||
    !text(v.last_at ?? '') ||
    (ended && !text(v.ended_at))
  )
    throw new TypeError(ended ? 'last_outage' : 'outage');
  const o = {
    since: v.since,
    allowed_calls: v.allowed_calls,
    est_max_unrecorded_usd: v.est_max_unrecorded_usd,
    last_reason: v.last_reason ?? '',
    last_at: v.last_at ?? '',
  };
  if (ended) o.ended_at = v.ended_at;
  return o;
}

function readCapped(path, maxBytes) {
  // O_NOFOLLOW: a link planted at the status path is an error, not a redirect.
  // O_NONBLOCK: a FIFO there cannot hang the reader.
  const fd = openSync(path, FS.O_RDONLY | FS.O_NONBLOCK | FS.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: 'GATEWAY_STATUS_UNREADABLE', message: 'not a regular file' };
    if (st.size > maxBytes)
      return {
        error: 'GATEWAY_STATUS_TOO_BIG',
        message: `the status file is ${st.size} bytes, over the ${maxBytes}-byte limit — not read`,
      };
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < st.size) {
      const r = readSync(fd, buf, n, st.size - n, n);
      if (r === 0) break;
      n += r;
    }
    return { text: buf.subarray(0, n).toString('utf8') };
  } finally {
    closeSync(fd);
  }
}

/**
 * null when there is no status file (no gateway has written one). Otherwise
 * the file's fields, or { path, error, message } when it cannot be trusted.
 */
export function gatewayStatus({
  ledgerPath,
  env = process.env,
  maxBytes = GATEWAY_STATUS_MAX_BYTES,
} = {}) {
  if (!ledgerPath && !env.SAKK_GATEWAY_STATUS) return null;
  const path = gatewayStatusPathFor(ledgerPath, env);
  let got;
  try {
    got = readCapped(path, maxBytes);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return {
      path,
      source: SOURCE,
      error: 'GATEWAY_STATUS_UNREADABLE',
      message: `${e.code ?? 'error'}: cannot read the gateway status file`,
    };
  }
  if (got.error) return { path, source: SOURCE, ...got };
  try {
    const doc = JSON.parse(got.text);
    if (!isObj(doc) || doc.version !== 1) throw new TypeError('version');
    if (!text(doc.updatedAt)) throw new TypeError('updatedAt');
    if (doc.mode !== undefined && doc.mode !== 'allow' && doc.mode !== 'deny')
      throw new TypeError('mode');
    return {
      path,
      source: SOURCE,
      version: 1,
      updatedAt: doc.updatedAt,
      mode: doc.mode ?? null,
      outage: outageOf(doc.outage, false),
      last_outage: outageOf(doc.last_outage, true),
    };
  } catch (e) {
    return {
      path,
      source: SOURCE,
      error: 'GATEWAY_STATUS_INVALID',
      message: `the gateway status file is not the expected shape (${e instanceof SyntaxError ? 'not JSON' : e.message})`,
    };
  }
}

/**
 * GET <url>/health/liveliness, which LiteLLM serves without a key. Resolves,
 * never rejects: { url, ok, status } or { url, ok: false, error }. The timer
 * caps the whole exchange, not just socket idle time.
 */
export function probeGateway({ url = DEFAULT_GATEWAY_URL, timeoutMs = 500 } = {}) {
  let target;
  try {
    target = new URL(`${String(url).replace(/\/+$/, '')}/health/liveliness`);
  } catch {
    return Promise.resolve({ url: String(url), ok: false, error: 'GATEWAY_URL_INVALID' });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:')
    return Promise.resolve({ url: String(url), ok: false, error: 'GATEWAY_URL_INVALID' });
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req?.destroy();
      resolve({ url: String(url), ...r });
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    timer.unref?.();
    try {
      req = send(target, { method: 'GET', timeout: timeoutMs }, (res) => {
        res.resume();
        finish({ ok: res.statusCode === 200, status: res.statusCode });
      });
      req.on('error', (e) => finish({ ok: false, error: e.code ?? 'error' }));
      req.on('timeout', () => finish({ ok: false, error: 'timeout' }));
      req.end();
    } catch (e) {
      finish({ ok: false, error: e.code ?? 'error' });
    }
  });
}

/**
 * The console's /api/gateway answer. The probe runs only when a status file
 * exists, and one result (or the one in flight) is shared for cacheMs, so
 * page loads add at most one probe per window.
 */
export function gatewayView({
  ledgerPath,
  env = process.env,
  now = Date.now,
  probe = probeGateway,
  cacheMs = 5000,
}) {
  let cached = null;
  return async () => {
    const status = gatewayStatus({ ledgerPath, env });
    if (!status) return { source: SOURCE, status: null, probe: null };
    const url = env.SAKK_GATEWAY_URL || DEFAULT_GATEWAY_URL;
    const t = now();
    if (!cached || cached.url !== url || t - cached.at >= cacheMs)
      cached = { at: t, url, result: probe({ url }) };
    return { source: SOURCE, status, probe: await cached.result };
  };
}
