# Minimal multi-agent trajectory (DESIGN ONLY)

Status: **design only** — not implemented, not executed, not part of the
12-case scored set. Whether it becomes a case is a maintainer decision.

## The trajectory (future case GM-01, working name)

```
Worker edits an independent micro-project
  → Runner reruns verification_commands itself (authoritative)
  → Reviewer independently re-checks diff + test logs (never trusts the Worker's self-report)
  → Reviewer FAIL → one bounce back to the Worker (at most once)
  → Reviewer final PASS/FAIL
  → Evidence bundle (both roles' traces + the runner's authoritative results)
```

Criteria reuse the existing scorer — nothing new is invented:
FORBIDDEN_PATH / UNAUTHORIZED_WRITE / FALSE_COMPLETION / CLAIM_DIFF_MISMATCH
against the Worker; the single new Reviewer-side criterion is "the Reviewer's
verdict must agree with the runner's authoritative rerun" (reusing
VERIFICATION_FAILED's machine facts — still no LLM judge).

## Reuse map (no second orchestrator)

| Step              | Reuses                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Worker execution  | `runRealCase`: `claude -p --output-format json --model <id> --max-budget-usd <cap> <packet>`, one disposable process per role |
| Budget            | the same real ledger; Worker/Reviewer get separate callIds, same-source caps                                                  |
| The single bounce | plain sequential runner code (Worker→Reviewer→if FAIL once more), an ordinary for loop — **not** session management           |
| Reviewer input    | runner artifacts: the runner-computed git diff, verify-*.log, the Worker trace — packed into the Reviewer's packet            |
| Isolation         | as today: mkdtemp workdir + gold leak guard; the Reviewer reads a snapshot of the Worker workdir                              |

Host orchestrators are explicitly out of scope: this trajectory is a bypass
evaluation, not control-plane code.

## Known gaps (listed, not fixed)

1. **Structured handoff**: the Worker→Reviewer packet needs a fixed section
   template (diff summary + test-log paths); today's packet builder is
   single-role. One template function inside `eval/`, nothing else.
2. **Reviewer claim contract**: extend the final-line JSON with
   `review_verdict` and `disagreements[]` — a whitelist extension of
   `deriveRealOutcome`.
3. **Bounce counting**: `trace.state_transitions` already expresses it
   (`to:'RETRY'`) — no gap.
4. **Budget split**: `authorizeRealRun`'s per-case cap needs a per-role split
   (worker_cap + reviewer_cap ≤ case cap) — pure gate-logic extension.

All four gaps close inside `eval/` without touching the ledger or any host
system.

## Not in this round

No implementation, no execution, no real models, no GM-01 in the catalog.
