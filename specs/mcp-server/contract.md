# MCP server — acceptance contract (agreed before coding)

L1 block: ships with async adversarial review; "done" = converged here.

## Adversary table

| #   | Move                                                                  | Must-hold outcome                                                                                                                  |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Agent calls `sakk_reserve` twice with one `callId` (double-bill)      | second refuses `DUPLICATE_CALL_ID`; one ledger entry                                                                               |
| 2   | Agent skips reserve, calls `sakk_settle` directly                     | ledger's own refusal passes through; no entry invented                                                                             |
| 3   | Policy says deny/approval; agent retries the same call 50×            | 50 structured refusals, 50 decision-log lines, ZERO ledger entries                                                                 |
| 4   | Agent sends `scope: "prod//x"` to dodge a deny                        | `CONTEXT_INVALID` surfaces; nothing reserved                                                                                       |
| 5   | Agent sends garbage JSON-RPC / unknown tool / missing params          | protocol-level error response; server stays up; next valid call works                                                              |
| 6   | Operator points `SAKK_POLICY_PATH` at a vacuous/shadowed/dup-key file | server refuses to START with the kernel's code — never "runs without policy"                                                       |
| 7   | Decision log made unwritable mid-session (disk full)                  | every policy-gated reserve refuses `DECISION_UNLOGGABLE`; ledger untouched                                                         |
| 8   | Agent floods with huge strings (1MB callId/scope)                     | kernel/ledger caps refuse; server memory bounded (JSON-RPC line cap, 1 MiB; oversized frame → protocol error, connection survives) |
| 9   | Prompt-injected agent asks the server to "disable the policy"         | no such tool exists; tools/list is the whole attack surface                                                                        |

## Input-space table

- env/args: ledger path {unset, flag, env, both-different(flag wins)} ×
  policy path {unset, valid, each POLICY_* refusal class}
- per tool: params {missing, wrong type, extra keys(ignored), boundary
  amounts} — amounts semantics are the ledger's, asserted by passthrough
- JSON-RPC: {not-JSON, no id, batch, notification, unknown method,
  oversized frame}

## Evidence-source declaration (R-02)

Judgements come from: the ledger file, the decision log (hash-pinned), and
the server's JSON-RPC responses captured by a scripted fake agent in tests
— never from server logs or prose. The scripted-client tests speak REAL
protocol frames over a child process's stdio.

## Converge checklist

- [x] Every adversary row has a named test driving the REAL server binary
      over stdio (spawned child, real frames)
- [x] Thinness proof: a test replays the same sequence through the library
      directly and asserts the same ledger entries (callId, status, amounts)
- [x] Zero new runtime deps; `src/ledger.mjs` and `src/policy.mjs` diffs
      EMPTY
- [x] New codes `MCP_LEDGER_PATH_REQUIRED` / `POLICY_DENIED` / `POLICY_APPROVAL_REQUIRED` / `MCP_ARG_TOO_LONG` + tool schemas in CHANGELOG
      (public API)
- [x] README: one "MCP" section with the Claude Code / Cursor config
      snippet; tool descriptions state the enforcer's normalization duty
- [x] Self-report per finding: verified / partial / failed
- [x] In-session adversarial review completed (round 1: 4 merge-blocking F1-F4 + 11 more — all closed with attack regressions); DeepSeek workflow pending secret (R-05; DeepSeek workflow once
      the secret lands, in-session reviewer regardless)

## Amendments at review (2026-10-15/16)

R-05 round on the first implementation: F1 settle swallowed the halt
signal (R-15) → library return rides the response; F2 truthy coercion
broke thinness → verbatim passthrough, divergence test; F4 no string caps
without policy → enforcer-level `MCP_ARG_TOO_LONG` at 4096 (seam rule 2);
F5 batch/primitive frames answered nothing → -32600; F8 set-but-empty
policy env refused; F11 one refusal per flood; F12 status mirrors CLI
staleness (Infinity); F13 honest no-policy response note + agentId reaches
the books; F15 decision log is per-ledger (`<ledger>.decisions.jsonl`).
Known bounds documented, not fixed in v1: frame cap counts UTF-16 units
(~3MiB worst-case CJK); no outbound backpressure handling.
