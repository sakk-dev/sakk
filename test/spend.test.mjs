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

  // S-FN-012 (F-168, fixed): a present but empty cache_creation:{} is not an
  // authoritative "all zero" breakdown — a trimmed or replayed log can emit it.
  // The split never shrinks the aggregate (F-179 generalised this): an empty
  // split leaves the 1000 cache-write tokens billed the same as with no split
  // key, and a populated split is still priced per-tier.
  test('F-168 S-FN-012 empty cache_creation:{} falls back to the aggregate cache-write', () => {
    const e = priceOf(TABLE, 'claude-test-5');
    const withEmptySplit = costOf(e, { cache_creation_input_tokens: 1000, cache_creation: {} });
    const withoutSplit = costOf(e, { cache_creation_input_tokens: 1000 });
    close(withoutSplit, 1000 * 3.75 * M);
    assert.equal(
      withEmptySplit,
      withoutSplit,
      'an empty split must not undercount — it falls back to the aggregate',
    );
    // a split that actually enumerates the breakdown is still authoritative:
    // 600 at 5m (3.75/M) + 400 at 1h (6/M), not the flat aggregate rate.
    close(
      costOf(e, {
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 },
      }),
      600 * 3.75 * M + 400 * 6 * M,
    );
  });

  // S-FN-020 (F-169, fixed): the shipped snapshot is regenerated from the public
  // LiteLLM table (BerriAI/litellm, MIT) and now carries every current Claude
  // model, so out of the box sakk prices a real call instead of denying it. The
  // fail-closed code is unchanged — the fix is data, not a loosening: a model the
  // snapshot does not list is still priced null, so capCheck denies it
  // PRICE_UNKNOWN rather than guess. This drives both halves on the SHIPPED table.
  test('S-FN-020 the shipped snapshot prices every current Claude model, and an unknown model still fails closed', () => {
    const { table, path } = loadPrices({ home: join(tmpdir(), 'no-such-sakk-home') });
    assert.equal(path, SHIPPED_PRICES);
    // every current Claude model an operator could run is now priced, with finite
    // positive rates and a real per-call cost — not null, which denied every call
    for (const id of [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-opus-5',
      'claude-fable-5-1',
    ]) {
      const e = priceOf(table, id);
      assert.ok(e, `${id} is priced in the shipped snapshot`);
      assert.ok(e.input > 0 && e.output > 0, `${id} has positive input/output rates`);
      assert.ok(
        costOf(e, { input_tokens: 1000, output_tokens: 100 }) > 0,
        `${id} prices a real call`,
      );
    }
    // an unlisted model is still unpriced, and the real spend path denies it
    // PRICE_UNKNOWN rather than guess — the snapshot refresh did not loosen this
    assert.equal(
      priceOf(table, 'claude-does-not-exist-9'),
      null,
      'an unlisted model is not guessed',
    );
    const w = world();
    writeFileSync(w.file, line({ model: 'claude-does-not-exist-9' }));
    utimesSync(w.file, NOW / 1000, NOW / 1000);
    const r = capCheck({ home: w.home, config: w.config, table, now: NOW });
    assert.match(r?.reason ?? '', /PRICE_UNKNOWN: claude-does-not-exist-9/);
  });

  // S-SEC-004 (F-170, fixed): a fractional token (input_tokens:1.5) is screened
  // at the parse boundary — parseLine marks it unreadable instead of storing it
  // — and, as defence in depth, a malformed row that reaches the day index does
  // not crash daySpend: the costOf throw is isolated to one unreadable line, so
  // the cap fails closed cleanly (SPEND_UNREADABLE) rather than aborting.
  test('F-170 S-SEC-004 a fractional token is unreadable at parse and isolated in daySpend', () => {
    const r = parseLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-22T10:00:00Z',
        requestId: 'req_x',
        message: { id: 'msg_x', model: 'claude-test-5', usage: { input_tokens: 1.5 } },
      }),
    );
    assert.ok(r.unreadable, 'a non-integer token count is marked unreadable at the parse boundary');
    assert.match(r.unreadable, /input_tokens/);
    assert.equal(r.call, undefined, 'it is not stored as a priced call');

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
    const s = daySpend({ home: w.home, day: '2026-10-22', table: TABLE });
    assert.equal(
      s.unreadable,
      1,
      'the malformed row is counted as one unreadable line, not a crash',
    );
    assert.equal(s.calls, 0, 'it is not counted as a priced call');
    assert.equal(s.usd, 0);
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

