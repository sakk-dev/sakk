// SPDX-License-Identifier: AGPL-3.0-only
//
// T1 — concurrency soak with crash injection. N worker processes hammer ONE
// ledger with reserve/settle/read cycles while the conductor randomly
// SIGKILLs workers mid-flight; an auditor thread re-verifies the money
// invariants continuously and once more at the end. Any violation stops the
// soak with the full evidence. Evidence over vibes: the report states ops,
// kills, refusal counts, wall time, and the final book reconciliation.
//
//   node scripts/campaign/soak-ledger.mjs [--minutes 30] [--workers 8] [--seed N]
//   (SAKK_SOAK_MINUTES / SAKK_SOAK_WORKERS / SAKK_SOAK_SEED env equivalents)
//
// Worker mode (internal): invoked with --worker <ledgerPath> <workerSeed>.
// Exit codes: 0 invariants held · 1 violation (details on stderr).

import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  appendFileSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initLedger,
  reserve,
  settle,
  readLedger,
  totalsOf,
  clearReconciliation,
  LedgerError,
} from '../../src/ledger.mjs';

const CAP = 1000;

const arg = (name, env, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return Number(process.argv[i + 1]);
  if (process.env[env]) return Number(process.env[env]);
  return dflt;
};

// ---------- worker ----------
if (process.argv[2] === '--worker') {
  const ledgerPath = process.argv[3];
  let s = Number(process.argv[4]) >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
  const wid = process.pid;
  let n = 0;
  // First soak run earned its keep immediately: LEDGER_LOCK_UNAVAILABLE
  // appears under 8-way contention (documented behavior — the budget is
  // never judged without mutual exclusion). The soak COUNTS it; the rate
  // is an enterprise-relevant measurement, not a failure.
  const KNOWN = [
    'BUDGET_EXCEEDED',
    'DUPLICATE_CALL_ID',
    'RECONCILIATION_REQUIRED',
    'LEDGER_LOCK_UNAVAILABLE',
    'LEDGER_STALE',
    'SETTLE_MISMATCH',
    'SETTLE_INVALID',
    'SETTLE_UNKNOWN_CALL',
    'RECONCILIATION_ENTRIES_OPEN',
    'RECONCILE_BY_REQUIRED',
  ];
  const stats = Object.create(null);
  const bump = (code) => {
    stats[code] = (stats[code] ?? 0) + 1;
    if (n % 200 === 0)
      try {
        writeFileSync(`${ledgerPath}.stats-${wid}.json`, JSON.stringify({ ops: n, stats }));
      } catch {}
  };
  // Hammer forever; the conductor kills us. Every op outcome is appended to
  // the worker log so the auditor can cross-check granted vs booked.
  for (;;) {
    n += 1;
    // Orphan guard (campaign finding: a dead conductor left workers
    // hammering forever — the V6 zombie-worker lesson, re-earned): if our
    // parent died we were re-parented to PID 1; stop immediately.
    if (process.ppid === 1) process.exit(0);
    const callId = `w${wid}-${n}`;
    const est = Math.round(rnd() * 300) / 100 + 0.01;
    try {
      reserve({ ledgerPath, callId, estimatedMaxUsd: est, agentId: `soak-${wid}` });
      appendFileSync(`${ledgerPath}.granted-${wid}.log`, `${callId} ${est}\n`);
      bump('GRANTED');
      if (rnd() < 0.9) {
        // mostly settle honestly; sometimes at a different actual; rarely unknown-cost
        if (rnd() < 0.03) settle({ ledgerPath, callId, failedUnknownCost: true });
        else settle({ ledgerPath, callId, actualUsd: Math.round(rnd() * est * 100) / 100 });
      } // ~10% left dangling on purpose (outstanding reservations)
    } catch (e) {
      if (!(e instanceof LedgerError)) {
        console.error(`WORKER_UNTYPED_ERROR ${e.constructor.name}: ${e.message}`);
        process.exit(1);
      }
      if (!KNOWN.includes(e.code)) {
        console.error(`WORKER_UNKNOWN_CODE ${e.code}`);
        process.exit(1);
      }
      bump(e.code);
      if (e.code === 'RECONCILIATION_REQUIRED' && rnd() < 0.3) {
        // play the human: settle open reco entries, then sign the clear
        try {
          const doc = readLedger({ ledgerPath, maxAgeMs: Infinity });
          for (const en of doc.entries)
            if (en.status === 'RECONCILIATION_REQUIRED')
              settle({ ledgerPath, callId: en.callId, actualUsd: en.estimatedMaxUsd });
          clearReconciliation({ ledgerPath, by: `soak-human-${wid}` });
        } catch {
          /* raced another healer — fine */
        }
      }
    }
  }
}

// ---------- conductor ----------
const isMain =
  process.argv[1] !== undefined &&
  (() => {
    try {
      return (
        realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
      );
    } catch {
      return false;
    }
  })();

