// SPDX-License-Identifier: AGPL-3.0-only
//
// Prices (specs/spend/spec.md, "Price"). The table is data, never code: a
// trimmed snapshot of LiteLLM's model list ships with the package
// (maintainers regenerate it with scripts/prices-trim.mjs), and an operator
// can override or extend it with a sakk-prices.v1 table at SAKK_HOME/prices.json.
// A model missing from the table is unpriced — never guessed.
//
// Table shape (sakk-prices.v1), prices in USD per token:
//   { schema, source: { url, commit, sha256, fetchedAt, license },
//     models: { "<id>": { input, output, cacheWrite5m, cacheWrite1h, cacheRead,
//                         aliases?: [..],
//                         longContext?: { thresholdTokens, input, output, cacheWrite5m, cacheWrite1h, cacheRead },
//                         multipliers?: { "<usage field>": { "<value>": factor } } } } }

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRICES_SCHEMA = 'sakk-prices.v1';
export const MAX_PRICES_BYTES = 256 * 1024; // the plugin directory's per-file limit
export const SHIPPED_PRICES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'prices',
  'snapshot.json',
);
const KINDS = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'];

export class PriceError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const finiteNonNeg = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

/** A table is refused whole if any entry is not a price: a half-read table would under-count. */
export function validateTable(t, where) {
  const bad = (why) => {
    throw new PriceError('PRICES_INVALID', `${where}: ${why}`);
  };
  if (t === null || typeof t !== 'object' || t.schema !== PRICES_SCHEMA)
    bad(`schema must be ${PRICES_SCHEMA}`);
  if (t.models === null || typeof t.models !== 'object' || Array.isArray(t.models))
    bad('models must be an object');
  const names = new Map();
  for (const [id, m] of Object.entries(t.models)) {
    for (const k of KINDS)
      if (!finiteNonNeg(m?.[k])) bad(`${id}.${k} is not a non-negative number`);
    if (m.longContext !== undefined) {
      if (!(Number.isInteger(m.longContext.thresholdTokens) && m.longContext.thresholdTokens > 0))
        bad(`${id}.longContext.thresholdTokens must be a positive integer`);
      for (const k of KINDS)
        if (!finiteNonNeg(m.longContext[k])) bad(`${id}.longContext.${k} is not a price`);
    }
    for (const [field, values] of Object.entries(m.multipliers ?? {}))
      for (const [v, f] of Object.entries(values ?? {}))
        if (!finiteNonNeg(f) || f === 0)
          bad(`${id}.multipliers.${field}.${v} must be a positive number`);
    for (const name of [id, ...(m.aliases ?? [])]) {
      if (typeof name !== 'string' || name === '') bad(`${id}: an alias is not a name`);
      if (names.has(name) && names.get(name) !== id)
        bad(`${name} names two models (${names.get(name)}, ${id})`);
      names.set(name, id);
    }
  }
  return t;
}

/**
 * The table in use: SAKK_HOME/prices.json when present (a malformed one is
 * refused — never a silent fall back to the snapshot), else the shipped one.
 */
export function loadPrices({ home, shipped = SHIPPED_PRICES } = {}) {
  const user = home ? join(home, 'prices.json') : null;
  const path = user && existsSync(user) ? user : shipped;
  let raw;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new PriceError('PRICES_UNREADABLE', `${path} is not a file`);
    if (st.size > MAX_PRICES_BYTES)
      throw new PriceError('PRICES_UNREADABLE', `${path} is larger than ${MAX_PRICES_BYTES} bytes`);
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if (e instanceof PriceError) throw e;
    throw new PriceError('PRICES_UNREADABLE', `${path}: ${e.code ?? e.message}`);
  }
  let t;
  try {
    t = JSON.parse(raw);
  } catch {
    throw new PriceError('PRICES_INVALID', `${path} is not JSON`);
  }
  return { table: validateTable(t, path), path };
}

/** The entry for a model id: the id itself or a listed alias. Nothing else is guessed. */
export function priceOf(table, model) {
  if (typeof model !== 'string' || model === '') return null;
  if (Object.hasOwn(table.models, model)) return table.models[model];
  for (const m of Object.values(table.models)) if ((m.aliases ?? []).includes(model)) return m;
  return null;
}

const count = (u, k) => {
  const v = u?.[k];
  if (v === undefined || v === null) return 0;
  if (!finiteNonNeg(v) || !Number.isInteger(v))
    throw new PriceError('USAGE_INVALID', `${k} is not a token count`);
  return v;
};

/**
 * The cost of one call from its usage (specs/spend/spec.md, "Price"):
 * each token kind at its own price; a 1-hour cache write at its own price;
 * past the long-context threshold the whole request at the higher rates;
 * multipliers matched on usage fields (e.g. speed, inference_geo).
 */
export function costOf(entry, usage) {
  const input = count(usage, 'input_tokens');
  const output = count(usage, 'output_tokens');
  const cacheRead = count(usage, 'cache_read_input_tokens');
  const cacheWrite = count(usage, 'cache_creation_input_tokens');
  const split = usage?.cache_creation;
  let w5 = cacheWrite;
  let w1h = 0;
  if (split && typeof split === 'object') {
    const s5 = count(split, 'ephemeral_5m_input_tokens');
    const s1h = count(split, 'ephemeral_1h_input_tokens');
    // A present but empty cache_creation:{} is not an authoritative "all zero"
    // breakdown — a trimmed or replayed log can emit it. Honour the split only
    // when it actually enumerates tokens; otherwise keep the aggregate so
    // cache-write tokens are never silently dropped from the bill (F-168).
    if (s5 + s1h > 0) {
      w5 = s5;
      w1h = s1h;
    }
  }
  const prompt = input + cacheRead + cacheWrite;
  const rate =
    entry.longContext && prompt > entry.longContext.thresholdTokens ? entry.longContext : entry;
  let usd =
    input * rate.input +
    output * rate.output +
    w5 * rate.cacheWrite5m +
    w1h * rate.cacheWrite1h +
    cacheRead * rate.cacheRead;
  for (const [field, values] of Object.entries(entry.multipliers ?? {})) {
    const v = usage?.[field];
    if (typeof v === 'string' && Object.hasOwn(values, v)) usd *= values[v];
  }
  return usd;
}
