# Real runs (fail-closed; adapter implemented, chain still shut)

**Current state: real execution is structurally impossible in a fresh
checkout.** The adapter exists and is recorder-tested, but the authorization
chain requires (a) all 12 gold labels approved by the named reviewer (all
blank today → the label gate refuses) and (b) a written closure attestation
`eval/CLOSURE_ATTESTATION.json` with
`CLOSURE_VERIFIED=YES ∧ EXIT_GATE=PASS ∧ STATUS=CLOSED` (absent today → the
closure gate refuses). Both gates are opened by humans, never by the tool
itself.

## The authorization chain (any unmet gate refuses; all covered by tests or structure)

1. `--authorization <path>` missing or unreadable → `AUTHORIZATION_FILE_MISSING`
2. JSON unparsable → `AUTHORIZATION_FILE_MALFORMED`
3. `approved !== true` → `NOT_APPROVED`
4. `allow_real_model !== true` → `REAL_MODEL_NOT_ALLOWED`
5. `approved_by` empty → `APPROVED_BY_EMPTY`
6. provider not in the allowlist (`anthropic`) → `MODEL_PROVIDER_UNSUPPORTED`; `model_id` empty → `MODEL_ID_EMPTY`
7. budget fields missing or non-positive → `BUDGET_INVALID`
8. scope binding: selected cases ⊆ `pilot_case_ids` (`CASE_NOT_AUTHORIZED`),
   control-plane cases never run as model cases (`CASE_NOT_MODEL_EXECUTABLE`),
   per-case cap below each case limit (`CASE_CAP_NOT_BELOW_CASE_LIMIT`),
   Σcaps < pilot budget (`PILOT_BUDGET_EXCEEDED`), non-empty pilot scope
   (`PILOT_SCOPE_INVALID`)
9. authoritative ledger (`SAKK_BUDGET_LEDGER_PATH`) unreadable → `AUTHORITATIVE_LEDGER_UNREADABLE`
10. **reviewer label gate** — six elements per case → `GOLD_LABEL_NOT_APPROVED:<id>`
    (deliberately ordered before the manifest gate: a fresh manifest never
    substitutes for approval)
11. gold manifest mismatch → `GOLD_MANIFEST_MISSING` / `GOLD_MANIFEST_MISMATCH`
12. written closure attestation absent/invalid → `CLOSURE_UNVERIFIABLE`
13. work root not under the OS temp dir → `WORKROOT_NOT_ISOLATED_TMP`

## Authorization flow (a future round)

1. Independent acceptance closes → the verifier writes `eval/CLOSURE_ATTESTATION.json`.
2. The reviewer approves all 12 gold labels (`05_MAINTAINER_LABEL_REVIEW.md`).
3. Copy `GOLD_RUN_AUTHORIZATION.example.json` → a real authorization file,
   filled in by the approver personally: `approved: true`,
   `allow_real_model: true`, `approved_by`, `model_provider/model_id` (the
   human picks the model — the tool never picks for them), the three budget
   numbers.
4. Pilot first (3 cases, $6 cap), review results, then decide on the full
   round ($24).
5. Run:

```bash
node eval/bin/gold-runner.mjs --real --authorization <path>
```

Every paid call reserves on the real ledger first; `--max-budget-usd` and the
reservation come from the same value. If gold changed, regenerate the
manifest first:

```bash
cd eval/gold && find . -type f ! -name manifest.sha256 -print0 | xargs -0 shasum -a 256 | sed 's|  \./|  |' | sort -k2 > manifest.sha256
```

## Standing prohibitions

- The tool never fills in the authorization file, never picks the model,
  never raises its own budget.
- Fake-executor results are never presented as a model-capability baseline.
- Real-run results are not called a baseline until the labels are approved.

## Adapter details

`runRealCase`: isolated temp git workdir → reserve before spawn → argv
completeness guard (`REAL_ARGV_INCOMPLETE`) → one headless CLI process →
captures argv/stdout/stderr/exit/timeout/timestamps → runner reruns
verification itself → diff computed by the runner → the claim accepted only
as structured output.

argv shape (verified item by item against the local CLI's own `--help`):

```
claude -p --output-format json --model <model_id> --max-budget-usd <cap> <packet>
```

Machine-log integrity: in v1-open the test/gate logs are writable by the
evaluated process itself (same uid) — they are process attestations
cross-checked by the runner's own verification, not tamper-proof evidence;
their paths reveal neither the evidence store nor the repo. Tamper-proof
logging arrives with the enterprise broker.

Cost: only `envelope.total_cost_usd` (finite, non-negative) counts. Unreadable
→ nothing fabricated: the reservation stays outstanding, the ledger enters
reconciliation (all further reservations refused), the batch halts.

Claim contract: the reply's last line must be
`{"final_claim":"PASS|FAIL|BLOCKED|ESCALATED","files_changed":[...]}` —
missing or unparsable counts as FAIL (strict JSON.parse, no regex guessing).
