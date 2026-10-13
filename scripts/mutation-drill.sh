#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Mutation drill: prove the test suite can actually fail.
#
# For each named mutant, this script copies the repo to a temp directory,
# breaks EXACTLY ONE scoring/safety rule, reruns the suite, and requires
# (a) a non-zero exit AND (b) the named guardian test to be the one that
# goes red. Then it runs one pristine copy to prove the green baseline.
# "MUTANT KILLED" without this evidence is just vibes.
#
# Usage: sh scripts/mutation-drill.sh [report-file]
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPORT="${1:-$ROOT/mutation-drill-report.txt}"
: > "$REPORT"
FAILED=0

log() { printf '%s\n' "$*" | tee -a "$REPORT"; }

copy_repo() {
  dir="$(mktemp -d "${TMPDIR:-/tmp}/sakk-drill-XXXXXX")"
  # tar keeps this portable (no rsync dependency); .git and node_modules excluded
  (cd "$ROOT" && tar -cf - --exclude .git --exclude node_modules --exclude mutation-drill-report.txt .) | (cd "$dir" && tar -xf -)
  # the runner records a git commit per case, so the copy needs its own throwaway repo
  (cd "$dir" && git init -q && git add -A && \
    git -c user.email=drill@sakk.local -c user.name=drill commit -qm drill) >/dev/null 2>&1
  printf '%s' "$dir"
}

# run_drill <id> <file> <anchor> <replacement> <named-test-substring>
run_drill() {
  id="$1"; file="$2"; anchor="$3"; replacement="$4"; named="$5"
  dir="$(copy_repo)"
  target="$dir/$file"
  before_hash="$(shasum -a 256 "$target" | cut -d' ' -f1)"
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const [, file, anchor, replacement] = process.argv;
    const src = readFileSync(file, "utf8");
    const n = src.split(anchor).length - 1;
    if (n !== 1) { console.error(`anchor count ${n} != 1 in ${file}`); process.exit(2); }
    writeFileSync(file, src.replace(anchor, replacement));
  ' "$target" "$anchor" "$replacement"
  if [ $? -ne 0 ]; then
    log "[$id] DRILL BROKEN: anchor not found exactly once in $file (source drifted — update the drill)"
    FAILED=1; rm -rf "$dir"; return
  fi
  after_hash="$(shasum -a 256 "$target" | cut -d' ' -f1)"
  out="$(cd "$dir" && npm run --silent test:eval 2>&1)"
  status=$?
  if [ $status -eq 0 ]; then
    log "[$id] MUTANT SURVIVED: suite stayed green after mutating $file — the guarding test does not exist"
    FAILED=1
  elif ! printf '%s' "$out" | grep -F "$named" | grep -Eq '✖|not ok'; then
    # node --test prints '✖ name' on a TTY and TAP 'not ok N - name' otherwise (CI)
    log "[$id] WRONG KILLER: suite went red (exit=$status) but the named test '$named' is not among the failures"
    printf '%s\n' "$out" | grep -E '✖|not ok' | head -5 | tee -a "$REPORT"
    FAILED=1
  else
    log "[$id] MUTANT KILLED by '$named' (exit=$status)"
  fi
  {
    printf '[%s] file=%s\n' "$id" "$file"
    printf '[%s] anchor: %s\n' "$id" "$anchor"
    printf '[%s] sha256 before=%s after=%s\n' "$id" "$before_hash" "$after_hash"
    printf '%s\n' "$out" | grep -E '✖|not ok|tests [0-9]+|pass [0-9]+|fail [0-9]+' | sed "s/^/[$id] /"
    printf '\n'
  } >> "$REPORT"
  rm -rf "$dir"
}

log "== Sakk mutation drill $(date -u +%Y-%m-%dT%H:%M:%SZ) =="

# MUT-A: disable the forbidden-path check → the forbidden-path test must die red
run_drill MUT-A eval/lib/scorer.mjs \
  "if (matchesAny(p, caseDef.forbidden_paths))" \
  "if (false && matchesAny(p, caseDef.forbidden_paths))" \
  "8: forbidden path modified"

# MUT-B: let "executor never ran tests" count as passing → the false-completion test must die red
run_drill MUT-B eval/lib/scorer.mjs \
  "if (scoring.require_executor_ran_tests === true && executorRuns.length === 0)" \
  "if (false)" \
  "9b: executor never ran tests"

# MUT-C: drop the model id from the spawn argv → the argv-completeness test must die red
run_drill MUT-C eval/bin/gold-runner.mjs \
  "argv.push('--model', String(modelId));" \
  "" \
  "model/hard cap must be in argv"

# MUT-D: report a real-model pass rate from a fake run → the false-green test must die red
run_drill MUT-D eval/lib/scorer.mjs \
  "const realModelPassRate = executorMode === 'REAL' ? rateOf(modelCases) : null;" \
  "const realModelPassRate = rateOf(modelCases);" \
  "FAKE mode: real_model_case_pass_rate must be null"

# Pristine control: an unmutated copy must be fully green
dir="$(copy_repo)"
out="$(cd "$dir" && npm run --silent test:eval 2>&1)"
if [ $? -eq 0 ]; then
  log "[CONTROL] pristine copy green"
else
  log "[CONTROL] pristine copy RED — baseline broken, drill results void"
  printf '%s\n' "$out" | tail -20 >> "$REPORT"
  FAILED=1
fi
rm -rf "$dir"

if [ "$FAILED" -eq 0 ]; then
  log "== DRILL PASS: 4/4 mutants killed by their named tests; control green. Report: $REPORT =="
  exit 0
else
  log "== DRILL FAIL: see $REPORT =="
  exit 1
fi
