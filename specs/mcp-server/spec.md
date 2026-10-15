# MCP server — what & why

One sentence: **the thinnest possible enforcer — three MCP tools that put
the ledger (and optionally the policy kernel) in front of any MCP-speaking
agent, refusing exactly where the library refuses.**

## Position

```
agent (Claude Code / Cursor / anything MCP)
   └─ MCP stdio (JSON-RPC 2.0)
        └─ sakk mcp                       ← this block: transport + composition ONLY
             ├─ decide(policy, context)   ← kernel (optional, SAKK_POLICY_PATH)
             ├─ logDecision(...)          ← audit trail, fail-closed
             └─ reserve / settle / totals ← ledger, byte-identical semantics
```

The server owns NO semantics. Every refusal an agent sees is a
`LedgerError`/`PolicyError` code passed through verbatim; every allow is a
real reservation. Deleting the server and calling the library yields the
same books — that is the test of thinness.

## Tools (public API)

| Tool           | Input                                                          | Behavior                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sakk_reserve` | `callId`, `estimatedMaxUsd`, optional `agent`/`action`/`scope` | policy gate (when configured) → `decide`; non-allow → structured refusal (verdict, ruleId, approversMin on require_approval), ledger untouched; allow → `logDecision` then `reserve` |
| `sakk_settle`  | `callId`, `actualUsd` XOR `failedUnknownCost`                  | passthrough to `settle`; reconciliation halts surface as the ledger's own codes                                                                                                      |
| `sakk_status`  | —                                                              | `readLedger`+`totalsOf` summary incl. `reconciliation_required`, `max_reservable_usd`, policy hash when configured                                                                   |

Tool results are MCP `content` text carrying ONE JSON object; refusals set
`isError: true` with `{ code, message, details }` — the library's codes,
never new ones (two exceptions below).

## Fail-closed clauses

| Situation                                  | Answer                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAKK_LEDGER_PATH` unset and no `--ledger` | refuse to START (`MCP_LEDGER_PATH_REQUIRED`) — a gate with no books is not a gate                                                                        |
| `SAKK_POLICY_PATH` set but unloadable      | refuse to START with the kernel's own `POLICY_*` code — a misconfigured policy is never "no policy"                                                      |
| policy configured, decision unloggable     | the action refuses (`DECISION_UNLOGGABLE`) — kernel contract, surfaced                                                                                   |
| `require_approval` verdict                 | refusal carrying `approversMin` + ruleId; approval collection is explicitly NOT here (🔒L2 service)                                                      |
| unknown tool / malformed JSON-RPC          | protocol error response; never a crash, never a silent drop                                                                                              |
| agent sends `scope` aliases (`prod//x`)    | kernel refuses `CONTEXT_INVALID` (F2) — the server does NOT normalize paths in v1; normalization duty documented in the tool description the agent reads |

New codes introduced by this block: `MCP_LEDGER_PATH_REQUIRED` (startup) and the two policy-verdict surfaces `POLICY_DENIED` / `POLICY_APPROVAL_REQUIRED` (tool refusals carrying the full decision). Decision log lands as `sakk-decisions.jsonl` beside the ledger (the alerts-file convention).

## Policy pinning

The policy file is loaded ONCE at startup; its hash rides every decision
log line and the `sakk_status` output. Changing the policy means
restarting the server — v1 has no hot reload by design (a swapped file
mid-session is the attack the hash exists to expose, spec F7/#6).
