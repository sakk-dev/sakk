# MCP server — how

## Layout

```
src/mcp.mjs          # transport (JSON-RPC 2.0 over stdio, hand-rolled) + composition
bin/sakk.mjs         # new subcommand: `sakk mcp [--ledger <p>] [--policy <p>]`
test/mcp.test.mjs    # scripted fake agent: real frames over a spawned child
```

Zero dependencies: MCP's stdio transport is newline-delimited JSON-RPC 2.0
(`initialize` → `tools/list` → `tools/call`). A ~120-line loop covers the
subset three P0 clients actually use; protocol version echoed from the
client's `initialize`, capabilities `{ tools: {} }`.

## Composition (the whole server, conceptually)

```
on tools/call sakk_reserve(args):
  ctx = { agent, action, scope, estimatedUsd: args.estimatedMaxUsd, callId }
  if policy:  d = decide(policy, ctx); logDecision(d)   # unloggable → refuse
              d.verdict !== 'allow' → refusal(d)        # ledger untouched
  reserve(ledgerPath, callId, estimatedMaxUsd)          # LedgerError → refusal
```

settle/status are pure passthroughs. Startup: resolve ledger path
(flag > env; none → MCP_LEDGER_PATH_REQUIRED, exit 2); loadPolicy once if
configured (any POLICY_* → exit 2); decision log = `<ledger>-decisions.jsonl`.

## Frame cap

1 MiB per line; an oversized frame answers a JSON-RPC error and the loop
continues (adversary #8).

## Sizing

~120 lines transport + ~80 composition + ~200 test; one focused block.
