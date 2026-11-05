import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initLedger, reserve, settle } from '../src/ledger.mjs';
import { HAS_PTY, atTerminal } from './pty.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'sakk.mjs');

const tdir = () => mkdtempSync(join(tmpdir(), 'sakk-cli-'));

// every run gets its own SAKK_HOME unless the test passes one: init records the
// ledger in SAKK_HOME/config.json, and the real ~/.sakk must never be touched
const run = (args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SAKK_LEDGER_PATH: '', SAKK_HOME: tdir(), ...env },
  });

const recorded = (home) => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).ledgerPath;

describe('sakk init', () => {
  test('creates a ledger at --ledger and refuses a second init', () => {
    const p = join(tdir(), 'l.json');
    const r1 = run(['init', '--cap', '25', '--ledger', p]);
    assert.equal(r1.status, 0, r1.stderr);
    assert.ok(existsSync(p));
    assert.match(r1.stdout, /ledger created/);
    const r2 = run(['init', '--cap', '25', '--ledger', p]);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /LEDGER_ALREADY_EXISTS/);
  });
  test('missing --cap is a usage error (exit 2)', () => {
    const r = run(['init', '--ledger', join(tdir(), 'l.json')]);
    assert.equal(r.status, 2);
  });
  test('resolves the path from SAKK_LEDGER_PATH when no flag is given', () => {
    const p = join(tdir(), 'env.json');
    const r = run(['init', '--cap', '5'], { SAKK_LEDGER_PATH: p });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(p));
  });
  test('records the ledger for the hook and never replaces a different one (F-172)', () => {
    const home = tdir();
    const d = tdir();
    const a = join(d, 'a.json');
    const b = join(d, 'b.json');
    const first = run(['init', '--cap', '5', '--ledger', a], { SAKK_HOME: home });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /hook wired/);
    assert.equal(recorded(home), a);
    // a second ledger is created, but the hook keeps the recorded one and init says so
    const other = run(['init', '--cap', '5', '--ledger', b], { SAKK_HOME: home });
    assert.equal(other.status, 0, other.stderr);
    assert.ok(existsSync(b));
    assert.doesNotMatch(other.stdout, /hook wired/);
    assert.match(other.stderr, /still reads halts from/);
    assert.equal(recorded(home), a);
  });
  test('re-running init wires an existing ledger without touching it, once (F-172)', () => {
    const p = join(tdir(), 'l.json');
    assert.equal(run(['init', '--cap', '5', '--ledger', p]).status, 0);
    const ledger = readFileSync(p);
    const home = tdir();
    const again = run(['init', '--cap', '9', '--ledger', p], { SAKK_HOME: home });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /LEDGER_ALREADY_EXISTS/);
    assert.match(again.stdout, /hook wired/);
    assert.equal(recorded(home), p);
    assert.deepEqual(readFileSync(p), ledger, 'the existing ledger is not rewritten');
    const config = readFileSync(join(home, 'config.json'));
    const third = run(['init', '--cap', '9', '--ledger', p], { SAKK_HOME: home });
    assert.equal(third.status, 1);
    assert.doesNotMatch(third.stdout, /hook wired/);
    assert.doesNotMatch(third.stderr, /still reads/);
    assert.deepEqual(readFileSync(join(home, 'config.json')), config, 'nothing to change');
  });
  test('a file that is not a ledger is never wired to the hook (F-172)', () => {
    const p = join(tdir(), 'notes.json');
    writeFileSync(p, '{"hello":1}\n');
    const home = tdir();
    const r = run(['init', '--cap', '5', '--ledger', p], { SAKK_HOME: home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not wired/);
    assert.match(r.stderr, /LEDGER_ALREADY_EXISTS/);
    assert.equal(existsSync(join(home, 'config.json')), false);
    assert.equal(readFileSync(p, 'utf8'), '{"hello":1}\n');
  });
  test('without --ledger a command uses the recorded ledger from any directory (F-172)', () => {
    const home = tdir();
    const p = join(tdir(), 'l.json');
    assert.equal(run(['init', '--cap', '7', '--ledger', p], { SAKK_HOME: home }).status, 0);
    const r = spawnSync(process.execPath, [CLI, 'status', '--json'], {
      encoding: 'utf8',
      cwd: tdir(),
      env: { ...process.env, SAKK_HOME: home, SAKK_LEDGER_PATH: join(tdir(), 'other.json') },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).cap_usd, 7);
    // the variable lost to the recorded path, and the CLI says so
    assert.match(r.stderr, /SAKK_LEDGER_PATH \(.*\) is not used/);
    assert.equal(
      run(['status', '--json', '--ledger', join(tdir(), 'x.json')], { SAKK_HOME: home }).status,
      1,
    );
  });
});

