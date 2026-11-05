import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daySpend, updateIndex } from '../src/spend.mjs';
import { loadPrices } from '../src/prices.mjs';
import { HAS_PTY, atTerminal } from './pty.mjs';

/**
 * The spend / cap / prices CLI (completes M2's documented surface, F-161). The
 * tests run the REAL sakk binary against real config and transcript files, and
 * drive the real hook, so a reported figure or an enforced cap is the tool's own.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'sakk.mjs');

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'spendcli-')));
  const home = join(base, '.sakk');
  const logs = join(base, '.claude', 'projects', '-work');
  mkdirSync(home, { recursive: true });
  mkdirSync(logs, { recursive: true });
  // HOME=base and CLAUDE_CONFIG_DIR='' → claudeLogDir resolves to base/.claude/projects
  const env = { ...process.env, SAKK_HOME: home, HOME: base, CLAUDE_CONFIG_DIR: '' };
  return { base, home, env, sessionFile: join(logs, 'session.jsonl') };
}
const callLine = ({ ts, model = 'deepseek-chat', req = 'req_1', id = 'msg_1', usage } = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    requestId: req,
    message: { id, model, usage: usage ?? { input_tokens: 1000, output_tokens: 100 } },
  }) + '\n';
const seed = (w, lines) => writeFileSync(w.sessionFile, lines.join(''));

function sakk(w, args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      env: w.env,
      cwd: w.base,
      encoding: 'utf8',
      ...opts,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      status: e.status ?? 1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
    };
  }
}
const config = (w) => JSON.parse(readFileSync(join(w.home, 'config.json'), 'utf8'));
const hookAnswer = (w, toolInput) =>
  sakk(w, ['hook', '--agent', 'claude-code'], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      cwd: w.base,
      session_id: 's',
      tool_use_id: 't',
      ...toolInput,
    }),
  }).stdout;

describe('spend / cap / prices CLI (F-161)', () => {
  test('sakk cap set writes the cap the hook then enforces', () => {
    const w = world();
    assert.equal(sakk(w, ['cap', 'set', '0.0001']).status, 0);
    assert.equal(config(w).capUsd, 0.0001);
    // a priced call today pushes spend over the tiny cap
    seed(w, [callLine({ ts: new Date().toISOString() })]);
    const answer = hookAnswer(w, { tool_name: 'Bash', tool_input: { command: 'echo hi' } });
    assert.match(answer, /"permissionDecision":"deny"/);
    assert.match(answer, /SPEND_CAP_REACHED/);
  });

  test(
    'sakk cap off, confirmed at a terminal, removes the cap and the hook stops enforcing',
    {
      skip: !HAS_PTY && 'python3 with pty is not installed',
    },
    () => {
      const w = world();
      sakk(w, ['cap', 'set', '0.0001']);
      seed(w, [callLine({ ts: new Date().toISOString() })]);
      // with no terminal it refuses (F-171); a person who types the word lifts it
      assert.equal(sakk(w, ['cap', 'off']).status, 2);
      assert.equal(config(w).capUsd, 0.0001);
      assert.equal(atTerminal(['cap', 'off'], 'off', { env: w.env, cwd: w.base }).status, 0);
      assert.equal(config(w).capUsd, undefined);
      const answer = hookAnswer(w, { tool_name: 'Bash', tool_input: { command: 'echo hi' } });
      // echo is allowed; with no cap there is no spend-cap deny (claude-code allow is silent)
      assert.doesNotMatch(answer, /SPEND_CAP_REACHED/);
    },
  );

  test('sakk cap set refuses a bad amount or zone', () => {
    const w = world();
    for (const amt of ['-5', '0', 'abc', '1e3', '0x10']) {
      const r = sakk(w, ['cap', 'set', amt]);
      assert.equal(r.status, 2, amt);
      assert.match(r.stderr, /CAP_USAGE/, amt);
    }
    const z = sakk(w, ['cap', 'set', '5', '--zone', 'Not/AZone']);
    assert.equal(z.status, 2);
    assert.match(z.stderr, /CAP_ZONE_INVALID/);
    const noSub = sakk(w, ['cap']);
    assert.equal(noSub.status, 2);
    assert.match(noSub.stderr, /CAP_USAGE/);
  });

  test('sakk spend reports a day of spend from local logs', () => {
    const w = world();
    sakk(w, ['cap', 'set', '5']);
    seed(w, [callLine({ ts: '2026-10-22T10:00:00Z' })]);
    const r = sakk(w, ['spend', '--day', '2026-10-22', '--json']);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.source, 'from local logs');
    assert.ok(out.spend_usd > 0, 'a priced call is counted');
    assert.ok('deepseek-chat' in out.by_model);
    // the text form names the source and the model
    const t = sakk(w, ['spend', '--day', '2026-10-22']);
    assert.match(t.stdout, /from local logs/);
    assert.match(t.stdout, /deepseek-chat/);
  });

  test('sakk spend and the hook read the same cap and spend', () => {
    const w = world();
    sakk(w, ['cap', 'set', '5']);
    seed(w, [callLine({ ts: '2026-10-22T10:00:00Z' })]);
    const out = JSON.parse(sakk(w, ['spend', '--day', '2026-10-22', '--json']).stdout);
    // recompute with the same library the hook uses, over the same files
    updateIndex({ home: w.home, logDir: join(w.base, '.claude', 'projects'), zone: 'UTC' });
    const direct = daySpend({
      home: w.home,
      day: '2026-10-22',
      table: loadPrices({ home: w.home }).table,
    });
    assert.equal(out.spend_usd, direct.usd);
    assert.equal(out.cap_usd, 5);
  });

  test('sakk spend uses the configured zone, not the system one', () => {
    const w = world();
    sakk(w, ['cap', 'set', '5', '--zone', 'Asia/Kolkata']); // UTC+5:30
    // 20:00 UTC is 01:30 next day in Kolkata, so it belongs to 2026-10-23 there
    seed(w, [callLine({ ts: '2026-10-22T20:00:00Z' })]);
    const next = JSON.parse(sakk(w, ['spend', '--day', '2026-10-23', '--json']).stdout);
    assert.equal(next.zone, 'Asia/Kolkata');
    assert.ok(next.spend_usd > 0, 'the call lands on the Kolkata day, not the UTC day');
    const utcDay = JSON.parse(sakk(w, ['spend', '--day', '2026-10-22', '--json']).stdout);
    assert.equal(utcDay.spend_usd, 0, 'not counted on the UTC calendar day');
  });

  test('sakk prices shows the table and its source', () => {
    const w = world();
    const r = sakk(w, ['prices']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /deepseek-chat/);
    assert.match(r.stdout, /snapshot\.json/);
    const j = JSON.parse(sakk(w, ['prices', '--json']).stdout);
    assert.ok('deepseek-chat' in j.models);
    assert.match(j.source, /snapshot\.json$/);
  });

  test('sakk prices prints the provenance its table records: url, commit, sha256, fetch date', () => {
    const w = world();
    const shipped = JSON.parse(readFileSync(join(ROOT, 'prices', 'snapshot.json'), 'utf8')).source;
    const text = sakk(w, ['prices']).stdout;
    const line = text.split('\n').find((l) => l.includes('provenance'));
    assert.ok(line, 'a provenance line is printed');
    assert.match(line, /as recorded in the table/);
    for (const k of ['url', 'commit', 'sha256', 'fetchedAt']) {
      assert.equal(typeof shipped[k], 'string', `the snapshot records ${k}`);
      assert.ok(line.includes(shipped[k]), `the printed provenance carries ${k}`);
    }
    const j = JSON.parse(sakk(w, ['prices', '--json']).stdout);
    assert.match(j.source, /snapshot\.json$/, 'source stays the path of the table in use');
    for (const k of ['url', 'commit', 'sha256', 'fetchedAt'])
      assert.equal(j.provenance[k], shipped[k]);
  });

  test('sakk prices says when a table records no provenance, and escapes a hostile one', () => {
    const w = world();
    const model = { input: 1e-6, output: 2e-6, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
    const plant = (source) =>
      writeFileSync(
        join(w.home, 'prices.json'),
        JSON.stringify({
          schema: 'sakk-prices.v1',
          ...(source && { source }),
          models: { m1: model },
        }),
      );

    plant(undefined);
    let text = sakk(w, ['prices']).stdout;
    assert.match(text, /provenance: not recorded in this table/);
    assert.match(text, /m1 {2}in /, 'the model list still prints');
    assert.equal(JSON.parse(sakk(w, ['prices', '--json']).stdout).provenance, null);

    plant('not an object');
    assert.match(sakk(w, ['prices']).stdout, /provenance: not recorded in this table/);

    plant({ url: 'https://example.test/p\u001b[31m.json', commit: 42, sha256: ['x'] });
    const r = sakk(w, ['prices']);
    assert.equal(r.status, 0, 'a malformed source block does not fail the command');
    assert.ok(!r.stdout.includes('\u001b'), 'no raw escape byte reaches the terminal');
    assert.match(r.stdout, /p\\x1b\[31m\.json/, 'the escape byte is shown escaped');
    assert.doesNotMatch(r.stdout, /at commit|sha256/, 'fields that are not strings are left out');
    assert.match(r.stdout, /m1 {2}in /);
    const j = JSON.parse(sakk(w, ['prices', '--json']).stdout);
    assert.deepEqual(Object.keys(j.provenance), ['url']);
  });

  test('sakk spend refuses a malformed or impossible --day', () => {
    const w = world();
    for (const bad of ['10-22-2026', '2026-13-40', '2026-02-30', 'abcd-ef-gh']) {
      const r = sakk(w, ['spend', '--day', bad]);
      assert.equal(r.status, 2, bad);
      assert.match(r.stderr, /SPEND_USAGE/, bad);
    }
  });

  test('sakk cap set reports a typed error on an unreadable config, not a stack', () => {
    const w = world();
    writeFileSync(join(w.home, 'config.json'), '{ this is not json');
    const r = sakk(w, ['cap', 'set', '5']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /HOOK_CONFIG_UNREADABLE/);
    assert.doesNotMatch(r.stderr, /at Object\.|node:internal/); // no raw stack
  });

  test('the agent cannot set its own cap (writing ~/.sakk is denied)', () => {
    const w = world();
    // direct write to the config → denied outright
    const direct = hookAnswer(w, {
      tool_name: 'Write',
      tool_input: { file_path: join(w.home, 'config.json'), content: '{"capUsd":999999}' },
    });
    assert.match(direct, /"permissionDecision":"deny"/);
    assert.match(direct, /protect-guard-state/);
    // a one-command symlink/hard-link chain into ~/.sakk cannot resolve statically,
    // so it is never a silent allow — it needs a person's approval (F-163)
    for (const command of [
      `ln -s ${w.home} lnk && echo '{"capUsd":999999}' > lnk/config.json`,
      `ln ${join(w.home, 'config.json')} y && echo x > y`,
    ]) {
      const a = hookAnswer(w, { tool_name: 'Bash', tool_input: { command } });
      assert.notEqual(a, '', `not a silent allow: ${command}`);
      assert.doesNotMatch(a, /"permissionDecision":"allow"/, command);
    }
  });
});

describe('F-204 / F-205 — sakk spend tells the truth about what it could not count', () => {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  test(
    'F-204: an unlistable log directory is a typed failure, never $0 (UAT S-REL-002)',
    { skip: asRoot && 'root ignores file modes' },
    () => {
      const w = world();
      sakk(w, ['cap', 'set', '5', '--zone', 'UTC']);
      seed(w, [callLine({ ts: '2026-10-22T10:00:00Z' })]);
      const logs = dirname(w.sessionFile);
      chmodSync(logs, 0o000);
      try {
        const r = sakk(w, ['spend', '--day', '2026-10-22']);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /SPEND_LOGS_UNLISTABLE/);
        assert.ok(r.stderr.includes(logs), 'the failure names the directory');
        assert.doesNotMatch(r.stdout, /\$0/, 'no figure is reported');
      } finally {
        chmodSync(logs, 0o700);
      }
      const ok = sakk(w, ['spend', '--day', '2026-10-22', '--json']);
      assert.equal(ok.status, 0, ok.stderr);
      assert.ok(JSON.parse(ok.stdout).spend_usd > 0, 'counted once the directory is listable');
    },
  );

  test(
    'sakk spend names an unreadable log file and exits 1 without a stack (F-192)',
    { skip: asRoot && 'root ignores file modes' },
    () => {
      const w = world();
      sakk(w, ['cap', 'set', '5', '--zone', 'UTC']);
      seed(w, [callLine({ ts: '2026-10-22T10:00:00Z' })]);
      chmodSync(w.sessionFile, 0o000);
      try {
        const r = sakk(w, ['spend', '--day', '2026-10-22']);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /SPEND_LOGS_UNLISTABLE/);
        assert.match(r.stderr, /session\.jsonl \(EACCES\)/, 'names the file and its error');
        assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
        assert.doesNotMatch(r.stdout, /\$0/, 'no figure is reported');
      } finally {
        chmodSync(w.sessionFile, 0o600);
      }
      const ok = sakk(w, ['spend', '--day', '2026-10-22', '--json']);
      assert.equal(ok.status, 0, ok.stderr);
      assert.ok(JSON.parse(ok.stdout).spend_usd > 0, 'counted once the file is readable');
    },
  );

  test('F-205: a future-dated line is counted on the day observed and said so (UAT S-REL-005)', () => {
    const w = world();
    sakk(w, ['cap', 'set', '5', '--zone', 'UTC']);
    seed(w, [callLine({ ts: new Date(Date.now() + 172_800_000).toISOString() })]); // 48 h ahead
    const today = new Date().toISOString().slice(0, 10);
    const r = sakk(w, ['spend', '--day', today, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(out.spend_usd > 0, 'the future-dated call counts today');
    assert.equal(out.future, 1, 'and the JSON flags it');
    const t = sakk(w, ['spend', '--day', today]);
    assert.match(t.stdout, /dated in the future — counted on the day observed/);
  });
});
