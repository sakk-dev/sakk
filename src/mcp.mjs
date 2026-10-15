// SPDX-License-Identifier: AGPL-3.0-only
//
// MCP enforcer (specs/mcp-server/): the thinnest possible surface putting
// the ledger — and, when configured, the policy kernel — in front of any
// MCP-speaking agent. This module owns NO semantics: every refusal is a
// LedgerError/PolicyError passed through verbatim (plus the two policy
// verdict codes below); deleting the server and calling the library
// yields byte-identical books. Transport is hand-rolled newline-delimited
// JSON-RPC 2.0 over stdio — zero dependencies, like everything here.

import { reserve, settle, readLedger, totalsOf, LedgerError } from './ledger.mjs';
import { decide, logDecision, PolicyError } from './policy.mjs';

const MAX_FRAME = 1 << 20; // 1 MiB per line (contract adversary #8)

const TOOLS = [
  {
    name: 'sakk_reserve',
    description:
      'Reserve budget BEFORE a paid action. Refuses when the cap would be reached, the callId repeats, the ledger is halted, or the configured policy says deny/require_approval. scope must be a CANONICAL relative path — normalize paths and unicode BEFORE calling; aliases like prod//x are refused, not ignored.',
    inputSchema: {
      type: 'object',
      required: ['callId', 'estimatedMaxUsd'],
      properties: {
        callId: { type: 'string', description: 'unique id for this paid call' },
        estimatedMaxUsd: { type: 'number', description: 'worst-case cost of this one call' },
        agent: { type: 'string' },
        action: { type: 'string' },
        scope: { type: 'string', description: 'canonical relative path this action touches' },
      },
    },
  },
  {
    name: 'sakk_settle',
    description:
      'Settle a reservation with the real cost afterwards. Pass failedUnknownCost: true when the cost is unknowable — the ledger then halts all further reservations until a named human reconciles.',
    inputSchema: {
      type: 'object',
      required: ['callId'],
      properties: {
        callId: { type: 'string' },
        actualUsd: { type: 'number' },
        failedUnknownCost: { type: 'boolean' },
      },
    },
  },
  {
    name: 'sakk_status',
    description:
      'Ledger totals, entry counts, reconciliation state, max reservable amount, and the active policy hash when a policy is configured.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const refusal = (obj) => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  isError: true,
});

function callTool({ name, args, ledgerPath, loaded, decisionLogPath }) {
  try {
    if (name === 'sakk_reserve') {
      if (loaded) {
        const context = {
          agent: args.agent,
          action: args.action,
          scope: args.scope,
          estimatedUsd: args.estimatedMaxUsd,
          callId: args.callId,
        };
        const decision = decide({ ...loaded, context });
        // Every decision is logged BEFORE anything acts on it — an
        // unauditable allow is a deny (kernel contract, surfaced here).
        logDecision({ decisionLogPath, decision, by: 'sakk-mcp' });
        if (decision.verdict !== 'allow')
          return refusal({
            code: decision.verdict === 'deny' ? 'POLICY_DENIED' : 'POLICY_APPROVAL_REQUIRED',
            message:
              decision.verdict === 'deny'
                ? `policy rule ${decision.ruleId ?? '(default)'} denies this action`
                : `policy requires ${decision.approversMin} distinct approver(s) — approval collection is not available over MCP`,
            decision,
          });
      }
      const r = reserve({ ledgerPath, callId: args.callId, estimatedMaxUsd: args.estimatedMaxUsd });
      return ok({
        reserved: true,
        callId: args.callId,
        estimatedMaxUsd: args.estimatedMaxUsd,
        entryStatus: r?.status ?? 'RESERVED',
      });
    }
    if (name === 'sakk_settle') {
      settle({
        ledgerPath,
        callId: args.callId,
        ...(args.failedUnknownCost ? { failedUnknownCost: true } : { actualUsd: args.actualUsd }),
      });
      return ok({ settled: true, callId: args.callId });
    }
    if (name === 'sakk_status') {
      const doc = readLedger({ ledgerPath });
      const t = totalsOf(doc);
      return ok({
        cap_usd: t.capUsd,
        settled_usd: t.settledUsd,
        outstanding_usd: t.outstandingUsd,
        committed_usd: t.committedUsd,
        max_reservable_usd: Math.max(0, t.capUsd - t.committedUsd - 1e-6),
        entries: doc.entries.length,
        reconciliation_required: doc.flags?.reconciliationRequired === true,
        policy_hash: loaded?.policyHash ?? null,
      });
    }
    return null; // unknown tool → protocol error upstream
  } catch (e) {
    if (e instanceof LedgerError || e instanceof PolicyError)
      return refusal({ code: e.code, message: e.message, details: e.details });
    throw e;
  }
}

/** Start the server on the given streams. Exported for the scripted-client
 * tests; bin/sakk.mjs wires process stdio. Startup validation (ledger path
 * required, policy loadable) happens in the CALLER — by the time this runs,
 * the configuration is known-good. */
export function startMcpServer({
  ledgerPath,
  loaded = null,
  decisionLogPath,
  input,
  output,
  version,
}) {
  const send = (o) => output.write(`${JSON.stringify(o)}\n`);
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const rpcError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  let buf = '';
  let dropping = false;
  const handleLine = (line) => {
    if (line.trim() === '') return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      rpcError(null, -32700, 'parse error: frames are one JSON-RPC object per line');
      return;
    }
    const { id, method, params } = msg ?? {};
    if (id === undefined) return; // notification — nothing to answer
    if (method === 'initialize')
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sakk', version },
      });
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const result = callTool({
        name: params?.name,
        args: params?.arguments ?? {},
        ledgerPath,
        loaded,
        decisionLogPath,
      });
      if (result === null) return rpcError(id, -32602, `unknown tool: ${params?.name}`);
      return reply(id, result);
    }
    return rpcError(id, -32601, `unknown method: ${method}`);
  };

  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (dropping) {
        dropping = false; // the oversized frame ended at this newline
        continue;
      }
      if (line.length > MAX_FRAME) {
        // the whole giant line arrived within one drain — same refusal as
        // the accumulating case below, never fed to the parser
        rpcError(null, -32600, `frame exceeds ${MAX_FRAME} bytes`);
        continue;
      }
      handleLine(line);
    }
    if (buf.length > MAX_FRAME) {
      // Oversized frame: answer a protocol error, discard until the next
      // newline, keep serving (the connection survives the flood).
      rpcError(null, -32600, `frame exceeds ${MAX_FRAME} bytes`);
      buf = '';
      dropping = true;
    }
  });
}

export { TOOLS };
