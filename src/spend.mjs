// SPDX-License-Identifier: AGPL-3.0-only
//
// Spend from local logs (specs/spend/spec.md). Reads what Claude Code already
// writes — ~/.claude/projects/**/*.jsonl — incrementally, and prices it.
// Spend never goes down: a log that shrinks or is rewritten keeps what was
// counted (LOG_REWRITTEN). The guard's cap check reads only today's changes.
//
// Index under SAKK_HOME/spend/:
//   files.json         { "<log path>": { offset, size, mtimeMs, head } }
//   days/<YYYY-MM-DD>.json  { "<message.id>|<requestId>": { model, usage, ts } }
// Writes are atomic (temp + rename); entries merge by maximum per field, so two
// processes updating at once can re-read lines but never lose or double them.

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './append.mjs';
import { costOf, priceOf } from './prices.mjs';

export const MAX_LINE = 1024 * 1024;
export const MAX_FILES = 50_000;
const HEAD = 4096;

export class SpendError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** Where Claude Code writes its transcripts: fixed when the cap was set, not read from the agent. */
export const claudeLogDir = (env = process.env) =>
  join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'), 'projects');

/** The calendar day of a time in a zone, as YYYY-MM-DD. */
export function dayOf(ms, timeZone) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return f.format(new Date(ms));
}
export const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Every *.jsonl under `dir`, without following links out of it; bounded. */
export function listLogs(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES)
        throw new SpendError(
          'SPEND_TOO_MANY_LOGS',
          `more than ${MAX_FILES} log files under ${dir}`,
        );
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const finiteNonNeg = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
// Token counts must be whole numbers: costOf rejects a fractional count deep in
// pricing, so screen it here at the parse boundary instead (F-170).
const tokenCount = (x) => finiteNonNeg(x) && Number.isInteger(x);
const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
];
const CACHE_SPLIT_FIELDS = ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'];

/**
 * One transcript line → null (not a priced call), { call } or { unreadable }.
 * A call is keyed by (message.id, requestId); a line with neither is keyed by
 * its own content hash and flagged UNKEYED.
 */
export function parseLine(line) {
  if (line.length > MAX_LINE) return { unreadable: 'line over 1 MiB' };
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return { unreadable: 'not JSON' };
  }
  if (o?.type !== 'assistant' || o.message?.usage === undefined) return null;
  const u = o.message.usage;
  if (u === null || typeof u !== 'object') return { unreadable: 'usage is not an object' };
  for (const k of USAGE_FIELDS)
    if (u[k] !== undefined && u[k] !== null && !tokenCount(u[k]))
      return { unreadable: `${k} is not a whole-token count` };
  const cc = u.cache_creation;
  if (cc !== undefined && cc !== null) {
    if (typeof cc !== 'object' || Array.isArray(cc))
      return { unreadable: 'cache_creation is not an object' };
    // Read as 0, a malformed split field would drop those writes from the bill
    // whenever the aggregate is missing (F-179).
    for (const k of CACHE_SPLIT_FIELDS)
      if (cc[k] !== undefined && cc[k] !== null && !tokenCount(cc[k]))
        return { unreadable: `cache_creation.${k} is not a whole-token count` };
  }
  const ts = Date.parse(o.timestamp);
  if (!Number.isFinite(ts)) return { unreadable: 'no timestamp' };
  const id = typeof o.message.id === 'string' ? o.message.id : null;
  const req = typeof o.requestId === 'string' ? o.requestId : null;
  const key =
    id || req
      ? `${id ?? ''}|${req ?? ''}`
      : `unkeyed:${createHash('sha256').update(line).digest('hex').slice(0, 16)}`;
  const usage = {};
  for (const k of USAGE_FIELDS) if (tokenCount(u[k])) usage[k] = u[k];
  if (cc !== undefined && cc !== null)
    usage.cache_creation = Object.fromEntries(CACHE_SPLIT_FIELDS.map((k) => [k, cc[k] ?? 0]));
  for (const k of ['service_tier', 'speed', 'inference_geo'])
    if (typeof u[k] === 'string') usage[k] = u[k];
  return {
    call: {
      key,
      model: typeof o.message.model === 'string' ? o.message.model : null,
      usage,
      ts,
      unkeyed: !(id || req),
    },
  };
}

/** Merge two observations of one call: every count at its maximum (streaming writes grow). */
export function mergeCall(a, b) {
  if (!a) return b;
  const usage = { ...a.usage };
  for (const k of USAGE_FIELDS) usage[k] = Math.max(a.usage[k] ?? 0, b.usage[k] ?? 0);
  if (a.usage.cache_creation || b.usage.cache_creation)
    usage.cache_creation = {
      ephemeral_5m_input_tokens: Math.max(
        a.usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
        b.usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      ),
      ephemeral_1h_input_tokens: Math.max(
        a.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        b.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      ),
    };
  for (const k of ['service_tier', 'speed', 'inference_geo']) usage[k] = b.usage[k] ?? a.usage[k];
  return { ...a, model: a.model ?? b.model, usage, ts: Math.min(a.ts, b.ts) };
}

const readJson = (p, empty) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return empty;
    throw new SpendError('SPEND_INDEX_UNREADABLE', `${p}: ${e.message}`);
  }
};
// the spend index is a derived cache, but use the one hardened writer (fsync +
// atomic rename, no write-through a planted symlink) the ledger uses
const writeAtomic = (p, value) => writeFileAtomic(p, JSON.stringify(value));
const headOf = (file) => {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(HEAD);
    const n = readSync(fd, b, 0, HEAD, 0);
    return createHash('sha256').update(b.subarray(0, n)).digest('hex').slice(0, 16);
  } finally {
    closeSync(fd);
  }
};

