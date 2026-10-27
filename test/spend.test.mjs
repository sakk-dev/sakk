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
    evaluate(ev, {
      env: { ...process.env, SAKK_HOME: home, HOME: base },
      log: false,
      now: () => NOW,
    }).verdict;
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
    utimesSync(w.file, NOW / 1000, NOW / 1000);
    const ev = normalize('claude-code', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: w.base,
      tool_input: { command: 'ls' },
    });
    // the hook's clock decides "today": the logs are from NOW's day, so the cap
    // holds then and not on the next day — whatever day the suite runs (F-165)
    const at = (t) =>
      evaluate(ev, {
        env: { ...process.env, SAKK_HOME: w.home, HOME: w.base },
        log: false,
        now: () => t,
      });
    const r = at(NOW);
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /SPEND_CAP_REACHED/);
    assert.equal(at(NOW + 24 * 3600 * 1000).verdict, 'allow');
  });
});

test('every hook or cap call in the spend tests sets its own clock (F-165)', () => {
  // the fixtures are dated 2026-10-22; a call that reads the real clock passes
  // only on that day. Each call's argument text must name `now`.
  const src = readFileSync(join(ROOT, 'test', 'spend.test.mjs'), 'utf8');
  const calls = [];
  for (const m of src.matchAll(/(?<!')\b(?:evaluate|capCheck)\(/g)) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')' && --depth === 0) break;
    }
    calls.push(src.slice(m.index, end + 1));
  }
  assert.ok(calls.length >= 10, `found only ${calls.length} calls — the scan is broken`);
  const unclocked = calls.filter((c) => !/\bnow\b/.test(c));
  assert.deepEqual(unclocked, [], 'these calls read the real clock');
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

// ── P0 UAT backfill (branch oss/p0-uat-backfill): the four spend/pricing P0
// cases that were "待补自动化" on the UAT sheet. S-FN-017 is clean (positive +
// boundary). The other three are CONFIRMED GAPS: each is pinned by a GAP-
// labelled characterization test (so the suite is honest about the current
// behavior, not green over a broken one) and an open finding — F-168/169/170 —
// whose fix is a product decision for the owner, not a quiet patch here.
describe('P0 UAT backfill — spend', () => {
  // S-FN-017 (已实现): past the long-context threshold the WHOLE call bills at
  // the high tier, and the threshold is a strict > (exactly at it stays base).
  // Synthetic "合成价表" per the UAT; the title names the Haiku-5.5 scenario it
  // models (that model is not in the shipped snapshot — see S-FN-020/F-169).
  test('S-FN-017 Haiku-5.5 at prompt 100001 prices the whole call at the long-context tier', () => {
    const e = {
      input: 1 * M,
      output: 5 * M,
      cacheRead: 0.1 * M,
      cacheWrite5m: 1.25 * M,
      cacheWrite1h: 2 * M,
      longContext: {
        thresholdTokens: 100_000,
        input: 2 * M,
        output: 7.5 * M,
        cacheRead: 0.2 * M,
        cacheWrite5m: 2.5 * M,
        cacheWrite1h: 4 * M,
      },
    };
    // prompt = 100001 > 100000 → whole call at the high tier
    close(
      costOf(e, { input_tokens: 100001, output_tokens: 1000 }),
      100001 * 2 * M + 1000 * 7.5 * M,
    );
    close(costOf(e, { input_tokens: 100001, output_tokens: 1000 }), 0.207502);
    // exactly at the threshold the strict > keeps it on the base tier
    close(costOf(e, { input_tokens: 100000, output_tokens: 1000 }), 100000 * 1 * M + 1000 * 5 * M);
  });

  // S-FN-012 (部分实现 / 缺陷, F-168): an empty cache_creation:{} split is read as
  // authoritative, zeroing w5 and w1h, so 1000 cache-write tokens are charged
  // $0 — while the same tokens with no split key are charged 1000×cacheWrite5m.
  // Direction = undercount = underbilling. This pins the defect; the fix is a
  // product decision (fall back to cacheWrite when the split is empty vs. keep
  // the split authoritative) recorded in F-168.
  test('GAP F-168 S-FN-012 empty cache_creation:{} zeroes the cache-write charge (undercount)', () => {
    const e = priceOf(TABLE, 'claude-test-5');
    const withEmptySplit = costOf(e, { cache_creation_input_tokens: 1000, cache_creation: {} });
    const withoutSplit = costOf(e, { cache_creation_input_tokens: 1000 });
    assert.equal(
      withEmptySplit,
      0,
      'CURRENT (buggy): an empty split charges nothing for 1000 tokens',
    );
    close(withoutSplit, 1000 * 3.75 * M);
    assert.ok(
      withEmptySplit < withoutSplit,
      'the empty-split path undercounts vs the no-split path',
    );
  });

  // S-FN-020 (部分实现 / P0 发布阻断, F-169): the shipped snapshot carries only a
  // handful of older models; every current Claude model is unpriced. The code
  // is correct — null, no guess, so capCheck fails closed with PRICE_UNKNOWN
  // (tested above) — but out of the box sakk cannot price a single current-
  // model call. This pins the release-blocking data gap; refreshing the shipped
  // snapshot is a product decision recorded in F-169.
  test('GAP F-169 S-FN-020 shipped snapshot omits every current Claude model', () => {
    const { table, path } = loadPrices({ home: join(tmpdir(), 'no-such-sakk-home') });
    assert.equal(path, SHIPPED_PRICES);
    for (const id of [
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5',
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
    ])
      assert.equal(priceOf(table, id), null, `${id} is unpriced in the shipped snapshot`);
    assert.ok(
      Object.keys(table.models).length <= 6,
      'the snapshot carries only a handful of older models',
    );
  });

  // S-SEC-004 (部分实现, F-170): a fractional token (input_tokens:1.5) passes
  // parseLine's finiteNonNeg check (there is no integer gate), is stored, then
  // crashes costOf with USAGE_INVALID. daySpend does not isolate the throw, so
  // `sakk spend` crashes instead of recording the line unreadable and failing
  // closed cleanly. This pins both halves (accepted at parse, crashes at price);
  // the clean fail-closed + honest deny message is a product decision (F-170).
  test('GAP F-170 S-SEC-004 fractional tokens pass parseLine then crash pricing (not isolated)', () => {
    const r = parseLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-22T10:00:00Z',
        requestId: 'req_x',
        message: { id: 'msg_x', model: 'claude-test-5', usage: { input_tokens: 1.5 } },
      }),
    );
    assert.equal(
      r.call.usage.input_tokens,
      1.5,
      'CURRENT (gap): a non-integer token is accepted, not marked unreadable',
    );
    const w = world();
    mkdirSync(join(w.home, 'spend', 'days'), { recursive: true });
    writeFileSync(
      join(w.home, 'spend', 'days', '2026-10-22.json'),
      JSON.stringify({
        'msg_x|req_x': {
          key: 'msg_x|req_x',
          model: 'claude-test-5',
          usage: { input_tokens: 1.5 },
          ts: NOW,
        },
      }),
    );
    assert.throws(
      () => daySpend({ home: w.home, day: '2026-10-22', table: TABLE }),
      /USAGE_INVALID/,
    );
  });

  // R-REL-018 (已实现): the spend read is fail-CLOSED on a corrupt log — a single
  // unreadable line makes the WHOLE day's cap uncheckable, so every call that day
  // is denied (SPEND_UNREADABLE) even though the readable lines are far under the
  // cap, and the deny does not clear on a retry: only a person fixing the log
  // restores service (REQ-R03, REQ-S06). The existing reading-the-logs test shows
  // one good + one bad line denies; this strengthens it — several readable lines
  // proven under the cap still deny when one bad line joins them (it is the bad
  // line, not the spend, that denies), and a re-read does not self-recover.
  test('R-REL-018 one unreadable log line denies the whole day under cap, and a retry does not self-recover', () => {
    const good = Array.from({ length: 5 }, (_, i) =>
      line({ id: `msg_${i}`, req: `req_${i}`, ts: '2026-10-22T10:00:00Z' }),
    );

    // control: a day of only readable lines, well under the $1 cap, allows
    const clean = world({ cap: 1 });
    writeFileSync(clean.file, good.join(''));
    utimesSync(clean.file, NOW / 1000, NOW / 1000);
    const cleanDay = spendOf(clean);
    assert.equal(cleanDay.calls, good.length, 'the readable lines are distinct and counted');
    assert.ok(cleanDay.usd < 1, `the readable spend is under the cap ($${cleanDay.usd})`);
    assert.equal(cleanDay.unreadable, 0, 'no unreadable lines in the clean day');
    assert.equal(
      capCheck({ home: clean.home, config: clean.config, table: TABLE, now: NOW }),
      null,
      'a clean day under cap allows',
    );

    // the same readable lines plus ONE unreadable line: the whole day denies, though
    // the readable spend is identical and still under the cap.
    const poisoned = world({ cap: 1 });
    writeFileSync(poisoned.file, `${good.join('')}{not json — a truncated or corrupt record\n`);
    utimesSync(poisoned.file, NOW / 1000, NOW / 1000);
    const r1 = capCheck({ home: poisoned.home, config: poisoned.config, table: TABLE, now: NOW });
    assert.match(
      r1?.reason ?? '',
      /SPEND_UNREADABLE/,
      'one bad line denies the whole day under cap',
    );

    // no self-recovery: reading again (the log unchanged) still denies — the deny is
    // not transient and does not clear on retry; a person must fix the log.
    const r2 = capCheck({ home: poisoned.home, config: poisoned.config, table: TABLE, now: NOW });
    assert.match(r2?.reason ?? '', /SPEND_UNREADABLE/, 'a retry does not self-recover');
  });
});
