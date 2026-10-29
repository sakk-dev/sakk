import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  verifyDrillFreshness,
  renderCertificate,
  parseSuiteSummary,
  CertError,
  EXPECTED_MUTANTS,
} from '../scripts/gate-certificate.mjs';

/** The certificate engine's pure core. The orchestration (running the real
 * gates) is exercised by `npm run certificate` itself; what MUST be unit-
 * locked is the refusal logic — a certificate that can be emitted over a
 * failure or stale evidence is the product lying. */

const REPORT = `== Sakk mutation drill 2026-10-15 ==
[MUT-A] MUTANT KILLED by 'x' (exit=1)
[MUT-A] file=eval/lib/scorer.mjs
[MUT-A] anchor: something
[MUT-A] sha256 before=${'a'.repeat(64)} after=${'b'.repeat(64)}
[MUT-E] MUTANT KILLED by 'y' (exit=1)
[MUT-E] file=src/policy.mjs
[MUT-E] anchor: other
[MUT-E] sha256 before=${'c'.repeat(64)} after=${'d'.repeat(64)}
`;

describe('F8 machine-enforced: drill evidence freshness', () => {
  test('matching hashes → fresh; a drifted file is named (testimony about other bytes refuses)', () => {
    const hashes = { 'eval/lib/scorer.mjs': 'a'.repeat(64), 'src/policy.mjs': 'c'.repeat(64) };
    const ok = verifyDrillFreshness({ reportText: REPORT, fileHashOf: (f) => hashes[f] });
    assert.equal(ok.fresh, true);
    assert.equal(ok.checked, 2);
    const drifted = verifyDrillFreshness({
      reportText: REPORT,
      fileHashOf: (f) => (f === 'src/policy.mjs' ? 'e'.repeat(64) : hashes[f]),
    });
    assert.equal(drifted.fresh, false);
    assert.deepEqual(
      drifted.stale.map((s) => s.mut),
      ['MUT-E'],
    );
  });
  test('F3: completeness is freshness — kills without verified hash blocks refuse', () => {
    const partial = REPORT.replace(/\[MUT-E\] file=[\s\S]*?after=.*\n/, '');
    const hashes = { 'eval/lib/scorer.mjs': 'a'.repeat(64) };
    const r = verifyDrillFreshness({ reportText: partial, fileHashOf: (f) => hashes[f] });
    assert.equal(r.kills, 2);
    assert.equal(r.checked, 1);
    assert.equal(r.fresh, false, '2 kills with 1 verified block must NOT be fresh');
  });
  test('a report that testifies about NOTHING is not fresh (empty set is an error)', () => {
    const r = verifyDrillFreshness({ reportText: 'no hashes here', fileHashOf: () => 'x' });
    assert.equal(r.fresh, false);
    assert.equal(r.checked, 0);
  });
});

describe('suite-summary parsing survives both node reporters (the 0/0 incident)', () => {
  test('TAP # prefix and spec \u2139 prefix both parse; last summary wins', () => {
    assert.deepEqual(parseSuiteSummary('# tests 103\n# pass 103\n# fail 0\n'), {
      tests: 103,
      pass: 103,
      fail: 0,
    });
    assert.deepEqual(parseSuiteSummary('\u2139 tests 59\n\u2139 pass 59\n\u2139 fail 0\n'), {
      tests: 59,
      pass: 59,
      fail: 0,
    });
  });
  test('an unrecognizable summary parses to nulls — the orchestrator must refuse, never print 0/0', () => {
    assert.deepEqual(parseSuiteSummary('something else entirely'), {
      tests: null,
      pass: null,
      fail: null,
    });
  });
});

describe('render refuses any non-green dossier', () => {
  const dossier = () => ({
    issuedAt: '2026-10-15T00:00:00Z',
    commit: 'deadbeef',
    version: '0.1.0',
    green: { unit: true, drill: true },
    suites: { 'unit + CLI': '99/99 pass, 0 fail' },
    drill: { kills: 26, checked: 26, stale: [], fresh: true },
    fuzz: { ledger: 'all invariants held (seed=1)' },
    reproHash: 'f'.repeat(64),
    certified: { 'src/ledger.mjs': 'a'.repeat(64) },
  });
  test('all-green renders with commit, kills and fingerprint', () => {
    const md = renderCertificate(dossier());
    assert.match(md, /commit `deadbeef`/);
    assert.match(md, /26\/26 mutants killed/);
    assert.match(md, new RegExp('f'.repeat(64)));
  });
  test('ANY false gate throws CERT_REFUSED naming the gate', () => {
    const d = dossier();
    d.green.drill = false;
    try {
      renderCertificate(d);
      assert.fail('rendered over a red gate');
    } catch (e) {
      assert.ok(e instanceof CertError);
      assert.equal(e.code, 'CERT_REFUSED');
      assert.equal(e.details.gate, 'drill');
    }
  });
});

describe('witness ↔ drill: EXPECTED_MUTANTS cannot silently drift (F-167)', () => {
  // The witness count was hardcoded at 26 while the drill grew to 38, and the
  // freshness regex (MUT-[A-Z]) was blind to the 12 two-letter mutants — a
  // drift that only surfaced in the rarely-run multi-minute certificate. These
  // tests link the witness to the drill's real count at `npm test` time.
  const drillPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../scripts/mutation-drill.sh',
  );
  const ids = [...readFileSync(drillPath, 'utf8').matchAll(/run_drill (MUT-[A-Za-z0-9]+)/g)].map(
    (m) => m[1],
  );
  test('every mutant the drill defines is counted exactly once', () => {
    assert.ok(ids.length > 0, 'no run_drill mutants found — drill path or format changed');
    assert.equal(new Set(ids).size, ids.length, 'a MUT id appears on more than one run_drill line');
  });
  test('EXPECTED_MUTANTS equals the number the drill actually defines', () => {
    assert.equal(
      EXPECTED_MUTANTS,
      ids.length,
      `witness expects ${EXPECTED_MUTANTS} mutants; the drill defines ${ids.length} — bump EXPECTED_MUTANTS or restore the drill`,
    );
  });
  test('the freshness parser can see every mutant id the drill emits (the MUT-AA regex gap)', () => {
    // Drive the parser with the drill's real id set. A single-letter regex
    // silently drops MUT-AA..MUT-AL, so `checked` would fall below the count.
    const h = '0'.repeat(64);
    const report = ids
      .map(
        (id) =>
          `[${id}] MUTANT KILLED by 't' (exit=1)\n[${id}] file=src/${id}.mjs\n[${id}] sha256 before=${h} after=${h}\n`,
      )
      .join('');
    const r = verifyDrillFreshness({ reportText: report, fileHashOf: () => h });
    assert.equal(
      r.checked,
      ids.length,
      'parser excluded some mutant ids — freshness regex too narrow',
    );
    assert.equal(r.kills, ids.length);
    assert.equal(r.fresh, true);
  });
});
