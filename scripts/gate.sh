#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
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
# self-evolution step 1: what the ledger already learned about these changes
npm run --silent brief
npm run --silent lint
npm run --silent format:check
npm run --silent test
npm run --silent test:eval
echo "gate: green"
