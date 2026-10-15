# Policy engine — acceptance contract (agreed BEFORE coding)

Signed design review is the entry condition; this file is what "done" means.
Done = **converged against this contract**, not tests-green (R-11).

## Adversary table (who attacks, how, what must happen)

| #   | Adversary move                                                             | Must-hold outcome                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Policy with empty rules + default allow ("gate that only says yes")        | `POLICY_VACUOUS_ALLOW` at load                                                                                                                                                                           |
| 2   | Broad early `allow` hiding a later `deny` (rule shadowing)                 | provable cases: `POLICY_RULE_SHADOWED` at load, both ids named                                                                                                                                           |
| 3   | Context crafted to match nothing (unknown action, alien scope)             | default verdict, ruleId null — never an implicit allow unless the file says so                                                                                                                           |
| 4   | `estimatedUsd: "0.1"` / NaN / −5 / missing                                 | `CONTEXT_INVALID`, no coercion                                                                                                                                                                           |
| 5   | Path tricks in scope (`../`, absolute, `docs/../prod`, unicode lookalikes) | glob matcher normalizes/refuses exactly as the scorer does today — one shared implementation, its tests apply                                                                                            |
| 6   | Swap the policy file after load, before the action                         | decision log pins `policyHash` of the object that decided; the swapped file never decided anything                                                                                                       |
| 7   | Enforcer "forgets" to log (disk full, path unwritable)                     | `DECISION_UNLOGGABLE` refusal path exists and is tested; contract text: unauditable allow = deny                                                                                                         |
| 8   | Oversized policy (10k rules) as DoS                                        | load succeeds or refuses in bounded time; fuzz leg includes a size probe; no quadratic blowup in shadow check (decidable subset only)                                                                    |
| 9   | `require_approval` satisfied by the requester approving themselves         | kernel surfaces `approvers_min` + the requirement; integration demo shows the gate evidence carrying distinct identities; full enforcement lands with the enforcer block (stated, not silently deferred) |

## Input-space table (dimensions × pathological values, all tested)

- policy file: missing · unreadable · invalid JSON · wrong schema id ·
  unknown verdict · duplicate rule ids · empty rules · 10k rules
- rule match fields: absent · `"*"` · empty array · glob sets · overlapping
- context fields (`agent/action/scope/estimatedUsd/callId`): absent · empty
  string · wrong type · unicode · traversal strings · huge values
- amounts: 0 · negative · NaN · Infinity · string · exactly at
  `max_estimated_usd` (boundary: AT the limit matches; the ledger's
  epsilon-wall philosophy stays the ledger's — policy limits are plain ≤)

## Evidence-source declaration (R-02)

Judgements about policy behavior come from: (1) the policy file bytes and
their SHA-256, (2) the decision log JSONL, (3) typed `PolicyError.code` —
never from enforcer prose or agent self-report. The decision log is the
audit artifact; its line format is semver-bound public API.

## Converge checklist (the PR must tick every line)

- [ ] Every refusal code above has a negative test asserting code + message
- [ ] Fuzz leg green on 3 fresh seeds + any previously failing seed replayed
- [ ] MUT-E / MUT-F drill anchors added and both mutants die by their named tests; control stays green
- [ ] Reference policies `permissive-dev` + `regulated-strict` load, hash stably, and drive the integration demo (ledger touched only on allow)
- [ ] Zero new runtime dependencies; `src/ledger.mjs` diff is EMPTY
- [ ] Error codes + log line format listed in CHANGELOG as public API
- [ ] eval/AGENTS.md note if any eval surface touched (expected: none)
- [ ] Self-report per fix/feature: verified / partial / failed — no bare "done"
- [ ] Independent adversarial review of the implementation diff (R-05) before the signed merge

## Out-of-contract (explicitly not promised in this block)

Approval service, policy packs beyond the two references, hot reload,
policy distribution/signing, MCP/hook enforcement (next block), Windows.