if (isMain) {
  const minutes = arg('minutes', 'SAKK_SOAK_MINUTES', 3);
  const workers = arg('workers', 'SAKK_SOAK_WORKERS', 8);
  const seed = arg('seed', 'SAKK_SOAK_SEED', Date.now());
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);

  const dir = mkdtempSync(join(tmpdir(), 'sakk-soak-'));
  const ledgerPath = join(dir, 'ledger.json');
  initLedger({ ledgerPath, capUsd: CAP, initializedBy: 'soak-conductor' });

  const die = (why, extra = {}) => {
    console.error(
      `SOAK FAILED (seed=${seed}): ${why}`,
      JSON.stringify(extra),
      `ledger=${ledgerPath}`,
    );
    process.exit(1);
  };

  const audit = (label) => {
    let doc;
    try {
      doc = readLedger({ ledgerPath, maxAgeMs: Infinity });
    } catch (e) {
      die(`${label}: ledger unreadable mid-soak`, { code: e.code });
    }
    const t = totalsOf(doc);
    // The one invariant that may never bend, chaos or not:
    if (t.committedUsd > CAP + 1e-6) die(`${label}: OVERSPEND`, { committed: t.committedUsd });
    const ids = new Set();
    for (const e of doc.entries) {
      if (ids.has(e.callId)) die(`${label}: duplicate entry`, { callId: e.callId });
      ids.add(e.callId);
      if (!['RESERVED', 'SETTLED', 'RECONCILIATION_REQUIRED'].includes(e.status))
        die(`${label}: alien entry status`, { status: e.status });
    }
    return { entries: doc.entries.length, committed: t.committedUsd };
  };

  const live = new Map();
  let kills = 0;
  let spawns = 0;
  const spawnWorker = () => {
    spawns += 1;
    const w = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), '--worker', ledgerPath, String(Math.floor(rnd() * 2 ** 31))],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    w.stderr.on('data', (c) => (err += c));
    w.on('exit', (code, sig) => {
      live.delete(w.pid);
      if (sig !== 'SIGKILL' && code !== 0 && !stopping)
        die('worker died red (not by our hand)', { code, sig, err: err.slice(0, 400) });
    });
    live.set(w.pid, w);
  };

  let stopping = false;
  for (let i = 0; i < workers; i++) spawnWorker();

  const deadline = Date.now() + minutes * 60_000;
  const tick = setInterval(() => {
    audit('mid');
    // crash injection: ~every other tick, SIGKILL a random worker and
    // replace it — the next acquirer must break the dead lock and carry on
    if (rnd() < 0.5 && live.size > 0) {
      const victims = [...live.values()];
      const v = victims[Math.floor(rnd() * victims.length)];
      v.kill('SIGKILL');
      kills += 1;
      spawnWorker();
    }
    if (Date.now() >= deadline) {
      stopping = true;
      clearInterval(tick);
      for (const w of live.values()) w.kill('SIGKILL');
      setTimeout(finish, 1500);
    }
  }, 2000);

  function finish() {
    const final = audit('final');
    // Cross-check direction matters under SIGKILL: a worker can die between
    // reserve() and writing its grant line, so "every grant is booked" is
    // not provable — but the reverse MUST hold: every BOOKED entry is a
    // real grant... minus exactly that race window. What is strictly
    // provable: booked entries never exceed grants by more than the number
    // of kills (each kill forfeits at most one in-flight grant line).
    const grants = new Set();
    for (const f of readdirSync(dir))
      if (f.startsWith('ledger.json.granted-'))
        for (const line of readFileSync(join(dir, f), 'utf8').split('\n'))
          if (line) grants.add(line.split(' ')[0]);
    const doc = readLedger({ ledgerPath, maxAgeMs: Infinity });
    const unexplained = doc.entries.filter((e) => !grants.has(e.callId));
    if (unexplained.length > kills)
      die('booked entries exceed recorded grants beyond the kill window', {
        unexplained: unexplained.length,
        kills,
        sample: unexplained.slice(0, 3).map((e) => e.callId),
      });
    const agg = Object.create(null);
    let aggOps = 0;
    for (const f of readdirSync(dir))
      if (f.startsWith('ledger.json.stats-')) {
        try {
          const st = JSON.parse(readFileSync(join(dir, f), 'utf8'));
          aggOps += st.ops;
          for (const [k, v] of Object.entries(st.stats)) agg[k] = (agg[k] ?? 0) + v;
        } catch {}
      }
    console.log(
      `soak: ${minutes}min · workers=${workers} (spawned ${spawns}, SIGKILLed ${kills}) · final entries=${final.entries} committed=$${final.committed.toFixed(2)}/${CAP} · unexplained-vs-kill-window ${unexplained.length}/${kills} · sampled ops=${aggOps} outcomes=${JSON.stringify(agg)} — ALL INVARIANTS HELD (seed=${seed})`,
    );
    process.exit(0);
  }
}
