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
TOTAL=0

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

# run_drill <id> <file> <anchor> <replacement> <named-test-substring> [npm-test-script]
run_drill() {
  id="$1"; file="$2"; anchor="$3"; replacement="$4"; named="$5"; ts="${6:-test:eval}"
  TOTAL=$((TOTAL + 1))
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
  out="$(cd "$dir" && npm run --silent "$ts" 2>&1)"
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
# (anchor updated with review fix D3: the rule now branches by executor capability)
run_drill MUT-B eval/lib/scorer.mjs \
  "if (executorRuns.length === 0)" \
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

# MUT-E: evaluate policy rules in REVERSE order → the ordering test must die red
# (policy suite lives under `npm test`, hence the 6th argument)
run_drill MUT-E src/policy.mjs \
  "for (const rule of policy.rules)" \
  "for (const rule of [...policy.rules].reverse())" \
  "first match wins: the earlier of two overlapping rules decides" \
  "test"

# MUT-F: let an empty allow-by-default policy load → the vacuous-gate test must die red
run_drill MUT-F src/policy.mjs \
  "    (doc.default_verdict === 'allow' && doc.rules.every((r) => r.verdict === 'allow')) ||" \
  "    false ||" \
  "POLICY_VACUOUS_ALLOW: an empty allow-by-default policy refuses at load" \
  "test"

# MUT-G: switch off the global kill switch → the halt-refusal test must die red
run_drill MUT-G src/ledger.mjs \
  "if (doc.halt?.global) {" \
  "if (false) {" \
  "50 retries after the halt" \
  "test"

# ── Plan items 1–4: one anchor per fail-closed guard (testing standard T0) ──

# MUT-H: switch off the PER-AGENT halt → the per-agent refusal test must die red
run_drill MUT-H src/ledger.mjs \
  "    if (agentHalt) {" \
  "    if (false) {" \
  "halted agent refuses AGENT_HALTED; other agents and anonymous callers proceed" \
  "test"

# MUT-I: let a FAKE run read COVERED → the harness-only test must die red
run_drill MUT-I eval/lib/packs.mjs \
  "    if (!real) return 'HARNESS_ONLY';" \
  "    if (false) return 'HARNESS_ONLY';" \
  "FAKE mode → HARNESS_ONLY for every requirement, even when every case passed"

# MUT-T: let a REAL run on a modified harness read COVERED → its test must die red (F-65)
run_drill MUT-T eval/lib/packs.mjs \
  "    return clean ? 'COVERED' : 'HARNESS_MODIFIED';" \
  "    return 'COVERED';" \
  "F-65: a REAL run on a modified or uncheckable harness never reads COVERED"

# MUT-U: make a REAL run's model optional again → a forger deletes one key
# and the model cross-check is skipped; its test must die red (F-65)
run_drill MUT-U eval/lib/bundle-verify.mjs \
  "    if (real && !(typeof metricsDoc.model_id === 'string' && metricsDoc.model_id.trim() !== ''))" \
  "    if (false)" \
  "a REAL run whose metrics name no model" \
  "test"

# MUT-V: stop requiring pack-report keys → a deleted key reads PASS, and the
# fail-open-absence class detector must die red (F-65 class fix)
run_drill MUT-V eval/lib/bundle-verify.mjs \
  "      if (missing.length > 0) bad('PACK_REPORT_INVALID', \`missing \${missing.join(', ')}\`);" \
  "      if (false) bad('PACK_REPORT_INVALID', '');" \
  "every silently deletable key is declared, and every declaration is still needed" \
  "test"

# MUT-W: a scoped resume also clears the global halt → its test must die red (kill-switch review S3)
run_drill MUT-W src/ledger.mjs \
  "    else h.global = null;" \
  "    h.global = null;" \
  "a scoped resume leaves the global halt in force" \
  "test"

# MUT-X: drop the cap check → a reservation past the cap must be refused by its test (red line)
run_drill MUT-X src/ledger.mjs \
  "    if (t.committedUsd + estimatedMaxUsd >= doc.capUsd - CAP_EPSILON_USD) {" \
  "    if (false) {" \
  "exactly at the cap: refused (the cap is a wall, not a target)" \
  "test"

# MUT-Y: print the secret instead of its keyed fingerprint → its test must die red (red line)
run_drill MUT-Y src/secret-scan.mjs \
  "const fingerprint = (value) => createHmac('sha256', KEY).update(value).digest('hex').slice(0, 12);" \
  "const fingerprint = (value) => value;" \
  "keyed fingerprints: stable within a run, different across runs unless SAKK_SCAN_KEY is set" \
  "test"

# MUT-Z: take away mutual exclusion → concurrent reservations lose updates and
# overspend; the real race must die red (F-84: the old "race" was sequential)
run_drill MUT-Z src/ledger.mjs \
  "      mkdirSync(lock);" \
  "      mkdirSync(lock, { recursive: true });" \
  "8 concurrent processes cannot jointly overspend, and every grant is booked" \
  "test"

# MUT-J: judge the fiction-token exemption on the WHOLE match → a token in a
# username exempts a real password, and its test must die red
run_drill MUT-J src/secret-scan.mjs \
  "const secret = rule.group ? m[rule.group] : m[0];" \
  "const secret = m[0];" \
  "a token in the USERNAME does not exempt a real password" \
  "test"

# MUT-K: stop scanning staged TYPE changes → the symlink→file test must die red
run_drill MUT-K src/secret-scan.mjs \
  "'--diff-filter=AMT'," \
  "'--diff-filter=AM'," \
  "a TYPE change (symlink → file holding a secret) is scanned" \
  "test"

# MUT-L: ignore unsettled reservations in a bundle → the unresolved-spend test must die red
run_drill MUT-L eval/lib/bundle-verify.mjs \
  "if (ledger.entries.some((e) => e.status !== 'SETTLED'))" \
  "if (false)" \
  "a RESERVED entry left open is unresolved spend too" \
  "test"

# MUT-M: stop recomputing metrics in a bundle → the inflated-metrics test must die red
run_drill MUT-M eval/lib/bundle-verify.mjs \
  "if (!same(m[k], v))" \
  "if (false)" \
  "inflated pass rate in metrics.json → METRIC_MISMATCH" \
  "test"

# MUT-N: treat falsy JSON as a skip again → the B1 regression must die red
run_drill MUT-N eval/lib/bundle-verify.mjs \
  "    if (!isObj(v)) {" \
  "    if (false) {" \
  "→ CASE_FILE_INVALID + METRICS_UNVERIFIABLE" \
  "test"

# ── Core files outside plan 1–4 that had no anchor (core-specs detector) ──

# MUT-O: let a denied MCP call reserve anyway → the denied-retries test must die red
run_drill MUT-O src/mcp.mjs \
  "if (decision.verdict !== 'allow')" \
  "if (false)" \
  "allow reserves; THREE denied retries = three refusals, three log lines, ZERO entries" \
  "test"

# MUT-P: ship a bundle its own verifier rejects → the self-check test must die red
run_drill MUT-P scripts/evidence-bundle.mjs \
  "if (check.status === 'FAIL')" \
  "if (false)" \
  "a source the verifier rejects is never shipped → BUNDLE_SELF_CHECK_FAILED" \
  "test"

# MUT-Q: drop the path-segment boundary (lib/a.mjs would match lib/a.mjs.evil)
run_drill MUT-Q src/match.mjs \
  'return p === x || p.startsWith(`${x}/`);' \
  'return p === x || p.startsWith(x);' \
  "traversal/absolute/empty/dot-segment/double-slash match NO rule"

# MUT-R: let a paid step spawn with a cap that differs from its reservation
run_drill MUT-R eval/lib/paid-step.mjs \
  "if (capArgUsd !== estimateUsd) {" \
  "if (false) {" \
  "7: capArg disagreeing with the reserved amount → paidStep refuses on the spot"

# MUT-S: let an exempt match cover its span again → the real DSN it
# swallowed hides from the second pass, and its test must die red (F-63)
run_drill MUT-S src/secret-scan.mjs \
  "      exempted += 1; // counted, never silent" \
  "      spans.push([h.index, h.end]); exempted += 1;" \
  "F-63: an exempt match never hides a real secret it swallowed" \
  "test"

# Pristine control: an unmutated copy must be fully green on BOTH suites
dir="$(copy_repo)"
out="$(cd "$dir" && npm run --silent test:all 2>&1)"
if [ $? -eq 0 ]; then
  log "[CONTROL] pristine copy green"
else
  log "[CONTROL] pristine copy RED — baseline broken, drill results void"
  printf '%s\n' "$out" | tail -20 >> "$REPORT"
  FAILED=1
fi
rm -rf "$dir"

if [ "$FAILED" -eq 0 ]; then
  log "== DRILL PASS: $TOTAL/$TOTAL mutants killed by their named tests; control green. Report: $REPORT =="
  exit 0
else
  log "== DRILL FAIL: see $REPORT =="
  exit 1
fi
