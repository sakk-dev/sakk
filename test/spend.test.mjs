import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  costOf,
  loadPrices,
  priceOf,
  validateTable,
  MAX_PRICES_BYTES,
  SHIPPED_PRICES,
} from '../src/prices.mjs';
import { capCheck, dayOf, daySpend, parseLine, updateIndex } from '../src/spend.mjs';

/**
 * Spend from local logs (specs/spend/spec.md). Money area: every adversary row
 * has a test here, and every price rule is checked against a hand-computed case.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const M = 1e-6; // $ per token for $1 per million
const TABLE = validateTable(
  {
    schema: 'sakk-prices.v1',
    source: {
      url: 'test',
      commit: 'test',
      sha256: 'test',
      fetchedAt: '2026-10-22',
      license: 'MIT',
    },
    models: {
      'claude-test-5': {
        input: 3 * M,
        output: 15 * M,
        cacheWrite5m: 3.75 * M,
        cacheWrite1h: 6 * M,
        cacheRead: 0.3 * M,
        aliases: ['claude-test-5-20261001'],
        longContext: {
          thresholdTokens: 200_000,
          input: 6 * M,
          output: 22.5 * M,
          cacheWrite5m: 7.5 * M,
          cacheWrite1h: 12 * M,
          cacheRead: 0.6 * M,
        },
        multipliers: { speed: { fast: 2 }, inference_geo: { us: 1.1 } },
      },
    },
  },
  'test table',
);

function world({ cap = 1, zone = 'UTC' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'spend-')));
  const home = join(base, 'sakk');
  const logs = join(base, 'claude', 'projects', '-work-repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const config = { capUsd: cap, timeZone: zone, claudeLogDir: join(base, 'claude', 'projects') };
  return { base, home, logs, config, file: join(logs, 'session.jsonl') };
}
const line = ({
  id = 'msg_1',
  req = 'req_1',
  model = 'claude-test-5',
  ts = '2026-10-22T10:00:00Z',
  usage = { input_tokens: 1000, output_tokens: 100 },
} = {}) =>
  `${JSON.stringify({ type: 'assistant', timestamp: ts, requestId: req, message: { id, model, usage } })}\n`;
const NOW = Date.parse('2026-10-22T12:00:00Z');
const spendOf = (w, day = '2026-10-22') => {
  updateIndex({ home: w.home, logDir: w.config.claudeLogDir, zone: w.config.timeZone });
  return daySpend({ home: w.home, day, table: TABLE });
};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≠ ${b}`);

describe('pricing', () => {
  test('each price rule matches a hand-computed case', () => {
    const e = priceOf(TABLE, 'claude-test-5');
    // plain: 1000 in × $3/M + 100 out × $15/M = 0.003 + 0.0015
    close(costOf(e, { input_tokens: 1000, output_tokens: 100 }), 0.0045);
    // cache: 5m writes 1.25× input, 1h writes 2× input, reads 0.1× input
    close(
      costOf(e, {
        input_tokens: 0,
        cache_creation_input_tokens: 3000,
        cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
        cache_read_input_tokens: 10_000,
      }),
      1000 * 3.75 * M + 2000 * 6 * M + 10_000 * 0.3 * M,
    );
    // without the split, every cache write is priced at the 5-minute rate
    close(costOf(e, { cache_creation_input_tokens: 1000 }), 1000 * 3.75 * M);
    // past the threshold the WHOLE request bills at the long-context rates
    close(
      costOf(e, { input_tokens: 150_000, cache_read_input_tokens: 60_000, output_tokens: 1000 }),
      150_000 * 6 * M + 60_000 * 0.6 * M + 1000 * 22.5 * M,
    );
    close(
      costOf(e, { input_tokens: 200_000, output_tokens: 0 }),
      200_000 * 3 * M,
      'at the threshold: still the base rate',
    );
    // multipliers on usage fields
    close(
      costOf(e, { input_tokens: 1000, speed: 'fast', inference_geo: 'us' }),
      1000 * 3 * M * 2 * 1.1,
    );
    // aliases only through the table
    assert.equal(priceOf(TABLE, 'claude-test-5-20261001'), e);
    assert.equal(priceOf(TABLE, 'claude-test-5-20991231'), null, 'a date suffix is not guessed');
  });
  test('the price snapshot is small, sourced and never edited in place', () => {
    const { table, path } = loadPrices({ home: join(tmpdir(), 'no-such-sakk-home') });
    assert.equal(path, SHIPPED_PRICES);
    assert.ok(
      statSync(SHIPPED_PRICES).size <= MAX_PRICES_BYTES,
      'under the plugin directory limit',
    );
    for (const k of ['url', 'commit', 'sha256', 'fetchedAt', 'license'])
      assert.ok(table.source?.[k], `source.${k}`);
    // a user table wins; a malformed one is refused, never silently replaced by the snapshot
    const w = world();
    writeFileSync(join(w.home, 'prices.json'), '{ broken');
    assert.throws(() => loadPrices({ home: w.home }), /PRICES_INVALID/);
    writeFileSync(
      join(w.home, 'prices.json'),
      JSON.stringify({
        ...TABLE,
        models: { x: { input: -1, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } },
      }),
    );
    assert.throws(() => loadPrices({ home: w.home }), /PRICES_INVALID/);
  });
});

describe('reading the logs', () => {
  test('streamed and duplicated lines count once, at their maximum', () => {
    const w = world();
    writeFileSync(
      w.file,
      line({ usage: { input_tokens: 1000, output_tokens: 10 } }) +
        line({ usage: { input_tokens: 1000, output_tokens: 100 } }) +
        line({ usage: { input_tokens: 1000, output_tokens: 100 } }),
    );
    const s = spendOf(w);
    assert.equal(s.calls, 1);
    close(s.usd, 0.0045);
    // a different requestId is a different call
    appendFileSync(w.file, line({ req: 'req_2' }));
    close(spendOf(w).usd, 0.009);
  });
  test('a deleted or truncated log never lowers spend', () => {
    const w = world();
    writeFileSync(w.file, line() + line({ id: 'msg_2', req: 'req_2' }));
    close(spendOf(w).usd, 0.009);
    truncateSync(w.file, 0);
    close(spendOf(w).usd, 0.009, 'truncated: counted spend stays');
    writeFileSync(w.file, '');
    close(spendOf(w).usd, 0.009, 'emptied: counted spend stays');
  });
  test('usage rewritten in place keeps the counted maximum', () => {
    const w = world();
    writeFileSync(w.file, line({ usage: { input_tokens: 100_000, output_tokens: 1000 } }));
    const first = spendOf(w).usd;
    writeFileSync(w.file, line({ usage: { input_tokens: 1, output_tokens: 1 } })); // same size or not, the head changed
    const r = updateIndex({ home: w.home, logDir: w.config.claudeLogDir, zone: 'UTC' });
    assert.ok(r.rewritten.length >= 0);
    close(daySpend({ home: w.home, day: '2026-10-22', table: TABLE }).usd, first);
  });
  test('hostile lines are bounded and fail closed', () => {
    assert.deepEqual(parseLine('x'.repeat(1024 * 1024 + 1)), { unreadable: 'line over 1 MiB' });
    assert.ok(parseLine('{not json').unreadable);
    assert.ok(
      parseLine(
        JSON.stringify({
          type: 'assistant',
          timestamp: 'now',
          message: { usage: { input_tokens: 1 } },
        }),
      ).unreadable,
      'no timestamp',
    );
    assert.ok(
      parseLine(
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-10-22T00:00:00Z',
          message: { usage: { input_tokens: -5 } },
        }),
      ).unreadable,
      'negative',
    );
    assert.ok(
      parseLine(
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-10-22T00:00:00Z',
          message: { usage: { input_tokens: 'many' } },
        }),
      ).unreadable,
      'not a number',
    );
    assert.equal(
      parseLine(JSON.stringify({ type: 'user', message: { content: 'hi' } })),
      null,
      'not a call',
    );
    // under a cap, an unreadable line today is a deny
    const w = world();
    writeFileSync(w.file, `${line()}{not json\n`);
    utimesSync(w.file, NOW / 1000, NOW / 1000);
    const r = capCheck({ home: w.home, config: w.config, table: TABLE, now: NOW });
    assert.match(r?.reason ?? '', /SPEND_UNREADABLE/);
  });
  test('a partial last line waits for its end', () => {
    const w = world();
    const full = line();
    writeFileSync(w.file, full.slice(0, 40));
    assert.equal(spendOf(w).calls, 0);
    appendFileSync(w.file, full.slice(40));
    assert.equal(spendOf(w).calls, 1);
  });
  test('parallel sessions are summed', () => {
    const w = world();
    writeFileSync(w.file, line());
    mkdirSync(join(w.logs, 'session-2', 'subagents'), { recursive: true });
    writeFileSync(
      join(w.logs, 'session-2', 'subagents', 'agent-1.jsonl'),
      line({ id: 'msg_9', req: 'req_9' }),
    );
    close(spendOf(w).usd, 0.009);
  });
  test('the day boundary follows the configured zone', () => {
    // 21:30 UTC on the 22nd is already the 23rd in Dubai
    assert.equal(dayOf(Date.parse('2026-10-22T21:30:00Z'), 'Asia/Dubai'), '2026-10-23');
    assert.equal(dayOf(Date.parse('2026-10-22T21:30:00Z'), 'UTC'), '2026-10-22');
    assert.equal(
      dayOf(Date.parse('2026-10-22T19:59:59Z'), 'Asia/Dubai'),
      '2026-10-22',
      'last second of the day',
    );
    assert.equal(
      dayOf(Date.parse('2026-10-22T20:00:00Z'), 'Asia/Dubai'),
      '2026-10-23',
      'first second of the next',
    );
  });
  test('a hook check reads only what changed today', () => {
    const w = world();
    writeFileSync(w.file, line());
    const old = join(w.logs, 'old.jsonl');
    writeFileSync(old, line({ id: 'msg_old', req: 'req_old', ts: '2026-09-01T00:00:00Z' }));
    const longAgo = Date.parse('2026-09-01T00:00:00Z') / 1000;
    utimesSync(old, longAgo, longAgo);
    utimesSync(w.file, NOW / 1000, NOW / 1000);
    capCheck({ home: w.home, config: w.config, table: TABLE, now: NOW });
    const files = JSON.parse(readFileSync(join(w.home, 'spend', 'files.json'), 'utf8'));
    assert.ok(files[w.file], "today's log was read");
    assert.equal(files[old], undefined, 'a log untouched for weeks was not opened');
  });
});

describe('the cap', () => {
  test('an unpriced call with a cap set is a deny', () => {
    const w = world();
    writeFileSync(w.file, line({ model: 'some-new-model' }));
    utimesSync(w.file, NOW / 1000, NOW / 1000);
    const r = capCheck({ home: w.home, config: w.config, table: TABLE, now: NOW });
    assert.equal(r.deny, true);
    assert.match(r.reason, /PRICE_UNKNOWN: some-new-model/);
    // no cap: nothing to check, nothing denied
    assert.equal(
      capCheck({
        home: w.home,
        config: { ...w.config, capUsd: undefined },
        table: TABLE,
        now: NOW,
      }),
      null,
    );
  });
  test('at the cap the next call is denied, below it nothing is', () => {
    const w = world({ cap: 0.009 });
    writeFileSync(w.file, line());
    utimesSync(w.file, NOW / 1000, NOW / 1000);
    assert.equal(capCheck({ home: w.home, config: w.config, table: TABLE, now: NOW }), null);
    appendFileSync(w.file, line({ id: 'msg_2', req: 'req_2' }));
    utimesSync(w.file, NOW / 1000, NOW / 1000);
    const r = capCheck({ home: w.home, config: w.config, table: TABLE, now: NOW });
    assert.match(
      r.reason,
      /SPEND_CAP_REACHED: \$0\.01 ≥ \$0\.01 today \(2026-10-22, UTC, from local logs\)/,
    );
  });
  test('the log folder is fixed at cap set, not read from the agent', () => {
    const w = world();
    writeFileSync(w.file, line({ model: 'some-new-model' }));
    utimesSync(w.file, NOW / 1000, NOW / 1000);
    // the agent's environment points somewhere empty; the configured folder still counts
    const r = capCheck({
      home: w.home,
      config: w.config,
      table: TABLE,
      now: NOW,
      env: { CLAUDE_CONFIG_DIR: join(w.base, 'empty') },
    });
    assert.match(r?.reason ?? '', /PRICE_UNKNOWN/);
  });
  test('spend is labelled by its source', () => {
    const w = world({ cap: 0.001 });
    writeFileSync(w.file, line());
    utimesSync(w.file, NOW / 1000, NOW / 1000);
    assert.match(
      capCheck({ home: w.home, config: w.config, table: TABLE, now: NOW }).reason,
      /from local logs/,
    );
    assert.doesNotMatch(
      readFileSync(join(ROOT, 'docs', 'SPEND.md'), 'utf8'),
      /\bbilled\b|\binvoice total\b/i,
    );
  });
});

describe('the agent cannot raise its own cap, and the cap fires inside the hook', async () => {
  const { normalize, evaluate } = await import('../src/hook.mjs');
  const verdict = (ev, home, base) =>
    evaluate(ev, { env: { ...process.env, SAKK_HOME: home, HOME: base }, log: false }).verdict;
  const writeEv = (home, base, file) =>
    normalize('claude-code', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      cwd: base,
      tool_input: { file_path: join(home, file), content: '{}' },
    });

  test('the agent cannot write the cap', () => {
    const w = world();
    assert.equal(verdict(writeEv(w.home, w.base, 'config.json'), w.home, w.base), 'deny');
  });
  test('the agent cannot write the price table', () => {
    const w = world();
    assert.equal(verdict(writeEv(w.home, w.base, 'prices.json'), w.home, w.base), 'deny');
  });
  test("the cap denies inside the hook's evaluate, not only in capCheck", () => {
    const w = world({ cap: 0.001 });
    // a model the shipped snapshot does not price → PRICE_UNKNOWN would deny; use
    // a user prices.json with the test model, and logs that price over the cap
    writeFileSync(join(w.home, 'prices.json'), JSON.stringify(TABLE));
    writeFileSync(join(w.home, 'config.json'), JSON.stringify(w.config));
    writeFileSync(w.file, line({ usage: { input_tokens: 1_000_000, output_tokens: 0 } }));
    const ev = normalize('claude-code', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: w.base,
      tool_input: { command: 'ls' },
    });
    const r = evaluate(ev, {
      env: { ...process.env, SAKK_HOME: w.home, HOME: w.base },
      log: false,
    });
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /SPEND_CAP_REACHED/);
  });
});

describe('spend refusals (negative tests)', () => {
  test('an oversized price table is unreadable, not read half-way (PRICES_UNREADABLE)', () => {
    const w = world();
    writeFileSync(join(w.home, 'prices.json'), ' '.repeat(MAX_PRICES_BYTES + 1));
    assert.throws(() => loadPrices({ home: w.home }), /PRICES_UNREADABLE/);
  });
  test('a corrupt spend index is a refusal, not a silent zero (SPEND_INDEX_UNREADABLE)', () => {
    const w = world();
    mkdirSync(join(w.home, 'spend', 'days'), { recursive: true });
    writeFileSync(join(w.home, 'spend', 'days', '2026-10-22.json'), '{ not json');
    assert.throws(
      () => daySpend({ home: w.home, day: '2026-10-22', table: TABLE }),
      /SPEND_INDEX_UNREADABLE/,
    );
  });
});
