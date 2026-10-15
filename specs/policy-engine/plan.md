# Policy engine — how

## Module layout

```
src/policy.mjs            # kernel: loadPolicy / decide / logDecision / PolicyError
eval/schemas/policy.json  # sakk-policy.v1 JSON Schema (own validator, like cases)
policies/                 # reference policies: permissive-dev.json, regulated-strict.json
test/policy.test.mjs      # behavior suite incl. every refusal path
scripts/policy-fuzz.mjs   # seeded invariant fuzz (same pattern as invariant-fuzz)
```

`src/` placement is deliberate: the kernel is product surface (used by every
enforcer), not eval tooling. It imports **nothing** from `src/ledger.mjs`
and vice versa — the enforcer composes them.

## API (public, semver-bound)

```js
loadPolicy({ policyPath });
// → { policy, policyHash }  (validated, canonical-bytes SHA-256)
// throws PolicyError: POLICY_UNREADABLE | POLICY_SCHEMA_INVALID |
//                     POLICY_VACUOUS_ALLOW | POLICY_RULE_SHADOWED

decide({ policy, policyHash, context });
// context: { agent, action, scope, estimatedUsd, callId }
// → { verdict, ruleId|null, policyHash, context }   — PURE, no I/O
// throws PolicyError: CONTEXT_INVALID

logDecision({ decisionLogPath, decision, by });
// appends one JSONL line; throws DECISION_UNLOGGABLE on any write failure
```

Verdict mapping for enforcers (part of the contract, documented in the
kernel's README section): `allow` → proceed to `reserve()`; `deny` → refuse
with the decision attached; `require_approval` → hold, collect approval
evidence through the approval-gate seam, log approver identities, and only
then `reserve()`. Approver ≠ requester is asserted by the enforcer from the
evidence — the kernel states the requirement (`approvers_min`), the gate
produces the evidence.

## Shadowing detection (load-time, R-04)

A rule R_j is shadowed if some earlier R_i has verdict-independent
superset matching: every context matching R_j also matches R_i. Globs make
full subsumption undecidable cheaply, so v1 pins the decidable cases:
identical match objects, `"*"`/absent-field supersets, and prefix-glob
supersets (`docs/**` ⊇ `docs/api/**`). Anything the checker cannot prove is
allowed through — the check refuses provable dead rules, it does not
promise completeness (stated in the doc; the fuzz leg hunts the rest).

## Determinism guarantees

- Rule evaluation order = array order; no sorting, no scoring.
- Glob matching reuses the scorer's existing matcher (one implementation,
  already mutation-drilled).
- `policyHash` = SHA-256 over the raw file bytes (not re-serialized JSON) —
  what the auditor hashes is what decided.
- No clock, no randomness inside `decide` (log timestamps live in
  `logDecision`).

## Test plan (contract.md holds the acceptance bar)

- Behavior suite: every refusal code; first-match-wins ordering; amount
  fall-through; default application; shadowing detection positive/negative;
  unicode/path-trick contexts; the two reference policies end-to-end.
- **Fuzz**: seeded PRNG generates random policies+contexts; invariants:
  (1) decide is deterministic across two runs, (2) verdict ∈ {rule verdict,
  default}, (3) ruleId=null ⟺ default applied, (4) no thrown error other
  than typed PolicyError.
- **Drill anchors** (added to mutation-drill.sh): MUT-E disable
  first-match-wins (later rule wins) → named ordering test dies;
  MUT-F make `POLICY_VACUOUS_ALLOW` pass → named vacuous-policy test dies.
- Integration demo: fake enforcer script walks allow/deny/require_approval
  against the example approval gate, asserting ledger interaction happens
  only on allow.

## Sizing

Kernel ≈ 250–350 lines + schema + two reference policies; suite ≈ 30–40
tests; one working day at the 1/3 capacity anchor, after design signature.
Implementation PR = 🔒L2: the maintainer merges.
