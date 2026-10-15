import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyDrillFreshness,
  renderCertificate,
  CertError,
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
  test('a report that testifies about NOTHING is not fresh (empty set is an error)', () => {
    const r = verifyDrillFreshness({ reportText: 'no hashes here', fileHashOf: () => 'x' });
    assert.equal(r.fresh, false);
    assert.equal(r.checked, 0);
  });
});

describe('render refuses any non-green dossier', () => {
  const dossier = () => ({
    issuedAt: '2026-10-15T00:00:00Z',
    commit: 'deadbeef',
    version: '0.1.0',
    green: { unit: true, drill: true },
    suites: { 'unit + CLI': '99/99 pass, 0 fail' },
    drill: { kills: 6, checked: 3, stale: [], fresh: true },
    fuzz: { ledger: 'all invariants held (seed=1)' },
    reproHash: 'f'.repeat(64),
    certified: { 'src/ledger.mjs': 'a'.repeat(64) },
  });
  test('all-green renders with commit, kills and fingerprint', () => {
    const md = renderCertificate(dossier());
    assert.match(md, /commit `deadbeef`/);
    assert.match(md, /6\/6 mutants killed/);
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
