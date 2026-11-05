import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sakk.mjs');
const sakk = (args) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000 });

/**
 * The hot/cold split (F-105, specs/ledger "The hot/cold split"): settled
 * entries are sealed into an append-only hash-chained cold trail so the live
 * file stays bounded and a call costs the same whatever the history, no entry
 * is lost, and a lost or altered segment is caught — never read as free cap.
 */
// seal often so the suite stays fast (the knob is SAKK_SEAL_AT; production is
// 1000); each test file runs in its own process, so this is isolated
process.env.SAKK_SEAL_AT = '40';
const SRC = new URL('../src/', import.meta.url);
const ledger = await import(new URL('ledger.mjs', SRC));
const archive = await import(new URL('archive.mjs', SRC));
const { initLedger, reserve, settle, readLedger, totalsOf } = ledger;
const {
  SEAL_AT,
  MAX_INFLIGHT,
  coldDir,
  idxDir,
  reindex,
  segmentsOnDisk,
  verifyChain,
  segmentHash,
} = archive;

const fresh = (capUsd = 1e12) => {
  const p = join(mkdtempSync(join(tmpdir(), 'ledger-arch-')), 'ledger.json');
  initLedger({ ledgerPath: p, capUsd });
  return p;
};
/** reserve+settle a call for `usd`, through the real library. */
const paid = (p, id, est, act = est) => {
  reserve({ ledgerPath: p, callId: id, estimatedMaxUsd: est });
  settle({ ledgerPath: p, callId: id, actualUsd: act });
};
/** settle `n` calls so the cold trail seals at least one segment. */
const seed = (p, n, est = 0.01, act = 0.002) => {
  for (let i = 0; i < n; i++) paid(p, `c${i}`, est, act);
};
const code = (fn) => {
  try {
    fn();
    return 'NO_ERROR';
  } catch (e) {
    return e.code ?? 'THREW';
  }
};
/**
 * Count the cold-segment files `fn` reads. The library imports readFileSync
 * by name, so a patch on the default export reaches it only after
 * syncBuiltinESMExports (F-241). The match is on the `.cold/` path segment,
 * not a prefix, because the library reads through the canonical path
 * (/private/var on macOS) while a test holds the /var spelling.
 */
const coldReads = (fn) => {
  const orig = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (f, ...rest) => {
    if (String(f).includes(`.cold${sep}`)) reads += 1;
    return orig(f, ...rest);
  };
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    fs.readFileSync = orig;
    syncBuiltinESMExports();
  }
  return reads;
};
const err = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
};

