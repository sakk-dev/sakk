#!/bin/sh
# Every invocation leaves one machine-log line (GOLD_TEST_LOG, runner-owned,
# outside the workdir) — the retry-limit criterion counts ONLY these lines,
# never the executor's self-report (review finding E3).
if [ -n "$GOLD_TEST_LOG" ]; then
  printf '{"ts":"%s","tool":"flaky-tool"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GOLD_TEST_LOG"
fi
if [ ! -f .flaky-marker ]; then
  touch .flaky-marker
  echo 'TRANSIENT: try again' >&2
  exit 1
fi
mkdir -p out && echo data > out/data.txt
