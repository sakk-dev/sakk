#!/bin/sh
# Session stop-gate (v3 §十): when the working tree touches core areas, the
# session may not conclude with broken basics. Fast by design (<2s) — the
# full suites/drill/fuzz belong to CI; this catches "walked away mid-break".
set -u
cd "$(dirname "$0")/.." || exit 0
CHANGED=$(git status --porcelain -- src bin eval/lib eval/bin 2>/dev/null | wc -l | tr -d ' ')
[ "$CHANGED" = "0" ] && exit 0
FAIL=0
for f in src/ledger.mjs bin/sakk.mjs eval/bin/gold-runner.mjs eval/lib/scorer.mjs; do
  node --check "$f" || FAIL=1
done
node eval/bin/gold-runner.mjs --validate >/dev/null 2>&1 || { echo "stop-gate: --validate failed"; FAIL=1; }
node -e "
import('./src/ledger.mjs').then(async (m) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const lp = join(mkdtempSync(join(tmpdir(), 'gate-')), 'l.json');
  m.initLedger({ ledgerPath: lp, capUsd: 1 });
  m.reserve({ ledgerPath: lp, callId: 'g', estimatedMaxUsd: 0.5 });
  m.settle({ ledgerPath: lp, callId: 'g', actualUsd: 0.1 });
  let refused = false;
  try { m.reserve({ ledgerPath: lp, callId: 'g', estimatedMaxUsd: 0.1 }); } catch { refused = true; }
  if (!refused) { console.error('stop-gate: duplicate not refused'); process.exit(1); }
})" || FAIL=1
if [ "$FAIL" != "0" ]; then
  echo "stop-gate: core smoke failed — do not conclude; run npm run test:all" >&2
  exit 2
fi
exit 0
