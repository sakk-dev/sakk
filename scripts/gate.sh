#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Commit gate (testing standard T0 + §12.3): lint, format and every test
# suite, with exit codes passed straight through — never through tail or
# grep. Commit with:
#
#   bash scripts/gate.sh && git commit
#
# Core-area changes additionally need `npm run drill` and the fuzzers
# (`npm run audit` runs everything).
set -euo pipefail
cd "$(dirname "$0")/.."
export CI=true
# F-220: one heavy run at a time on this machine; a second one refuses here and
# names the holder. Assigned apart from `export` so that set -e sees a refusal.
SAKK_HEAVY_LOCK_PID="$(node scripts/heavy-lock.mjs acquire "gate in $PWD" $$)"
export SAKK_HEAVY_LOCK_PID
trap 'node scripts/heavy-lock.mjs release $$' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# self-evolution step 1: what the ledger already learned about these changes
npm run --silent brief
npm run --silent lint
npm run --silent format:check
npm run --silent test
npm run --silent test:eval
echo "gate: green"
