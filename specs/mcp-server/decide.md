# MCP server — decide

**Verdict: GO** (L1 — async review; no signature gate. The blueprint names
MCP as the P0 integration: "没有数据面接入就没有产品;MCP 是跨工具最大公约数".)

## Blueprint line served

集成面 P0 · Claude Code/Cursor/Copilot — "hooks · MCP server(预留/结算/审批
以 MCP 工具暴露)". This is the policy kernel's FIRST enforcer: the module
that turns decide() verdicts into actual refusals in front of a real agent.

## Why now

- The kernel (merged, 🔒L2-signed) is inert until an enforcer composes it
  with the ledger; the integration-demo enforcer in the test suite is the
  specification — this ships it as a product surface.
- MCP works identically for Claude Code, Cursor and Copilot — one adapter,
  three P0 tools covered.
- Adoption lever for M-A: `npx sakk mcp` in an agent config is the
  lowest-friction way anyone can put a spend gate in front of an agent.

## Kill criteria

- Cannot implement the MCP stdio protocol within the zero-dependency rule
  (JSON-RPC 2.0 over stdio is hand-rollable; if protocol churn forces an
  SDK, stop and redesign).
- Cannot keep the enforcer thin: any temptation to put money or decision
  semantics IN the server (rather than composing ledger + kernel) ends the
  design — seam rule 2.

## Scope cut

IN: stdio MCP server (`sakk mcp` subcommand); tools `sakk_reserve`,
`sakk_settle`, `sakk_status`; optional policy gating via `SAKK_POLICY_PATH`
(loaded once at startup, hash-pinned); decision log next to the ledger.
OUT (explicit): approval COLLECTION (require_approval refuses with the
requirement attached — interactive approval flows belong to the approval
service, 🔒L2); HTTP/SSE transports; multi-ledger routing; Windows.
