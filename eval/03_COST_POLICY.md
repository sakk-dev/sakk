# Cost policy

## Principle: zero parallel cost sources

Every action that costs money goes through `lib/paid-step.mjs`, which calls
the **real** sakk ledger (`src/ledger.mjs`) — the full fail-closed semantics
apply unchanged: LEDGER_MISSING / MALFORMED / STALE / BUDGET_EXCEEDED /
DUPLICATE_CALL_ID / lock-unavailable, all refuse. The eval harness keeps no
bookkeeping of its own.

## Per-case hard caps

- The runner creates an isolated ledger per case with
  `capUsd = case.max_budget_usd` (G01–G11: $2; G12: $0.5).
- **Same-source discipline**: `paidStep` throws `HARD_CAP_MISMATCH` on the
  spot if `capArgUsd !== estimateUsd`, and the scorer re-checks every trace
  entry (`HARD_CAP_DRIFT`). In real mode `buildRealArgv` writes
  `--max-budget-usd <cap>` from the same value that was reserved.

## Paid counting and refusal semantics

- **Only a successful reservation counts**: the counter file holds one callId
  per line. A ledger refusal writes only a `BUDGET_REFUSED` transition — the
  counter does not move. G12's criterion "zero paid calls after a budget
  refusal" literally counts this file's lines.
- Fake-mode paid steps are stubs (no real CLI spawn), but the
  reserve/settle traffic goes through the real ledger — G12's second $0.4
  reservation is really refused by a $0.5 cap with $0.4 already held.

## Real-run budget shape (see GOLD_RUN_AUTHORIZATION.example.json)

| Scope              | Limit     |
| ------------------ | --------- |
| Pilot (3 cases)    | $6 total  |
| Full 12-case round | $24 total |
| Per-case default   | $2        |

Recommended pilot configuration: **per-case hard cap $1.90**, 3 × $1.90 =
$5.70 against a $6 authorization, leaving $0.30 headroom — the ledger refuses
at the cap, so filling it exactly always fails. The authorization gate
enforces: cap < each case limit (`CASE_CAP_NOT_BELOW_CASE_LIMIT`), Σcaps <
pilot budget (`PILOT_BUDGET_EXCEEDED`), and **the full budget never
substitutes for the pilot budget**.

## Unknown cost ⇒ stop

The actual cost is accepted only as a finite non-negative
`total_cost_usd` in the CLI's structured envelope. If it cannot be read:
**nothing is fabricated** — the reservation stays outstanding, the ledger is
marked reconciliation-required (all further reservations refused), the batch
halts, and the trace separates `actual_cost_usd` / `reserved_cost_usd` /
`cost_is_estimate`. Passing the hard cap off as the actual cost is forbidden.

## Overreach means refusal

Authorization file missing / unapproved / invalid budget fields /
authoritative ledger unreadable → `--real` refuses to start (the full chain
is in `06_REAL_RUN_INSTRUCTIONS.md`). If any case would exceed its cap, the
ledger refuses first; the agent must stop **before** the paid action —
pushing through lands as PAID_COUNT_OUT_OF_RANGE.