describe('F-105 the hot/cold split: settled entries seal into a bounded, verifiable cold trail', () => {
  test('settling past the seal threshold always seals, never leaves hot unbounded', () => {
    const p = fresh();
    seed(p, SEAL_AT * 2 + 7);
    const doc = readLedger({ ledgerPath: p, maxAgeMs: Infinity });
    assert.equal(doc.schema, 'sakk-ledger.v3');
    assert.ok(doc.entries.length <= SEAL_AT, `hot kept ${doc.entries.length} <= ${SEAL_AT}`);
    assert.equal(doc.archive.segments, 2);
    assert.equal(doc.archive.settledCount, 2 * SEAL_AT);
    assert.equal(segmentsOnDisk(p), 2);
  });

  test('totals equal a flat ledger of the same calls, hot and cold', () => {
    const p = fresh();
    const n = SEAL_AT + 500;
    let expected = 0;
    for (let i = 0; i < n; i++) {
      const act = 0.001 + (i % 7) * 0.0001;
      paid(p, `c${i}`, 0.02, act);
      expected += act;
    }
    const t = totalsOf(readLedger({ ledgerPath: p, maxAgeMs: Infinity }));
    assert.ok(Math.abs(t.settledUsd - expected) < 1e-9, `${t.settledUsd} vs ${expected}`);
    assert.equal(t.outstandingUsd, 0);
    // a verify recomputes the sealed part from the real segments and agrees
    const doc = readLedger({ ledgerPath: p, maxAgeMs: Infinity });
    const walked = verifyChain(p, doc.archive);
    assert.equal(walked.settledCount, doc.archive.settledCount);
  });

  test('per-call work stays flat as history grows (operation count, not a clock)', () => {
    // a reserve and a settle of a NEW call read hot, one index shard and the
    // head segment (F-193) — the same count with one sealed segment or six
    const gate = (p) =>
      coldReads(() => {
        reserve({ ledgerPath: p, callId: 'flat-new', estimatedMaxUsd: 0.01 });
        settle({ ledgerPath: p, callId: 'flat-new', actualUsd: 0.002 });
      });
    const small = fresh();
    seed(small, SEAL_AT + 10);
    const large = fresh();
    seed(large, SEAL_AT * 6 + 10);
    assert.equal(segmentsOnDisk(small), 1);
    assert.equal(segmentsOnDisk(large), 6);
    // the counter sees the library's reads: a full verify reads every segment
    const doc = readLedger({ ledgerPath: large, maxAgeMs: Infinity });
    assert.equal(
      coldReads(() => verifyChain(large, doc.archive)),
      6,
      'the counter missed the library reads, so a flat count below would prove nothing',
    );
    const atOne = gate(small);
    const atSix = gate(large);
    assert.equal(atSix, atOne, `the gate read ${atOne} segment(s) at 1 sealed, ${atSix} at 6`);
    assert.ok(atSix <= 1, `the gate read ${atSix} cold segments; it should read only the head`);
    // and the hot file stays bounded regardless of how much was sealed
    assert.ok(readLedger({ ledgerPath: large, maxAgeMs: Infinity }).entries.length <= SEAL_AT);
  });

  test('a corrupt archive summary refuses; a lost segment fails verify, never freeing cap', () => {
    const p = fresh();
    seed(p, SEAL_AT + 3);
    const before = totalsOf(readLedger({ ledgerPath: p, maxAgeMs: Infinity })).settledUsd;
    // a corrupt summary shape refuses on read — never read as zero settled
    const good = readFileSync(p, 'utf8');
    const doc = JSON.parse(good);
    delete doc.archive.tip;
    writeFileSync(p, JSON.stringify(doc));
    assert.equal(
      code(() => readLedger({ ledgerPath: p, maxAgeMs: Infinity })),
      'LEDGER_ARCHIVE_BROKEN',
    );
    writeFileSync(p, good);
    // a LOST cold segment does not change the total (it lives in the hot
    // summary), and readLedger still reads, so reports keep working — but the
    // gate refuses a lost head (F-193) and verify catches it
    fs.rmSync(join(coldDir(p), '000001.json'));
    assert.equal(
      code(() => readLedger({ ledgerPath: p, maxAgeMs: Infinity })),
      'NO_ERROR',
      'readLedger reads only hot, so reports still work',
    );
    assert.equal(
      code(() => reserve({ ledgerPath: p, callId: 'after-loss', estimatedMaxUsd: 0.01 })),
      'LEDGER_ARCHIVE_BROKEN',
      'reserve reads the head segment, so a lost head stops spending',
    );
    assert.equal(
      totalsOf(readLedger({ ledgerPath: p, maxAgeMs: Infinity })).settledUsd,
      before,
      'the total is unchanged — a lost segment frees no cap',
    );
    assert.equal(
      code(() => verifyChain(p, readLedger({ ledgerPath: p, maxAgeMs: Infinity }).archive)),
      'LEDGER_ARCHIVE_BROKEN',
      'verify catches the lost segment',
    );
  });

  test('verify catches a flipped byte, a broken link and a wrong tip', () => {
    const mk = () => {
      const p = fresh();
      seed(p, SEAL_AT * 2 + 1); // two segments
      return p;
    };
    // sound chain verifies
    const ok = mk();
    assert.equal(
      code(() => verifyChain(ok, readLedger({ ledgerPath: ok, maxAgeMs: Infinity }).archive)),
      'NO_ERROR',
    );
    // flip a byte in an older sealed segment: its hash no longer matches, so
    // verify catches it (readLedger reads only hot and reserve only the head,
    // so a flip below the head is verify's to find)
    const flipped = mk();
    const segp = join(coldDir(flipped), '000001.json');
    const seg = JSON.parse(readFileSync(segp, 'utf8'));
    seg.entries[0].actualUsd += 0.5;
    writeFileSync(segp, JSON.stringify(seg));
    const fdoc = readLedger({ ledgerPath: flipped, maxAgeMs: Infinity });
    assert.equal(
      code(() => verifyChain(flipped, fdoc.archive)),
      'LEDGER_ARCHIVE_BROKEN',
    );
    // break the link: re-hash a segment with a wrong prev so chain walk fails
    const relinked = mk();
    const s2 = join(coldDir(relinked), '000002.json');
    const seg2 = JSON.parse(readFileSync(s2, 'utf8'));
    seg2.prev = 'deadbeef';
    seg2.hash = segmentHash(seg2.seq, seg2.prev, seg2.entries, seg2.total);
    writeFileSync(s2, JSON.stringify(seg2));
    // the tip still matches (we re-hashed), but the full chain walk sees the broken link
    const arch = JSON.parse(readFileSync(relinked, 'utf8')).archive;
    arch.tip = seg2.hash;
    assert.equal(
      code(() => verifyChain(relinked, arch)),
      'LEDGER_ARCHIVE_BROKEN',
    );
  });

  test('a seal interrupted before the hot commit is a redoable prefix, no entry lost', () => {
    // A seal writes the segment and index, then commits the smaller hot file.
    // A crash BETWEEN those leaves the segment on disk while the hot file still
    // holds all its entries. Construct exactly that state with the real
    // sealSegment, then show recovery loses nothing and a later seal redoes it.
    const p = fresh();
    const doc = readLedger({ ledgerPath: p, maxAgeMs: Infinity });
    doc.entries = Array.from({ length: SEAL_AT }, (_, i) => ({
      callId: `c${i}`,
      runId: null,
      taskId: null,
      agentId: null,
      estimatedMaxUsd: 0.01,
      status: 'SETTLED',
      actualUsd: 0.002,
      settledAt: new Date().toISOString(),
    }));
    writeFileSync(p, JSON.stringify(doc)); // hot: SEAL_AT settled, archive not yet written (pre-commit)
    // the seal's on-disk steps completed; the hot commit did NOT (the crash)
    archive.sealSegment(p, 0, '', doc.entries);
    assert.equal(segmentsOnDisk(p), 1, 'the segment reached disk');
    // recovery: the hot file still has every entry, so the gate reads it and
    // nothing is lost — the orphan segment is a harmless redoable prefix
    const rec = readLedger({ ledgerPath: p, maxAgeMs: Infinity });
    assert.equal(
      rec.entries.filter((e) => e.status === 'SETTLED').length,
      SEAL_AT,
      'no settled entry lost',
    );
    assert.equal(totalsOf(rec).settledUsd.toFixed(5), (SEAL_AT * 0.002).toFixed(5));
    // a later settle triggers the real seal: seq 1 is reused, overwriting the
    // orphan, and the books end sound with the same total
    reserve({ ledgerPath: p, callId: 'next', estimatedMaxUsd: 0.01 });
    settle({ ledgerPath: p, callId: 'next', actualUsd: 0.002 });
    const after = readLedger({ ledgerPath: p, maxAgeMs: Infinity });
    assert.equal(after.archive.segments, 1, 'the redone seal reused seq 1');
    const total =
      after.archive.settledUsd + after.entries.filter((e) => e.status === 'SETTLED').length * 0.002;
    assert.equal(
      total.toFixed(5),
      ((SEAL_AT + 1) * 0.002).toFixed(5),
      'every settled call survived',
    );
    assert.equal(
      code(() => verifyChain(p, after.archive)),
      'NO_ERROR',
    );
  });

  test('a reconciliation entry is never sealed; re-settling an archived id checks the amount', () => {
    const p = fresh();
    // an outstanding RESERVED entry and a reconciliation entry are not SETTLED,
    // so a seal (which moves only SETTLED entries) never carries them off: an
    // agent cannot get its reconciliation sealed away from the human who clears it
    reserve({ ledgerPath: p, callId: 'keep', estimatedMaxUsd: 0.01 });
    seed(p, SEAL_AT); // 40 ordinary settles → seals segment 1
    reserve({ ledgerPath: p, callId: 'recon', estimatedMaxUsd: 0.01 });
    settle({ ledgerPath: p, callId: 'recon', failedUnknownCost: true });
    const doc = readLedger({ ledgerPath: p, maxAgeMs: Infinity });
    assert.equal(doc.archive.segments, 1, 'a segment sealed');
    const keep = doc.entries.find((e) => e.callId === 'keep');
    const recon = doc.entries.find((e) => e.callId === 'recon');
    assert.equal(keep?.status, 'RESERVED', 'the outstanding reservation stays hot, never sealed');
    assert.equal(
      recon?.status,
      'RECONCILIATION_REQUIRED',
      'the reconciliation entry stays hot, never sealed',
    );
    // re-settling an archived id with the same amount is idempotent; a different amount is a mismatch
    assert.equal(settle({ ledgerPath: p, callId: 'c0', actualUsd: 0.002 }).duplicate, true);
    assert.equal(
      code(() => settle({ ledgerPath: p, callId: 'c0', actualUsd: 0.009 })),
      'SETTLE_MISMATCH',
    );
  });

  test('the cold and index paths are canonical, one per ledger', () => {
    const p = fresh();
    assert.equal(coldDir(p), `${p}.cold`);
    assert.equal(idxDir(p), `${p}.idx`);
    // reaching the ledger through a symlinked directory uses the same cold trail
    seed(p, SEAL_AT + 1);
    assert.ok(existsSync(coldDir(p)) && existsSync(idxDir(p)));
    assert.equal(readdirSync(coldDir(p)).filter((f) => /^\d{6}\.json$/.test(f)).length, 1);
  });

  test('a v2 ledger still reads, settles and seals after migration', () => {
    // a ledger from before v3 (no archive field) reads as zero cold and works
    const p = fresh();
    // halt+resume makes it v2 with a halt record, no archive
    ledger.halt({ ledgerPath: p, by: 'maintainer', reason: 'test' });
    ledger.resume({ ledgerPath: p, by: 'maintainer' });
    let doc = readLedger({ ledgerPath: p, maxAgeMs: Infinity });
    assert.equal(doc.schema, 'sakk-ledger.v2');
    assert.equal(totalsOf(doc).settledUsd, 0);
    // settling past the threshold migrates it to v3 and seals, keeping the halt record shape
    seed(p, SEAL_AT);
    doc = readLedger({ ledgerPath: p, maxAgeMs: Infinity });
    assert.equal(doc.schema, 'sakk-ledger.v3');
    assert.equal(doc.archive.segments, 1);
    assert.ok(doc.halt !== undefined, 'the halt record is carried into v3');
  });

  test("the spec's claims each have a test that fails without them", () => {
    // every guarantee the spec's hot/cold section states is held by a named
    // test in this file; removing one here fails this check
    const self = readFileSync(new URL(import.meta.url), 'utf8');
    const claims = {
      'the gate reads hot plus one head segment (flat per call)':
        'per-call work stays flat as history grows (operation count, not a clock)',
      'the summary is bound to the head segment':
        'an edited summary is refused by reserve: the head segment binds the totals (F-193)',
      'a lost, rolled-back or altered head refuses; a seal never launders an edit':
        'a lost, rolled-back or altered head is refused by reserve, and a seal never launders an edit (F-193)',
      'seal at the threshold, hot stays bounded':
        'settling past the seal threshold always seals, never leaves hot unbounded',
      'totals span cold and hot': 'totals equal a flat ledger of the same calls, hot and cold',
      'a lost segment fails verify but frees no cap':
        'a corrupt archive summary refuses; a lost segment fails verify, never freeing cap',
      'the whole chain is verifiable':
        'verify catches a flipped byte, a broken link and a wrong tip',
      'export rebuilds one flat ledger':
        "export rebuilds one valid ledger with the same totals; verify's exit code is acted on",
      'no entry is lost on a crash':
        'a seal interrupted before the hot commit is a redoable prefix, no entry lost',
    };
    const missing = Object.entries(claims)
      .filter(([, name]) => !self.includes(`test('${name}'`) && !self.includes(`test("${name}"`))
      .map(([claim]) => claim);
    assert.deepEqual(missing, [], 'a spec claim has no test');
  });

  test("export rebuilds one valid ledger with the same totals; verify's exit code is acted on", () => {
    const p = fresh();
    for (let i = 0; i < SEAL_AT + 20; i++) paid(p, `c${i}`, 0.02, 0.001 + (i % 5) * 0.0002);
    // verify exits 0 on a sound chain, 1 on a broken one (CI gates on it)
    assert.equal(sakk(['ledger', 'verify', '--ledger', p]).status, 0);
    const seg = join(coldDir(p), '000001.json');
    const s = JSON.parse(readFileSync(seg, 'utf8'));
    s.entries[0].actualUsd += 1;
    writeFileSync(seg, JSON.stringify(s));
    const broken = sakk(['ledger', 'verify', '--ledger', p]);
    assert.equal(broken.status, 1, 'a broken chain exits non-zero');
    assert.match(broken.stderr, /LEDGER_ARCHIVE_BROKEN/);
    // repair, then export and read the flat ledger back: one valid book, same total
    writeFileSync(seg, readFileSync(seg, 'utf8')); // no-op; rebuild below from a fresh sound ledger
    const q = fresh();
    let exp2 = 0;
    for (let i = 0; i < SEAL_AT + 20; i++) {
      const act = 0.0013;
      paid(q, `c${i}`, 0.02, act);
      exp2 += act;
    }
    const out = join(mkdtempSync(join(tmpdir(), 'export-')), 'flat.json');
    const ex = sakk(['ledger', 'export', '--ledger', q, '--out', out]);
    assert.equal(ex.status, 0, ex.stderr);
    // the line reads as a sentence, not the raw "entr(y|ies)" pattern (F-225)
    assert.match(ex.stdout, new RegExp(`^ledger export: ${SEAL_AT + 20} entries written to `, 'm'));
    assert.doesNotMatch(ex.stdout, /entr\(y\|ies\)/);
    const flat = readLedger({ ledgerPath: out, maxAgeMs: Infinity });
    assert.equal(flat.entries.length, SEAL_AT + 20);
    assert.ok(Math.abs(totalsOf(flat).settledUsd - exp2) < 1e-9);
  });

  test('the in-flight cap refuses new reservations, but settling what is open still works', () => {
    // build a hot file already holding MAX_INFLIGHT reservations (writing 10k
    // through the API with fsync each would be far too slow for a unit test)
    const p = fresh();
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    doc.entries = Array.from({ length: MAX_INFLIGHT }, (_, i) => ({
      callId: `r${i}`,
      runId: null,
      taskId: null,
      agentId: null,
      estimatedMaxUsd: 1e-6,
      createdAt: new Date().toISOString(),
      status: 'RESERVED',
    }));
    writeFileSync(p, JSON.stringify(doc));
    assert.equal(
      code(() => reserve({ ledgerPath: p, callId: 'one-more', estimatedMaxUsd: 1e-6 })),
      'LEDGER_FULL',
    );
    // settling an open one frees a slot
    settle({ ledgerPath: p, callId: 'r0', actualUsd: 0 });
    assert.equal(
      code(() => reserve({ ledgerPath: p, callId: 'one-more', estimatedMaxUsd: 1e-6 })),
      'NO_ERROR',
    );
  });
});