// The usage input space, enumerated (R-03, F-179). F-168 and F-170 were each
// one cell of this table found by hand; the split fields were a cell nobody
// visited. Every numeric field a usage line carries is driven through every
// malformed value: parse marks it unreadable (never 0), and a row that reaches
// pricing anyway throws USAGE_INVALID and is isolated by daySpend.
describe('the usage input space (R-03, F-179)', () => {
  // A usage block as Claude Code writes it, with every field it can carry.
  const REAL = {
    input_tokens: 1000,
    output_tokens: 100,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 500,
    cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
    server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
    service_tier: 'standard',
  };
  const PRICED = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'cache_creation.ephemeral_5m_input_tokens',
    'cache_creation.ephemeral_1h_input_tokens',
  ];
  // Per-request server-tool charges are outside the token price (F-180).
  const NOT_PRICED = ['server_tool_use.web_search_requests', 'server_tool_use.web_fetch_requests'];
  const INF = '__INF__';
  const BAD = ['1000', -1, 1000.5, true, {}, [1000], INF];
  const numericLeaves = (o, p = []) =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === 'object'
        ? numericLeaves(v, [...p, k])
        : typeof v === 'number'
          ? [[...p, k].join('.')]
          : [],
    );
  const withLeaf = (o, path, v) => {
    const c = structuredClone(o);
    const ks = path.split('.');
    let t = c;
    for (const k of ks.slice(0, -1)) t = t[k];
    t[ks.at(-1)] = v;
    return c;
  };
  const lineOf = (usage) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-22T10:00:00Z',
      requestId: 'req_x',
      message: { id: 'msg_x', model: 'claude-test-5', usage },
    }).replace(`"${INF}"`, '1e400');

  test('every numeric field of a real usage line is either priced or declared unpriced', () => {
    assert.deepEqual(numericLeaves(REAL).sort(), [...PRICED, ...NOT_PRICED].sort());
    const parsed = parseLine(lineOf(REAL)).call.usage;
    assert.deepEqual(
      numericLeaves(parsed).sort(),
      [...PRICED].sort(),
      'parse keeps exactly the priced fields',
    );
    const e = priceOf(TABLE, 'claude-test-5');
    for (const f of PRICED)
      assert.ok(
        costOf(e, withLeaf(parsed, f, parsed[f] ?? 0)) > 0 &&
          costOf(e, withLeaf(parsed, f, 10_000)) > costOf(e, parsed),
        `${f} moves the price`,
      );
  });

  test('a malformed value in any priced field is unreadable at parse, never read as 0', () => {
    for (const f of PRICED)
      for (const bad of BAD) {
        const r = parseLine(lineOf(withLeaf(REAL, f, bad)));
        assert.ok(
          r?.unreadable,
          `${f} = ${JSON.stringify(bad)} must be unreadable, got ${JSON.stringify(r)}`,
        );
        assert.equal(r.call, undefined);
      }
    // absent and null are "not given", not malformed
    for (const f of PRICED) {
      assert.ok(parseLine(lineOf(withLeaf(REAL, f, null))).call, `${f} = null is absent`);
      assert.ok(parseLine(lineOf(withLeaf(REAL, f, undefined))).call, `${f} absent`);
    }
    for (const bad of ['split', 1000, true, [400, 600]])
      assert.ok(
        parseLine(lineOf({ ...REAL, cache_creation: bad })).unreadable,
        `cache_creation = ${JSON.stringify(bad)}`,
      );
  });

  test('a malformed priced field that reaches pricing throws USAGE_INVALID and daySpend isolates the row', () => {
    const e = priceOf(TABLE, 'claude-test-5');
    const usage = parseLine(lineOf(REAL)).call.usage;
    const w = world();
    const rows = {};
    for (const f of PRICED)
      for (const bad of [...BAD.filter((b) => b !== INF), Infinity, NaN]) {
        const u = withLeaf(usage, f, bad);
        assert.throws(() => costOf(e, u), /USAGE_INVALID/, `${f} = ${String(bad)}`);
        const key = `msg_${Object.keys(rows).length}|req`;
        rows[key] = { key, model: 'claude-test-5', usage: u, ts: NOW };
      }
    mkdirSync(join(w.home, 'spend', 'days'), { recursive: true });
    writeFileSync(join(w.home, 'spend', 'days', '2026-10-22.json'), JSON.stringify(rows));
    const s = daySpend({ home: w.home, day: '2026-10-22', table: TABLE });
    // JSON turns Infinity and NaN into null (absent), so those two rows price
    assert.equal(s.unreadable, Object.keys(rows).length - 2 * PRICED.length);
  });

  test('a cache split never prices below the same usage without it', () => {
    const e = priceOf(TABLE, 'claude-test-5');
    const splits = [{}, { ephemeral_5m_input_tokens: 400 }, { ephemeral_1h_input_tokens: 100 }];
    for (const s5 of [0, 1, 400, 1000, 1500])
      for (const s1h of [0, 1, 600, 1000, 1500])
        splits.push({ ephemeral_5m_input_tokens: s5, ephemeral_1h_input_tokens: s1h });
    for (const agg of [0, 1000])
      for (const split of splits) {
        const without = costOf(e, { input_tokens: 10, cache_creation_input_tokens: agg });
        const withSplit = costOf(e, {
          input_tokens: 10,
          cache_creation_input_tokens: agg,
          cache_creation: split,
        });
        assert.ok(
          withSplit >= without - 1e-15,
          `aggregate ${agg} split ${JSON.stringify(split)}: ${withSplit} < ${without}`,
        );
      }
    // the part a split leaves out is billed at the 5-minute price, as with no split
    close(
      costOf(e, {
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_1h_input_tokens: 100 },
      }),
      900 * 3.75 * M + 100 * 6 * M,
    );
    // a split larger than the aggregate is billed in full, and counts toward long context
    close(
      costOf(e, {
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
      }),
      400 * 3.75 * M + 600 * 6 * M,
    );
    // split tokens count toward the long-context threshold: 199,500 + 1,000 > 200,000
    close(
      costOf(e, { input_tokens: 199_500, cache_creation: { ephemeral_5m_input_tokens: 1000 } }),
      199_500 * 6 * M + 1000 * 7.5 * M,
    );
  });
});
