#!/bin/bash
# T4 — environment matrix: node 20/22/24 × clean Linux containers.
# Each cell: full suites + --validate + fault injection + 1-min soak (4w)
# + 1-min MCP torture (2s) + an ENOSPC probe on a 256KB tmpfs (the one
# fault macOS cannot stage honestly). Any red cell fails the matrix.
#   sh scripts/campaign/matrix.sh [minutes-per-soak]
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE="$(mktemp -d)"
MIN="${1:-1}"
FAIL=0
( cd "$ROOT" && git clone -q . "$STAGE/repo" )

for NODEV in 20 22 24; do
  echo "══ matrix cell: node:$NODEV ══"
  docker run --rm -v "$STAGE/repo":/repo --mount type=tmpfs,destination=/tiny,tmpfs-size=262144 "node:$NODEV" bash -lc '
    set -e
    cd /repo
    node --version
    npm run --silent test >/tmp/u.log 2>&1 || { echo UNIT RED; tail -5 /tmp/u.log; exit 1; }
    node eval/bin/gold-runner.mjs --validate >/dev/null
    npm run --silent test:eval >/tmp/e.log 2>&1 || { echo EVAL RED; tail -5 /tmp/e.log; exit 1; }
    echo "suites green"
    node scripts/campaign/fault-injection.mjs >/tmp/f.log 2>&1 || { echo FAULT RED; tail -8 /tmp/f.log; exit 1; }
    tail -1 /tmp/f.log
    node scripts/campaign/soak-ledger.mjs --minutes '"$MIN"' --workers 4 --seed 7 2>&1 | tail -1
    node scripts/campaign/mcp-torture.mjs --minutes '"$MIN"' --servers 2 --seed 7 2>&1 | tail -1
    node -e "
      const m = await import(\"/repo/src/ledger.mjs\");
      m.initLedger({ ledgerPath: \"/tiny/l.json\", capUsd: 1e6 });
      let typed = null;
      try {
        for (let i = 0; i < 100000; i++)
          m.reserve({ ledgerPath: \"/tiny/l.json\", callId: \"fill-\" + i + \"-\" + \"x\".repeat(3000), estimatedMaxUsd: 0.001 });
      } catch (e) {
        if (e.constructor.name !== \"LedgerError\") { console.error(\"ENOSPC UNTYPED:\", e.constructor.name, e.message.slice(0,120)); process.exit(1); }
        typed = e.code;
      }
      if (typed === null) { console.error(\"ENOSPC never hit — enlarge the probe\"); process.exit(1); }
      console.log(\"ENOSPC probe → typed refusal:\", typed);
      const doc = m.readLedger({ ledgerPath: \"/tiny/l.json\", maxAgeMs: Infinity });
      if (typed !== \"LEDGER_WRITE_FAILED\") { console.error(\"C-4 regression: disk-full surfaced as\", typed, \"not LEDGER_WRITE_FAILED\"); process.exit(1); }
      console.log(\"ledger still readable after disk-full:\", doc.entries.length, \"entries — OK\");
    " --input-type=module
    echo "cell node:'"$NODEV"' PASS"
  ' || { echo "CELL node:$NODEV FAILED"; FAIL=1; }
done
[ "$FAIL" = 0 ] && echo "== MATRIX PASS: all cells green ==" || { echo "== MATRIX FAIL =="; exit 1; }