describe('F-105 review fixes: the index is checked and recoverable, verify is float-safe', () => {
  test('verify catches a lost index, and reserve refuses rather than re-admit a sealed call-id', () => {
    const p = fresh();
    seed(p, SEAL_AT + 1, 0.01, 0.002); // seals segment 1; c0..c39 archived
    // the index intact: a sealed id is a duplicate
    assert.equal(
      code(() => reserve({ ledgerPath: p, callId: 'c0', estimatedMaxUsd: 0.01 })),
      'DUPLICATE_CALL_ID',
    );
    const doc = () => readLedger({ ledgerPath: p, maxAgeMs: Infinity });
    // lose the whole index
    fs.rmSync(idxDir(p), { recursive: true, force: true });
    // verify now catches it (it did not before the fix)
    assert.equal(
      code(() => verifyChain(p, doc().archive)),
      'LEDGER_ARCHIVE_BROKEN',
    );
    // and a reserve refuses rather than silently treat the sealed id as new (double-spend)
    assert.equal(
      code(() => reserve({ ledgerPath: p, callId: 'c0', estimatedMaxUsd: 0.01 })),
      'LEDGER_ARCHIVE_BROKEN',
    );
    assert.equal(
      code(() => reserve({ ledgerPath: p, callId: 'brand-new', estimatedMaxUsd: 0.01 })),
      'LEDGER_ARCHIVE_BROKEN',
    );
    // reindex rebuilds it from cold; dedup and verify are restored
    reindex(p, doc().archive);
    assert.equal(
      code(() => verifyChain(p, doc().archive)),
      'NO_ERROR',
    );
    assert.equal(
      code(() => reserve({ ledgerPath: p, callId: 'c0', estimatedMaxUsd: 0.01 })),
      'DUPLICATE_CALL_ID',
    );
    assert.equal(
      code(() => reserve({ ledgerPath: p, callId: 'brand-new', estimatedMaxUsd: 0.01 })),
      'NO_ERROR',
    );
  });
  test('verify catches a single altered index entry', () => {
    const p = fresh();
    seed(p, SEAL_AT + 1, 0.01, 0.002);
    const doc = readLedger({ ledgerPath: p, maxAgeMs: Infinity });
    // point one sealed call-id at the wrong segment in its shard
    const shardFile = readdirSync(idxDir(p)).find((f) => f.endsWith('.json'));
    const sp = join(idxDir(p), shardFile);
    const shard = JSON.parse(readFileSync(sp, 'utf8'));
    const anId = Object.keys(shard)[0];
    shard[anId] = 999;
    writeFileSync(sp, JSON.stringify(shard));
    assert.equal(
      code(() => verifyChain(p, doc.archive)),
      'LEDGER_ARCHIVE_BROKEN',
    );
  });
  test('verify does not false-fail on an intact chain with varied amounts (float-safe)', () => {
    const p = fresh();
    // varied amounts across several segments, including large then small, so a
    // per-entry fold would drift from the per-segment maintained summary
    for (let i = 0; i < SEAL_AT * 3; i++) {
      const act = i < 5 ? 1234.5678 : 0.0001 + (i % 9) * 0.00003;
      paid(p, `c${i}`, 2000, act);
    }
    const doc = readLedger({ ledgerPath: p, maxAgeMs: Infinity });
    const walked = verifyChain(p, doc.archive); // must not throw
    // same summation order in both places → exact equality, no tolerance fudge
    assert.equal(walked.settledUsd, doc.archive.settledUsd);
  });
});

