#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Builds prices/snapshot.json (sakk-prices.v1) from LiteLLM's
// model_prices_and_context_window.json (MIT). Keeps the chat models of the
// providers coding agents call, maps LiteLLM's per-token fields onto Sakk's
// five kinds, and records the source, commit and sha-256. Refuses an entry it
// cannot map rather than guessing a price.
//
//   node scripts/prices-trim.mjs <litellm.json> --commit <sha> [--out prices/snapshot.json]

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { validateTable, PRICES_SCHEMA, MAX_PRICES_BYTES } from '../src/prices.mjs';

export const SOURCE_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PROVIDERS = new Set(['anthropic', 'openai', 'gemini', 'deepseek']);

/** One LiteLLM entry → a Sakk entry, or null when it is not a priced chat model. */
export function mapEntry(id, e) {
  if (!e || !PROVIDERS.has(e.litellm_provider) || e.mode !== 'chat') return null;
  const n = (k) =>
    typeof e[k] === 'number' && Number.isFinite(e[k]) && e[k] >= 0 ? e[k] : undefined;
  const input = n('input_cost_per_token');
  const output = n('output_cost_per_token');
  if (input === undefined || output === undefined) return null;
  // cache prices: LiteLLM's own figures when present; otherwise Anthropic's published
  // ratios (5-minute write 1.25×, 1-hour write 2×, read 0.1× input) only for Anthropic
  const anthropic = e.litellm_provider === 'anthropic';
  const cacheWrite5m = n('cache_creation_input_token_cost') ?? (anthropic ? input * 1.25 : input);
  const cacheWrite1h =
    n('cache_creation_input_token_cost_above_1hr') ?? (anthropic ? input * 2 : input);
  const cacheRead = n('cache_read_input_token_cost') ?? (anthropic ? input * 0.1 : input);
  const out = { input, output, cacheWrite5m, cacheWrite1h, cacheRead };
  const above = Object.keys(e)
    .map((k) => /^input_cost_per_token_above_(\d+)k_tokens$/.exec(k))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)[0];
  if (above !== undefined) {
    const k = (base) => n(`${base}_above_${above}k_tokens`);
    out.longContext = {
      thresholdTokens: above * 1000,
      input: k('input_cost_per_token') ?? input,
      output: k('output_cost_per_token') ?? output,
      cacheWrite5m: k('cache_creation_input_token_cost') ?? cacheWrite5m,
      cacheWrite1h: k('cache_creation_input_token_cost_above_1hr') ?? cacheWrite1h,
      cacheRead: k('cache_read_input_token_cost') ?? cacheRead,
    };
  }
  // LiteLLM lists provider-prefixed duplicates ("anthropic/claude-…"); the bare id is the alias
  const bare = id.includes('/') ? id.split('/').pop() : null;
  if (bare && bare !== id) out.aliases = [bare];
  return out;
}

export function trim(raw, { commit, fetchedAt }) {
  const src = JSON.parse(raw);
  const models = {};
  const seen = new Set();
  for (const [id, e] of Object.entries(src)) {
    if (id === 'sample_spec') continue;
    const m = mapEntry(id, e);
    if (!m) continue;
    const key = id.includes('/') ? id.split('/').pop() : id;
    if (seen.has(key)) continue; // the first spelling wins; the others are the same model
    seen.add(key);
    delete m.aliases;
    models[key] = m;
  }
  const table = {
    schema: PRICES_SCHEMA,
    source: {
      url: SOURCE_URL,
      commit,
      sha256: createHash('sha256').update(raw).digest('hex'),
      fetchedAt,
      license: 'LiteLLM (MIT, (c) Berri AI)',
    },
    models,
  };
  validateTable(table, 'trimmed snapshot');
  const text = `${JSON.stringify(table)}\n`;
  if (Buffer.byteLength(text) > MAX_PRICES_BYTES)
    throw new Error(`PRICES_TOO_LARGE: ${Buffer.byteLength(text)} bytes — narrow the providers`);
  return text;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [file, ...rest] = process.argv.slice(2);
  const commit = rest[rest.indexOf('--commit') + 1];
  const out = rest.includes('--out') ? rest[rest.indexOf('--out') + 1] : 'prices/snapshot.json';
  if (!file || !commit || rest.indexOf('--commit') < 0) {
    console.error(
      'usage: node scripts/prices-trim.mjs <litellm.json> --commit <sha> [--out <path>]',
    );
    process.exit(2);
  }
  writeFileSync(
    out,
    trim(readFileSync(file, 'utf8'), { commit, fetchedAt: new Date().toISOString().slice(0, 10) }),
  );
  console.log(`wrote ${out}`);
}
