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

- [ ] Every adversary row has a named test driving the REAL server binary
      over stdio (spawned child, real frames)
- [ ] Thinness proof: a test replays the same sequence through the library
      directly and asserts byte-identical ledger entries
- [ ] Zero new runtime deps; `src/ledger.mjs` and `src/policy.mjs` diffs
      EMPTY
- [ ] New code `MCP_LEDGER_PATH_REQUIRED` + tool schemas in CHANGELOG
      (public API)
- [ ] README: one "MCP" section with the Claude Code / Cursor config
      snippet; tool descriptions state the enforcer's normalization duty
- [ ] Self-report per finding: verified / partial / failed
- [ ] Async adversarial review before merge (R-05; DeepSeek workflow once
      the secret lands, in-session reviewer regardless)
