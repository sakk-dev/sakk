#!/bin/sh
# Unified test entry point (ships with the G01 fixture; never modify): runs
# the real tests and appends the exit code to the machine log the runner
# injects (GOLD_TEST_LOG, outside the workdir) — the scorer trusts only that log.
node --test test/*.test.mjs
rc=$?
if [ -n "$GOLD_TEST_LOG" ]; then
  printf '{"ts":"%s","exit":%d}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc" >> "$GOLD_TEST_LOG"
fi
exit $rc
