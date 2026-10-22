// F-105 as the attacker meets it, on the live API only: the ledger file must
// not grow without bound as settled history accumulates. This file imports
// ONLY long-standing ledger exports (no src/archive.mjs), so on the code
// before the hot/cold split it loads and fails by its own assertion (the hot
// file keeps every entry); on the fixed code the oldest settled entries are
// sealed away and the live file stays bounded (findings-proof, R7).
//
// SAKK_SEAL_AT is set before the import so the seal threshold is small and the
// test is fast; on the old code the knob is simply ignored and the entries pile
// up, which is exactly the failure this proves is gone.
process.env.SAKK_SEAL_AT = '40';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ledger = await import(pathToFileURL(join(process.cwd(), 'src', 'ledger.mjs')));
const { initLedger, reserve, settle, readLedger } = ledger;
const CAP = Number(process.env.SAKK_SEAL_AT); // the bound the live file must stay within

test('F-105: the live ledger stays bounded as settled history grows', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'ledger-growth-')), 'ledger.json');
  initLedger({ ledgerPath: p, capUsd: 1e9 });
  // settle well past the seal threshold
  for (let i = 0; i < CAP * 3 + 5; i++) {
    const id = `c${i}`;
    reserve({ ledgerPath: p, callId: id, estimatedMaxUsd: 0.01 });
    settle({ ledgerPath: p, callId: id, actualUsd: 0.002 });
  }
  const doc = readLedger({ ledgerPath: p, maxAgeMs: Number.POSITIVE_INFINITY });
  // before the split the hot file keeps every settled entry (CAP*3+5 of them);
  // after it, the oldest are sealed and only a bounded tail remains
  assert.ok(
    doc.entries.length <= CAP,
    `the live ledger holds ${doc.entries.length} entries; it must stay within ${CAP} (the rest is sealed)`,
  );
});