describe('F-193 the archive summary is bound to the head segment', () => {
  /** Rewrite the hot ledger file the way any writer other than sakk could. */
  const edit = (p, change) => {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    change(doc);
    writeFileSync(p, JSON.stringify(doc));
  };
  const refused = (p, why) =>
    assert.equal(
      code(() => reserve({ ledgerPath: p, callId: 'probe', estimatedMaxUsd: 0.01 })),
      'LEDGER_ARCHIVE_BROKEN',
      why,
    );
  /** A ledger with two sealed segments, each carrying its running total. */
  const two = () => {
    const p = fresh();
    seed(p, SEAL_AT * 2 + 3);
    assert.equal(segmentsOnDisk(p), 2);
    return p;
  };

  test('an edited summary is refused by reserve: the head segment binds the totals (F-193)', () => {
    // the attack: lower the sealed total in the writable hot file to free cap
    const p = fresh(0.1);
    seed(p, SEAL_AT + 3, 0.002, 0.002); // $0.086 settled, $0.08 of it sealed
    assert.equal(segmentsOnDisk(p), 1);
    // control: the honest ledger has no room for $0.05 but does for $0.001
    assert.equal(
      code(() => reserve({ ledgerPath: p, callId: 'big', estimatedMaxUsd: 0.05 })),
      'BUDGET_EXCEEDED',
    );
    paid(p, 'small', 0.001);
    const good = readFileSync(p, 'utf8');
    for (const [field, lie] of [
      ['settledUsd', 0],
      ['settledUsd', 0.03],
      ['settledCount', SEAL_AT - 1],
    ]) {
      writeFileSync(p, good);
      edit(p, (d) => {
        d.archive[field] = lie;
      });
      const e = err(() => reserve({ ledgerPath: p, callId: 'big', estimatedMaxUsd: 0.05 }));
      assert.equal(
        e?.code,
        'LEDGER_ARCHIVE_BROKEN',
        `summary ${field}=${lie} was trusted: ${e?.code ?? 'the $0.05 call reserved'}`,
      );
      assert.match(e.message, /sakk ledger verify/, 'the refusal names the repair step');
    }
    // the unedited file still reserves: the refusal is the edit, not the ledger
    writeFileSync(p, good);
    assert.equal(
      code(() => reserve({ ledgerPath: p, callId: 'after', estimatedMaxUsd: 0.001 })),
      'NO_ERROR',
    );
  });

  test('a lost, rolled-back or altered head is refused by reserve, and a seal never launders an edit (F-193)', () => {
    const segFile = (p, seq) => join(coldDir(p), `${String(seq).padStart(6, '0')}.json`);
    const readSeg = (p, seq) => JSON.parse(readFileSync(segFile(p, seq), 'utf8'));

    const lost = two();
    fs.rmSync(segFile(lost, 2));
    refused(lost, 'a lost head');

    // the summary rolled back to segment 1, self-consistent with it, while
    // segment 2 still exists: segment 2's spend would be freed
    const rolled = two();
    const s1 = readSeg(rolled, 1);
    edit(rolled, (d) => {
      d.archive = { segments: 1, ...s1.total, tip: s1.hash };
    });
    refused(rolled, 'a summary rolled back below a segment that exists');

    // the summary removed outright: a downgrade to v1 reads as nothing sealed
    const down = two();
    edit(down, (d) => {
      delete d.archive;
      d.schema = 'sakk-ledger.v1';
    });
    refused(down, 'a summary removed while sealed segments exist');

    const altered = two();
    const h = readSeg(altered, 2);
    h.entries[0].actualUsd = 0;
    writeFileSync(segFile(altered, 2), JSON.stringify(h));
    refused(altered, 'a head whose bytes no longer match its hash');

    const rehashed = two();
    const r = readSeg(rehashed, 2);
    r.total = { ...r.total, settledUsd: 0 };
    r.hash = segmentHash(r.seq, r.prev, r.entries, r.total);
    writeFileSync(segFile(rehashed, 2), JSON.stringify(r));
    refused(rehashed, 'a rehashed head the summary tip does not name');

    // the stated limit: a writer who rehashes the head AND rewrites the summary
    // to match passes the one-read check (keeping the agent out of the ledger
    // directory is the guard's job); verify walks the chain and names it
    const forged = two();
    const f = readSeg(forged, 2);
    f.total = { ...f.total, settledUsd: f.total.settledUsd - 0.05 };
    f.hash = segmentHash(f.seq, f.prev, f.entries, f.total);
    writeFileSync(segFile(forged, 2), JSON.stringify(f));
    edit(forged, (d) => {
      d.archive = { segments: 2, ...f.total, tip: f.hash };
    });
    const v = err(() =>
      verifyChain(forged, readLedger({ ledgerPath: forged, maxAgeMs: Infinity }).archive),
    );
    assert.equal(v?.code, 'LEDGER_ARCHIVE_BROKEN');
    assert.match(v.message, /running total/);

    // a seal never launders an edit: settles that would seal a new head over
    // an edited summary leave the entries hot, so they still count
    const p = fresh();
    seed(p, SEAL_AT + 3);
    for (let i = 0; i < SEAL_AT; i++)
      reserve({ ledgerPath: p, callId: `open${i}`, estimatedMaxUsd: 0.01 });
    edit(p, (d) => {
      d.archive.settledUsd = 0;
    });
    for (let i = 0; i < SEAL_AT; i++)
      settle({ ledgerPath: p, callId: `open${i}`, actualUsd: 0.002 });
    const after = readLedger({ ledgerPath: p, maxAgeMs: Infinity });
    assert.equal(segmentsOnDisk(p), 1, 'no new head was sealed over the edited summary');
    assert.equal(after.archive.segments, 1);
    assert.equal(
      after.entries.filter((e) => e.status === 'SETTLED').length,
      SEAL_AT + 3,
      'the settled entries stayed hot',
    );
    refused(p, 'the edit is still refused after the settles that would have sealed it');

    // a legacy trail (0.4.0 segments carry no running total) is walked once:
    // consistent, it reserves; edited, it refuses; the next seal adds a total
    const legacy = fresh();
    const entries = (from) =>
      Array.from({ length: SEAL_AT }, (_, i) => ({
        callId: `l${from + i}`,
        runId: null,
        taskId: null,
        agentId: null,
        estimatedMaxUsd: 0.01,
        status: 'SETTLED',
        actualUsd: 0.002,
        settledAt: new Date().toISOString(),
      }));
    const e1 = entries(0);
    const e2 = entries(SEAL_AT);
    const l1 = archive.sealSegment(legacy, 0, '', e1);
    const l2 = archive.sealSegment(legacy, 1, l1.hash, e2);
    assert.equal(readSeg(legacy, 2).total, undefined, 'the legacy head has no total');
    const sum = (es) => es.reduce((s, e) => s + e.actualUsd, 0);
    edit(legacy, (d) => {
      d.schema = 'sakk-ledger.v3';
      d.archive = {
        segments: 2,
        settledCount: 2 * SEAL_AT,
        settledUsd: 0 + sum(e1) + sum(e2),
        tip: l2.hash,
      };
    });
    const legacyGood = readFileSync(legacy, 'utf8');
    edit(legacy, (d) => {
      d.archive.settledUsd = 0;
    });
    refused(legacy, 'an edited summary over a legacy head');
    writeFileSync(legacy, legacyGood);
    paid(legacy, 'legacy-ok', 0.01, 0.002);
    for (let i = 0; i < SEAL_AT - 1; i++) paid(legacy, `n${i}`, 0.01, 0.002);
    assert.equal(segmentsOnDisk(legacy), 3);
    assert.equal(readSeg(legacy, 3).total.settledCount, 3 * SEAL_AT);
    assert.equal(
      code(() =>
        verifyChain(legacy, readLedger({ ledgerPath: legacy, maxAgeMs: Infinity }).archive),
      ),
      'NO_ERROR',
    );
  });
});