describe('sakk status', () => {
  test('missing ledger → LEDGER_MISSING, exit 1', () => {
    const r = run(['status', '--ledger', join(tdir(), 'nope.json')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /LEDGER_MISSING/);
  });
  test('--json reports totals that match the ledger', () => {
    const p = join(tdir(), 'l.json');
    run(['init', '--cap', '10', '--ledger', p]);
    reserve({ ledgerPath: p, callId: 'a', estimatedMaxUsd: 2 });
    settle({ ledgerPath: p, callId: 'a', actualUsd: 1.25 });
    reserve({ ledgerPath: p, callId: 'b', estimatedMaxUsd: 3 });
    const r = run(['status', '--json', '--ledger', p]);
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.cap_usd, 10);
    assert.equal(s.settled_usd, 1.25);
    assert.equal(s.outstanding_usd, 3);
    assert.equal(s.committed_usd, 4.25);
    assert.equal(s.remaining_usd, 5.75);
    // E6: the advertised number must be actually reservable (the wall refuses
    // exactly-remaining)
    assert.ok(s.max_reservable_usd < s.remaining_usd);
    assert.equal(
      reserve({ ledgerPath: p, callId: 'fit', estimatedMaxUsd: s.max_reservable_usd }).ok,
      true,
    );
    assert.equal(s.entries.SETTLED, 1);
    assert.equal(s.entries.RESERVED, 1);
    assert.equal(s.reconciliation_required, false);
  });
  test('reconciliation-required ledger → exit 3 with the reason shown', () => {
    const p = join(tdir(), 'l.json');
    run(['init', '--cap', '10', '--ledger', p]);
    reserve({ ledgerPath: p, callId: 'x', estimatedMaxUsd: 2 });
    settle({ ledgerPath: p, callId: 'x', failedUnknownCost: true });
    const r = run(['status', '--ledger', p]);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /RECONCILIATION REQUIRED/);
  });
});

describe('sakk reconcile', () => {
  test('requires --by (exit 2); without a terminal a signed clear refuses and changes nothing', () => {
    const p = join(tdir(), 'l.json');
    run(['init', '--cap', '10', '--ledger', p]);
    reserve({ ledgerPath: p, callId: 'x', estimatedMaxUsd: 2 });
    settle({ ledgerPath: p, callId: 'x', failedUnknownCost: true });
    assert.equal(run(['reconcile', '--ledger', p]).status, 2);
    // F-177: an agent's run has no terminal — the signed clear refuses before
    // the books are touched, and the flag stays set.
    const refused = run(['reconcile', '--by', 'maintainer', '--ledger', p]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /HUMAN_CONFIRMATION_REQUIRED/);
    assert.equal(run(['status', '--ledger', p]).status, 3, 'the flag is still set');
  });
  test(
    'at a terminal: open entries still block the clear (E2), then a signed clear succeeds',
    { skip: !HAS_PTY && 'python3 with pty is not installed' },
    () => {
      const p = join(tdir(), 'l.json');
      const home = tdir();
      run(['init', '--cap', '10', '--ledger', p]);
      reserve({ ledgerPath: p, callId: 'x', estimatedMaxUsd: 2 });
      settle({ ledgerPath: p, callId: 'x', failedUnknownCost: true });
      const env = { ...process.env, SAKK_LEDGER_PATH: '', SAKK_HOME: home };
      // Entry still unresolved: the signed clear must refuse (E2 semantics)
      const blocked = atTerminal(['reconcile', '--by', 'maintainer', '--ledger', p], 'reconcile', {
        env,
        cwd: home,
      });
      assert.equal(blocked.status, 1, blocked.out);
      assert.match(blocked.out, /RECONCILIATION_ENTRIES_OPEN/);
      settle({ ledgerPath: p, callId: 'x', actualUsd: 1.5 });
      const r = atTerminal(['reconcile', '--by', 'maintainer', '--ledger', p], 'reconcile', {
        env,
        cwd: home,
      });
      assert.equal(r.status, 0, r.out);
      assert.equal(run(['status', '--ledger', p]).status, 0);
    },
  );
  test('stranger finding: reconcile on a clean ledger says "nothing to clear", never "cleared"', () => {
    const p = join(tdir(), 'l.json');
    run(['init', '--cap', '10', '--ledger', p]);
    const r = run(['reconcile', '--by', 'alice', '--ledger', p]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to clear/);
    assert.doesNotMatch(r.stdout, /cleared by/);
  });
});