/**
 * Bring the index up to date. `since` (ms) skips files not modified since —
 * the hook passes the start of today. Returns { rewritten: [paths], unreadable: n }.
 */
export function updateIndex({ home, logDir, zone, since = 0 }) {
  const dir = join(home, 'spend');
  mkdirSync(join(dir, 'days'), { recursive: true });
  const filesPath = join(dir, 'files.json');
  const files = readJson(filesPath, {});
  const days = new Map();
  const day = (d) => {
    if (!days.has(d)) days.set(d, readJson(join(dir, 'days', `${d}.json`), {}));
    return days.get(d);
  };
  const rewritten = [];
  let unreadable = 0;
  for (const file of existsSync(logDir) ? listLogs(logDir) : []) {
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < since) continue;
    const prev = files[file];
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
    let offset = prev?.offset ?? 0;
    const head = headOf(file);
    if (prev && (st.size < prev.offset || head !== prev.head)) {
      rewritten.push(file); // counted spend stays; the file is read again from the start
      offset = 0;
    }
    const fd = openSync(file, 'r');
    let text;
    try {
      const len = st.size - offset;
      const b = Buffer.alloc(Math.max(0, len));
      readSync(fd, b, 0, len, offset);
      text = b.toString('utf8');
    } finally {
      closeSync(fd);
    }
    const lastNl = text.lastIndexOf('\n');
    const complete = lastNl < 0 ? '' : text.slice(0, lastNl); // a partial last line waits for its end
    for (const line of complete.split('\n')) {
      if (line.trim() === '') continue;
      const r = parseLine(line);
      if (r === null) continue;
      if (r.unreadable) {
        unreadable += 1;
        const d = day(dayOf(st.mtimeMs, zone));
        d['~unreadable'] = (d['~unreadable'] ?? 0) + 1;
        continue;
      }
      const d = day(dayOf(r.call.ts, zone));
      d[r.call.key] = mergeCall(d[r.call.key], r.call);
    }
    files[file] = {
      offset: offset + Buffer.byteLength(complete) + (lastNl < 0 ? 0 : 1),
      size: st.size,
      mtimeMs: st.mtimeMs,
      head,
    };
  }
  for (const [d, calls] of days) writeAtomic(join(dir, 'days', `${d}.json`), calls);
  writeAtomic(filesPath, files);
  return { rewritten, unreadable };
}

/** One day's spend: total of priced calls, and what could not be priced or read. */
export function daySpend({ home, day, table }) {
  const calls = readJson(join(home, 'spend', 'days', `${day}.json`), {});
  let usd = 0;
  const unpriced = new Map();
  const byModel = {};
  let n = 0;
  let unreadable = calls['~unreadable'] ?? 0;
  for (const [key, c] of Object.entries(calls)) {
    if (key === '~unreadable') continue;
    n += 1;
    const entry = priceOf(table, c.model);
    if (!entry) {
      unpriced.set(c.model ?? '(no model)', (unpriced.get(c.model ?? '(no model)') ?? 0) + 1);
      continue;
    }
    let cost;
    try {
      cost = costOf(entry, c.usage);
    } catch {
      // a stored row that cannot be priced (e.g. a malformed count that reached
      // the index through some other writer) is one unreadable line, not a
      // crashed command — the cap then fails closed via SPEND_UNREADABLE (F-170)
      n -= 1;
      unreadable += 1;
      continue;
    }
    usd += cost;
    byModel[c.model] = (byModel[c.model] ?? 0) + cost;
  }
  return {
    day,
    usd,
    calls: n,
    unpriced: Object.fromEntries(unpriced),
    unreadable,
    byModel,
  };
}

/**
 * The guard's step 2 (spec "Cap"): null when there is no cap or spend is under
 * it; otherwise { deny: true, reason }. Fails closed: unpriced or unreadable
 * spend today, or an index that cannot be read, is a deny.
 */
export function capCheck({ home, config, table, now = Date.now(), env = process.env }) {
  if (config.capUsd === undefined || config.capUsd === null) return null;
  const cap = config.capUsd;
  if (!finiteNonNeg(cap))
    return { deny: true, reason: 'SPEND_CAP_INVALID: the cap in config.json is not a number' };
  const zone = config.timeZone || systemZone();
  const today = dayOf(now, zone);
  const logDir = config.claudeLogDir || claudeLogDir(env);
  // files untouched since the start of today hold no new spend for today
  const startOfToday = now - 36 * 3600 * 1000; // generous: any zone's midnight lies within 36 h
  updateIndex({ home, logDir, zone, since: startOfToday });
  const s = daySpend({ home, day: today, table });
  const models = Object.keys(s.unpriced);
  if (models.length)
    return {
      deny: true,
      reason: `PRICE_UNKNOWN: ${models.join(', ')} has no price, so today's spend cannot be shown to be under the cap — run sakk prices update, or add the model to ${home}/prices.json`,
    };
  if (s.unreadable)
    return {
      deny: true,
      reason: `SPEND_UNREADABLE: ${s.unreadable} log line(s) today could not be read, so the cap cannot be checked`,
    };
  if (s.usd >= cap)
    return {
      deny: true,
      reason: `SPEND_CAP_REACHED: $${s.usd.toFixed(2)} ≥ $${cap.toFixed(2)} today (${today}, ${zone}, from local logs) — a person raises it with sakk cap set <usd>; it resets at midnight`,
    };
  return null;
}
