// SPDX-License-Identifier: Apache-2.0
//
// T2 — fault injection. Every way the WORLD can break must surface as a
// NAMED refusal, never a crash, never a silent success:
//   A. corrupt-ledger corpus: truncated / bit-flipped / wrong-schema /
//      empty / binary / giant-number / prototype-polluted documents;
//   B. permission faults: read-only ledger file, read-only directory
//      (lock cannot be created), unwritable alerts path;
//   C. clock skew: updatedAt in the future / far past (staleness gate);
//   D. lock debris: stale lock with garbage owner.json, foreign-host lock.
// ENOSPC needs a size-limited filesystem → runs in the Linux container leg
// of the matrix (T4), not here.
//
//   node scripts/campaign/fault-injection.mjs            # all local legs
// Exit: 0 all faults answered with typed codes · 1 any crash/silent-success.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLedger, reserve, readLedger, LedgerError } from '../../src/ledger.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'sakk-fault-'));
let failures = 0;
let passes = 0;
const fail = (label, detail) => {
  failures += 1;
  console.error(`✗ ${label}: ${detail}`);
};
const expectTyped = (label, fn, codes = null) => {
  try {
    fn();
    fail(label, 'SILENT SUCCESS — the fault was swallowed');
  } catch (e) {
    if (!(e instanceof LedgerError)) {
      fail(label, `untyped ${e.constructor.name}: ${e.message.slice(0, 100)}`);
      return;
    }
    if (codes && !codes.includes(e.code)) {
      fail(label, `unexpected code ${e.code} (wanted ${codes.join('|')})`);
      return;
    }
    passes += 1;
    console.log(`✓ ${label} → ${e.code}`);
  }
};

const freshLedger = () => {
  const p = join(dir(), 'l.json');
  initLedger({ ledgerPath: p, capUsd: 10 });
  return p;
};

// ---------- A. corrupt-ledger corpus ----------
// First harness run was itself a lesson: the ledger is PRETTY-printed, so
// whitespace-blind regex "corruption" silently corrupted nothing and 19
// false alarms fired. Structured mutations now go parse → mutate →
// stringify, which cannot miss.
{
  const good = readFileSync(freshLedger(), 'utf8');
  const mut = (fn) => {
    const d = JSON.parse(good);
    fn(d);
    return JSON.stringify(d);
  };
  const corpus = {
    truncated_half: good.slice(0, Math.floor(good.length / 2)),
    truncated_mid_json: good.trimEnd().slice(0, -3),
    empty_file: '',
    binary_garbage: Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    not_json: 'definitely not a ledger',
    json_but_array: '[1,2,3]',
    wrong_schema: mut((d) => (d.schema = 'sakk-ledger.v999')),
    schema_key_missing: mut((d) => delete d.schema),
    cap_string: mut((d) => (d.capUsd = '10')),
    cap_negative: mut((d) => (d.capUsd = -10)),
    cap_infinity: good.replace('"capUsd": 10', '"capUsd": 1e309'),
    cap_nan_null: mut((d) => (d.capUsd = null)),
    entries_object: good.replace('"entries": []', '"entries": {}'),
    entries_alien_status: mut((d) =>
      d.entries.push({ callId: 'ghost', status: 'TOTALLY_FINE', estimatedMaxUsd: 1 }),
    ),
    flags_missing: mut((d) => delete d.flags),
    flags_reco_string: mut((d) => (d.flags.reconciliationRequired = 'false')),
    proto_polluted: good.replace('{', '{"__proto__":{"reconciliationRequired":false},'),
  };
  for (const [name, body] of Object.entries(corpus)) {
    if (typeof body === 'string' && body === good)
      throw new Error(`harness bug: corpus/${name} failed to corrupt`);
    const p = join(dir(), 'l.json');
    writeFileSync(p, body);
    expectTyped(`corpus/${name} (read)`, () => readLedger({ ledgerPath: p }));
    expectTyped(`corpus/${name} (reserve)`, () =>
      reserve({ ledgerPath: p, callId: 'x', estimatedMaxUsd: 1 }),
    );
  }
}

