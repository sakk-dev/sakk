# Policy engine — what & why

One sentence: **a deterministic, auditable answer to "may this agent do this
action at this cost?" — decided from a declarative, hash-pinned policy file,
before any reservation exists.**

## Position in the architecture

A third module beside the two trust roots, feeding the first:

```
enforcer (MCP server / hook / CI gate)        ← owns refusal & logging
    └─ decide(policy, context)  → verdict     ← this module (pure)
         └─ on ALLOW only: reserve(...)       ← ledger, UNTOUCHED
```

Three load-bearing properties, in priority order:

1. **The ledger is not modified.** Policy gating happens strictly before
   `reserve`; a non-ALLOW verdict means the enforcer never calls the ledger.
   A closed policy pack can refuse _more_ than the open default, never spend
   more (seam rule 2).
2. **`decide()` is pure and deterministic.** Same policy bytes + same
   context → same verdict, every time, on every machine — the scorer
   philosophy applied to authorization, and what makes a decision log
   third-party replayable.
3. **Every decision is attributable.** A logged decision carries the
   SHA-256 of the policy that produced it, the rule id that fired, and the
   context it judged. "Why was this allowed on March 3rd?" is answered by
   replaying the logged context against the logged policy hash.

## Policy file: `sakk-policy.v1`

JSON (zero-dep rule: no YAML), validated by our own schema validator, same
as cases/traces. Shape (illustrative, the schema is the contract):

```json
{
  "schema": "sakk-policy.v1",
  "default_verdict": "deny",
  "rules": [
    {
      "id": "docs-low-risk",
      "match": {
        "agent": "*",
        "action": "file_write",
        "scope": ["docs/", "README.md"],
        "max_estimated_usd": 0.5
      },
      "verdict": "allow"
    },
    {
      "id": "prod-deploy-four-eyes",
      "match": { "agent": "*", "action": "deploy", "scope": ["prod/"] },
      "verdict": "require_approval",
      "approvers_min": 2
    }
  ]
}
```

- **Verdicts**: `allow` · `deny` · `require_approval`. Nothing else; an
  unknown verdict in a file fails validation.
- **First match wins**, top to bottom. No specificity scoring, no merging —
  an auditor must be able to resolve any decision with a finger on the file.
- **`default_verdict` is mandatory.** A regulated profile sets `deny`; the
  schema accepts `allow` for permissive dev use, but there is no implicit
  default — absence is a validation error, not a fallback.
- **Matchers are the scorer's prefix rules** (the existing, mutation-drilled
  `matchesAny` family — `x/` = subtree, `x` = exact path; no wildcards),
  never regexes — bounded, deterministic, no ReDoS surface. (Amended at
  implementation: the signed "reuse the scorer matcher" decision implies
  prefix semantics, which are stricter than the draft's glob examples.)
- **Amounts gate at reserve-estimate level**: `max_estimated_usd` caps what
  this rule may bless; a context whose estimate exceeds it does NOT match
  this rule and falls through to the next (so a tighter rule below, or the
  default, decides). The ledger cap remains the independent hard wall.

## Fail-closed clauses (the ones that will be attacked)

| Situation                                                      | Answer                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy file missing / unreadable / wrong schema                | `POLICY_UNREADABLE` — load refuses; enforcer must treat as deny                                                                                               |
| Empty `rules` + `default_verdict: allow`                       | `POLICY_VACUOUS_ALLOW` — refused at load (R-04: a gate that can only say yes is not a gate)                                                                   |
| Rule that can never fire (shadowed by earlier)                 | `POLICY_RULE_SHADOWED` — refused at load, names both rule ids                                                                                                 |
| Context missing a field a matcher needs                        | that rule does not match; if NO rule matches → default verdict                                                                                                |
| `estimated_usd` absent / NaN / negative / string               | `CONTEXT_INVALID` — decide refuses, never coerces                                                                                                             |
| Decision log unwritable (enforcer side)                        | enforcer refuses the action (`DECISION_UNLOGGABLE`) — an unauditable allow is a deny                                                                          |
| Policy swapped between load and decide                         | irrelevant by construction: decide() takes the loaded, hashed object; the hash in the log pins what decided                                                   |
| Non-canonical context scope (`prod//x`, `./x`, `/x`, `a/../b`) | `CONTEXT_INVALID` — an alias that matches nothing must not slide past a deny (adversarial-review F2); unicode normalization is the ENFORCER's documented duty |
| Duplicate JSON keys in the policy file                         | `POLICY_SCHEMA_INVALID` — a hashed file must have exactly one meaning on every parser (review F7); replay is DEFINED as this kernel's loadPolicy              |
| Shadow-scan work budget exceeded                               | `POLICY_TOO_COMPLEX` — bounded time by refusal, never by hanging (review F4)                                                                                  |

## Open kernel / closed packs

Kernel (this repo, AGPL): loader+validator+hasher, `decide`, `logDecision`,
schema, reference policies (`permissive-dev`, `regulated-strict` as
examples). Enterprise (closed): CBUAE/DORA/DIFC policy packs, approval
service behind `require_approval`, pack update subscription. The seam is the
file format itself — packs are data, not code, so the kernel never imports
enterprise anything (seam rule 1).