describe('stranger finding: human status output formats money', () => {
  test('the 1e-6 reserve guard never prints a float tail', () => {
    const p = join(tdir(), 'l.json');
    run(['init', '--cap', '25', '--ledger', p]);
    reserve({ ledgerPath: p, callId: 'a', estimatedMaxUsd: 1 });
    reserve({ ledgerPath: p, callId: 'b', estimatedMaxUsd: 0.12 });
    const r = run(['status', '--ledger', p]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /max reservable \$23\.879999\)/);
    assert.doesNotMatch(r.stdout, /\$\d+\.\d{7,}/, 'no money figure may exceed 6 decimals');
    // machines keep the raw number (tolerance: formatting must not touch it)
    const j = JSON.parse(run(['status', '--json', '--ledger', p]).stdout);
    assert.ok(Math.abs(j.max_reservable_usd - (25 - (1 + 0.12) - 1e-6)) < 1e-12);
  });
});

describe('usage surface', () => {
  test('--help exits 0, unknown command exits 2, --version prints semver', () => {
    assert.equal(run(['--help']).status, 0);
    assert.equal(run(['frobnicate']).status, 2);
    assert.match(run(['--version']).stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});

describe('sakk unlock', () => {
  test('requires --by; reports a missing lock without asking; refuses to break one with no terminal', () => {
    const p = join(tdir(), 'l.json');
    run(['init', '--cap', '10', '--ledger', p]);
    assert.equal(run(['unlock', '--ledger', p]).status, 2);
    const r0 = run(['unlock', '--by', 'maintainer', '--ledger', p]);
    assert.equal(r0.status, 0, r0.stderr);
    assert.match(r0.stdout, /no lock present/);
    mkdirSync(`${p}.lock`);
    // F-177: breaking the lock is a person's move — an agent's run refuses.
    const r1 = run(['unlock', '--by', 'maintainer', '--ledger', p]);
    assert.equal(r1.status, 2);
    assert.match(r1.stderr, /HUMAN_CONFIRMATION_REQUIRED/);
    assert.ok(existsSync(`${p}.lock`), 'the lock is untouched');
  });
  test(
    'at a terminal, a signed unlock removes a stuck lock',
    { skip: !HAS_PTY && 'python3 with pty is not installed' },
    () => {
      const p = join(tdir(), 'l.json');
      const home = tdir();
      run(['init', '--cap', '10', '--ledger', p]);
      mkdirSync(`${p}.lock`);
      const env = { ...process.env, SAKK_LEDGER_PATH: '', SAKK_HOME: home };
      const r1 = atTerminal(['unlock', '--by', 'maintainer', '--ledger', p], 'unlock', {
        env,
        cwd: home,
      });
      assert.equal(r1.status, 0, r1.out);
      assert.match(r1.out, /lock removed by maintainer/);
    },
  );
});

describe('sakk settle', () => {
  const entry = (p, id) =>
    JSON.parse(readFileSync(p, 'utf8')).entries.find((e) => e.callId === id) ?? null;
  const alertLines = (p) => {
    const a = join(dirname(p), 'sakk-alerts.jsonl');
    return existsSync(a)
      ? readFileSync(a, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  };
  const held = () => {
    const p = join(tdir(), 'l.json');
    run(['init', '--cap', '10', '--ledger', p]);
    reserve({ ledgerPath: p, callId: 'gw-1', estimatedMaxUsd: 2.5, agentId: 'litellm-gateway' });
    return p;
  };

  test('settle requires --by and a call id, and refuses with no terminal (F-242)', () => {
    const p = held();
    for (const args of [
      ['settle', 'gw-1', '--ledger', p],
      ['settle', 'gw-1', '--by', '  ', '--ledger', p],
      ['settle', '--by', 'maintainer', '--ledger', p],
      ['settle', 'gw-1', 'gw-2', '--by', 'maintainer', '--ledger', p],
      ['settle', 'gw-1', '--by', 'maintainer', '--amount', '0', '--ledger', p],
    ]) {
      const r = run(args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    }
    // an agent's run has no terminal: releasing the reservation is a person's
    // move, and nothing changes
    const r = run(['settle', 'gw-1', '--by', 'maintainer', '--ledger', p]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /HUMAN_CONFIRMATION_REQUIRED/);
    assert.equal(entry(p, 'gw-1').status, 'RESERVED', 'the reservation is untouched');
    assert.deepEqual(alertLines(p), []);
  });

  test('settle of an already-settled or unknown call asks no one: no-op or SETTLE_UNKNOWN_CALL (F-242)', () => {
    const p = held();
    settle({ ledgerPath: p, callId: 'gw-1', actualUsd: 0.25 });
    // no terminal here: a no-op that reached the prompt would exit 2
    const done = run(['settle', 'gw-1', '--by', 'maintainer', '--ledger', p]);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /nothing to settle: gw-1 is already settled at \$0\.25/);
    assert.equal(entry(p, 'gw-1').actualUsd, 0.25, 'the real figure is kept');
    const unknown = run(['settle', 'never-reserved', '--by', 'maintainer', '--ledger', p]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /SETTLE_UNKNOWN_CALL/);
    // an entry sealed into the cold trail is settled too (seal after every settle)
    const q = join(tdir(), 'sealed.json');
    run(['init', '--cap', '10', '--ledger', q]);
    const ledgerUrl = new URL('../src/ledger.mjs', import.meta.url).href;
    const sealer = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { reserve, settle } from ${JSON.stringify(ledgerUrl)};
         const p = ${JSON.stringify(q)};
         reserve({ ledgerPath: p, callId: 'old', estimatedMaxUsd: 1 });
         settle({ ledgerPath: p, callId: 'old', actualUsd: 0.5 });`,
      ],
      { encoding: 'utf8', env: { ...process.env, SAKK_SEAL_AT: '1' } },
    );
    assert.equal(sealer.status, 0, sealer.stderr);
    assert.equal(entry(q, 'old'), null, 'the entry left the hot file');
    const sealed = run(['settle', 'old', '--by', 'maintainer', '--ledger', q]);
    assert.equal(sealed.status, 0, sealed.stderr);
    assert.match(sealed.stdout, /nothing to settle: old is already settled \(sealed\)/);
    assert.deepEqual(alertLines(p), []);
  });

  test('settle refuses an entry that awaits reconciliation and points at sakk reconcile (F-242)', () => {
    const p = held();
    settle({ ledgerPath: p, callId: 'gw-1', failedUnknownCost: true });
    const before = readFileSync(p, 'utf8');
    const r = run(['settle', 'gw-1', '--by', 'maintainer', '--ledger', p]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /SETTLE_AWAITS_RECONCILIATION/);
    assert.match(r.stderr, /sakk reconcile --by/);
    assert.doesNotMatch(r.stderr, /HUMAN_CONFIRMATION_REQUIRED/, 'refused before any prompt');
    assert.equal(readFileSync(p, 'utf8'), before, 'nothing changed');
  });

  test(
    'at a terminal, settle releases a stuck reservation at its reserved amount and logs who did it (F-242)',
    { skip: !HAS_PTY && 'python3 with pty is not installed' },
    () => {
      const p = held();
      const home = tdir();
      const env = { ...process.env, SAKK_LEDGER_PATH: '', SAKK_HOME: home };
      // the wrong word changes nothing
      const no = atTerminal(['settle', 'gw-1', '--by', 'maintainer', '--ledger', p], 'yes', {
        env,
        cwd: home,
      });
      assert.equal(no.status, 2, no.out);
      assert.equal(entry(p, 'gw-1').status, 'RESERVED');
      const r = atTerminal(['settle', 'gw-1', '--by', 'maintainer', '--ledger', p], 'settle', {
        env,
        cwd: home,
      });
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /at its reserved \$2\.5/, 'the prompt states the amount it books');
      assert.match(r.out, /settled gw-1 at its reserved \$2\.5 by maintainer/);
      const e = entry(p, 'gw-1');
      assert.equal(e.status, 'SETTLED');
      assert.equal(e.actualUsd, 2.5);
      const alerts = alertLines(p).filter((a) => a.kind === 'SETTLED_AT_RESERVED');
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].callId, 'gw-1');
      assert.equal(alerts[0].by, 'maintainer');
      assert.equal(alerts[0].usd, 2.5);
      assert.equal(alerts[0].agentId, 'litellm-gateway');
      // over-record, never release: the worst case now counts as spent, and
      // nothing is outstanding any more
      const s = JSON.parse(run(['status', '--json', '--ledger', p]).stdout);
      assert.equal(s.settled_usd, 2.5);
      assert.equal(s.outstanding_usd, 0);
    },
  );

  test(
    'settle that cannot write who did it says so and exits 1, the books already settled (F-242)',
    { skip: !HAS_PTY && 'python3 with pty is not installed' },
    () => {
      const p = held();
      const home = tdir();
      mkdirSync(join(dirname(p), 'sakk-alerts.jsonl'));
      const env = { ...process.env, SAKK_LEDGER_PATH: '', SAKK_HOME: home };
      const r = atTerminal(['settle', 'gw-1', '--by', 'maintainer', '--ledger', p], 'settle', {
        env,
        cwd: home,
      });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /record it by hand/);
      assert.equal(entry(p, 'gw-1').status, 'SETTLED');
    },
  );
});

describe('review fix F3: flag parsing', () => {
  test('a flag given without a value refuses instead of swallowing the next flag', () => {
    const r = run(['init', '--cap', '5', '--ledger', '--json']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--ledger requires a value/);
    assert.equal(existsSync('--json'), false);
  });
});

describe('2026-10-17 regression: status and reconcile tell the truth about spending', () => {
  const stale = (p) => {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    d.updatedAt = new Date(Date.now() - 30 * 864e5).toISOString();
    writeFileSync(p, JSON.stringify(d));
  };
  const fresh = () => {
    const p = join(tdir(), 'l.json');
    assert.equal(run(['init', '--cap', '25', '--ledger', p]).status, 0);
    return p;
  };
  test('review S2: a stale ledger is shown as stale, exits 3, and reports nothing reservable', () => {
    const p = fresh();
    stale(p);
    const r = run(['status', '--ledger', p]);
    assert.equal(r.status, 3, r.stdout);
    assert.match(r.stdout, /STALE/);
    const j = JSON.parse(run(['status', '--json', '--ledger', p]).stdout);
    assert.deepEqual([j.stale, j.max_reservable_usd], [true, 0]);
  });
  test('review S2: an entry awaiting reconciliation exits 3 even when the flag was cleared by hand', () => {
    const p = fresh();
    reserve({ ledgerPath: p, callId: 'x', estimatedMaxUsd: 1 });
    settle({ ledgerPath: p, callId: 'x', failedUnknownCost: true });
    const d = JSON.parse(readFileSync(p, 'utf8'));
    d.flags = { reconciliationRequired: false, reason: null };
    writeFileSync(p, JSON.stringify(d));
    assert.equal(run(['status', '--ledger', p]).status, 3);
  });
  test('review S7: an agent-chosen callId in the reconciliation reason reaches the terminal escaped', () => {
    const p = fresh();
    reserve({ ledgerPath: p, callId: 'c\u001b[2J', estimatedMaxUsd: 1 });
    settle({ ledgerPath: p, callId: 'c\u001b[2J', failedUnknownCost: true });
    const r = run(['status', '--ledger', p]);
    assert.ok(!r.stdout.includes('\u001b'), JSON.stringify(r.stdout));
  });
  test(
    'review S3: a signed reconcile at a terminal confirms a stale ledger, and spending resumes',
    { skip: !HAS_PTY && 'python3 with pty is not installed' },
    () => {
      const p = fresh();
      stale(p);
      const home = tdir();
      const env = { ...process.env, SAKK_LEDGER_PATH: '', SAKK_HOME: home };
      const r = atTerminal(['reconcile', '--by', 'alice', '--ledger', p], 'reconcile', {
        env,
        cwd: home,
      });
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /stale books confirmed by alice/);
      assert.equal(run(['status', '--ledger', p]).status, 0);
      reserve({ ledgerPath: p, callId: 'after', estimatedMaxUsd: 1 });
    },
  );
  test('review N1/N2/N12: blank signatures, an empty SAKK_LEDGER_PATH and a hex cap refuse', () => {
    const p = fresh();
    for (const args of [
      ['reconcile', '--by', '   ', '--ledger', p],
      ['unlock', '--by', ' ', '--ledger', p],
      ['init', '--cap', '0x10', '--ledger', join(tdir(), 'h.json')],
      ['init', '--cap', '5', '--by', '  ', '--ledger', join(tdir(), 'b.json')],
      ['status'],
    ])
      assert.equal(run(args, { SAKK_LEDGER_PATH: '' }).status, 2, args.join(' '));
  });
});

describe('F-177 — the default ledger lives under SAKK_HOME, never in the project cwd', () => {
  const bare = (args, env, cwd) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd });
  const noEnvPath = (home) => {
    const env = { ...process.env, SAKK_HOME: home };
    delete env.SAKK_LEDGER_PATH;
    return env;
  };

  test('init with no --ledger and no SAKK_LEDGER_PATH creates and records SAKK_HOME/sakk-ledger.json', () => {
    const home = tdir();
    const cwd = tdir();
    const r = bare(['init', '--cap', '10'], noEnvPath(home), cwd);
    assert.equal(r.status, 0, r.stderr);
    const lp = join(home, 'sakk-ledger.json');
    assert.ok(existsSync(lp), 'the ledger is under SAKK_HOME');
    assert.equal(existsSync(join(cwd, 'sakk-ledger.json')), false, 'nothing lands in the cwd');
    assert.equal(recorded(home), lp, 'config.json records the SAKK_HOME path');
  });

  test('a leftover ./sakk-ledger.json refuses with LEDGER_PATH_LEGACY instead of being silently ignored', () => {
    const home = tdir();
    const cwd = tdir();
    initLedger({ ledgerPath: join(cwd, 'sakk-ledger.json'), capUsd: 10 });
    const r = bare(['status'], noEnvPath(home), cwd);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /LEDGER_PATH_LEGACY/);
    assert.match(r.stderr, /nothing was read or changed/);
    // Named explicitly, the old file still works and the refusal does not fire.
    const ok = bare(['status', '--ledger', join(cwd, 'sakk-ledger.json')], noEnvPath(home), cwd);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.doesNotMatch(ok.stderr, /LEDGER_PATH_LEGACY/);
  });
});