// ---------- B. permission faults ----------
{
  // A read-only ledger FILE does not stop writes — temp+rename replaces
  // the directory entry, never opening the file for writing. That is the
  // atomic-write design working as intended; the real permission gate is
  // the DIRECTORY (next case). Assert the design, don't fight it.
  const p = freshLedger();
  chmodSync(p, 0o444);
  try {
    reserve({ ledgerPath: p, callId: 'ro', estimatedMaxUsd: 1 });
    passes += 1;
    console.log('✓ readonly-file → write proceeds via atomic rename (by design)');
  } catch (e) {
    fail(
      'readonly-file',
      `atomic rename should not need file write perms: ${e.code ?? e.constructor.name}`,
    );
  }
  chmodSync(p, 0o644);
}
{
  // Container matrix lesson: ROOT ignores permission bits entirely, so
  // this leg can only be staged as an unprivileged user. Skipping under
  // root is stated loudly, never silently.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot) {
    console.log('↷ readonly-dir skipped: running as root, permission bits are not enforceable');
  } else {
    const d = dir();
    const p = join(d, 'l.json');
    initLedger({ ledgerPath: p, capUsd: 10 });
    chmodSync(d, 0o555); // directory read-only: the LOCK cannot be created
    try {
      expectTyped('readonly-dir (reserve, lock uncreatable)', () =>
        reserve({ ledgerPath: p, callId: 'x', estimatedMaxUsd: 1 }),
      );
    } finally {
      chmodSync(d, 0o755);
    }
  }
}

// ---------- C. clock skew ----------
{
  const p = freshLedger();
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  doc.updatedAt = new Date(Date.now() + 3600_000).toISOString(); // 1h in the FUTURE
  writeFileSync(p, JSON.stringify(doc));
  // A future timestamp is not provably stale; what MUST hold is: no crash,
  // and the money semantics still apply afterwards.
  try {
    reserve({ ledgerPath: p, callId: 'future', estimatedMaxUsd: 1 });
    passes += 1;
    console.log('✓ clock-future (reserve proceeds or refuses typed — proceeded)');
  } catch (e) {
    if (e instanceof LedgerError) {
      passes += 1;
      console.log(`✓ clock-future → ${e.code}`);
    } else fail('clock-future', `untyped ${e.constructor.name}`);
  }
  const p2 = freshLedger();
  const doc2 = JSON.parse(readFileSync(p2, 'utf8'));
  doc2.updatedAt = new Date(Date.now() - 365 * 864e5).toISOString(); // 1y past
  writeFileSync(p2, JSON.stringify(doc2));
  expectTyped('clock-stale-one-year (reserve)', () =>
    reserve({ ledgerPath: p2, callId: 'old', estimatedMaxUsd: 1 }),
  );
}

// ---------- D. lock debris ----------
{
  const p = freshLedger();
  mkdirSync(`${p}.lock`);
  writeFileSync(join(`${p}.lock`, 'owner.json'), 'garbage{{{');
  expectTyped('lock-garbage-owner (reserve waits then refuses typed)', () =>
    reserve({ ledgerPath: p, callId: 'x', estimatedMaxUsd: 1 }),
  );
}
{
  const p = freshLedger();
  mkdirSync(`${p}.lock`);
  writeFileSync(
    join(`${p}.lock`, 'owner.json'),
    JSON.stringify({ pid: 999999, host: `${hostname()}-NOT-US`, at: new Date().toISOString() }),
  );
  expectTyped('lock-foreign-host (never breaks what it cannot judge)', () =>
    reserve({ ledgerPath: p, callId: 'x', estimatedMaxUsd: 1 }),
  );
}
{
  // dead-pid SAME-host lock must be broken automatically and the op SUCCEED
  const p = freshLedger();
  mkdirSync(`${p}.lock`);
  writeFileSync(
    join(`${p}.lock`, 'owner.json'),
    JSON.stringify({ pid: 999999999, host: hostname(), at: new Date().toISOString() }),
  );
  try {
    reserve({ ledgerPath: p, callId: 'x', estimatedMaxUsd: 1 });
    passes += 1;
    console.log('✓ lock-dead-pid-same-host → auto-broken, op proceeded');
  } catch (e) {
    fail('lock-dead-pid-same-host', `should auto-break, got ${e.code ?? e.constructor.name}`);
  }
}

console.log(
  failures === 0
    ? `fault-injection: ${passes} faults, every one answered with a typed refusal (or correct recovery) — PASS`
    : `fault-injection: ${failures} FAILURES / ${passes} passes — FAIL`,
);
process.exit(failures === 0 ? 0 : 1);
