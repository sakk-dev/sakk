import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * F-105 as an attacker meets it, first part: the inputs the books store are
 * bounded. (The second part, the books growing with use, is the archive's.) Only long-standing exports are imported, so on
 * the code before the fix these tests run and fail by assertion
 * (findings-proof, R7).
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { initLedger, reserve } = await import(pathToFileURL(join(ROOT, 'src', 'ledger.mjs')));
const fresh = () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'ledger-bounds-')), 'ledger.json');
  initLedger({ ledgerPath, capUsd: 100 });
  return ledgerPath;
};
const code = (fn) => {
  try {
    fn();
    return 'NO_REFUSAL';
  } catch (e) {
    return e.code;
  }
};

test('F-105: 1e-300 estimates and 4 KB call ids are refused', () => {
  assert.equal(
    code(() => reserve({ ledgerPath: fresh(), callId: 'c', estimatedMaxUsd: 1e-300 })),
    'ESTIMATE_INVALID',
  );
  assert.equal(
    code(() => reserve({ ledgerPath: fresh(), callId: 'x'.repeat(4096), estimatedMaxUsd: 1 })),
    'INPUT_TOO_LONG',
  );
});
