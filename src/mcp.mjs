// SPDX-License-Identifier: AGPL-3.0-only
//
// MCP enforcer (specs/mcp-server/): the thinnest possible surface putting
// the ledger — and, when configured, the policy kernel — in front of any
// MCP-speaking agent. This module owns NO semantics: every refusal is a
// LedgerError/PolicyError passed through verbatim (plus the two policy
// verdict codes below); deleting the server and calling the library
// yields byte-identical books. Transport is hand-rolled newline-delimited
// JSON-RPC 2.0 over stdio — zero dependencies, like everything here.

import { reserve, settle, readLedger, totalsOf, maxReservableUsd, LedgerError } from './ledger.mjs';
import { decide, logDecision, PolicyError } from './policy.mjs';

const MAX_FRAME = 1 << 20; // 1 MiB per line (contract adversary #8)

const TOOLS = [
  {
    name: 'sakk_reserve',
    description:
      'Reserve budget BEFORE a paid action. Refuses when the cap would be reached, the callId repeats, the ledger is halted, or the configured policy says deny/require_approval. scope must be a CANONICAL relative path — normalize paths and unicode BEFORE calling; with a policy configured, aliases like prod//x are refused (without one, agent/action/scope are not evaluated and the response says so).',
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

// F-82: caller values crossed into template literals and JSON.stringify,
// which recurse per nesting level — a 10 KB nested array overflowed the
// stack and killed the gate. Echoed caller values are bounded strings;
// structures are named, never serialized.
const MAX_ECHO = 200;
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const echo = (v) =>
  typeof v === 'string' ? (v.length > MAX_ECHO ? `${v.slice(0, MAX_ECHO)}…` : v) : `<${kind(v)}>`;
const safeDetails = (d, depth = 0) => {
  if (typeof d === 'string') return echo(d);
  if (d === null || typeof d !== 'object') return d;
  if (depth >= 2) return `<${kind(d)}>`;
  if (Array.isArray(d)) return d.slice(0, 20).map((x) => safeDetails(x, depth + 1));
  return Object.fromEntries(
    Object.entries(d)
      .slice(0, 50)
      .map(([k, x]) => [k, safeDetails(x, depth + 1)]),
  );
};
const refusal = (obj) => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  isError: true,
});

const MAX_ARG_STRING = 4096;

function callTool({ name, args, ledgerPath, loaded, decisionLogPath }) {
  try {
    // Review F4: the ledger has no string caps of its own, so the enforcer
    // bounds its inputs (contract adversary #8; seam rule 2 — refusing MORE
    // than the library is always allowed, spending more never is).
    for (const f of ['callId', 'agent', 'action', 'scope'])
      if (typeof args?.[f] === 'string' && args[f].length > MAX_ARG_STRING)
        return refusal({
          code: 'MCP_ARG_TOO_LONG',
          message: `${f} exceeds ${MAX_ARG_STRING} chars — bounded inputs, bounded books`,
          details: { field: f },
        });
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
      const r = reserve({
        ledgerPath,
        callId: args.callId,
        estimatedMaxUsd: args.estimatedMaxUsd,
        agentId: args.agent,
      });
      return ok({
        reserved: true,
        callId: r.callId,
        estimatedMaxUsd: args.estimatedMaxUsd,
        ...(loaded ? {} : { policy: 'not configured — agent/action/scope were not evaluated' }),
      });
    }
    if (name === 'sakk_settle') {
      // Review F1/F2: arguments pass VERBATIM — the LIBRARY judges
      // truthiness (thinness is the contract), and the library's return
      // rides the response: a settle that just halted the whole ledger
      // must say so (R-15: a verdict carries everything its enforcement
      // needs).
      const r = settle({
        ledgerPath,
        callId: args.callId,
        actualUsd: args.actualUsd,
        failedUnknownCost: args.failedUnknownCost,
        allowReconciling: false, // a person resolves reconciliation, never the agent (N8)
      });
      return ok({
        settled: true,
        callId: r.callId,
        ...(r.duplicate ? { duplicate: true } : {}),
        ...(r.reconciliationRequired
          ? {
              reconciliationRequired: true,
              warning:
                'the ledger is now HALTED: all further reservations refuse until a named human reconciles',
            }
          : {}),
      });
    }
    if (name === 'sakk_status') {
      const doc = readLedger({ ledgerPath, maxAgeMs: Number.POSITIVE_INFINITY });
      const t = totalsOf(doc);
      return ok({
        cap_usd: t.capUsd,
        settled_usd: t.settledUsd,
        outstanding_usd: t.outstandingUsd,
        committed_usd: t.committedUsd,
        max_reservable_usd: maxReservableUsd(t),
        entries: doc.entries.length,
        reconciliation_required: doc.flags?.reconciliationRequired === true,
        halted: doc.halt?.global ?? null,
        halted_agents: doc.halt?.agents ?? {},
        policy_hash: loaded?.policyHash ?? null,
      });
    }
    return null; // unknown tool → protocol error upstream
  } catch (e) {
    if (e instanceof LedgerError || e instanceof PolicyError)
      return refusal({ code: e.code, message: echo(e.message), details: safeDetails(e.details) });
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
    let replyId = null;
    try {
      replyId = handleFrame(line, (id) => (replyId = id));
    } catch {
      // one frame's failure never takes the gate down (F-82, RC-09)
      rpcError(
        replyId,
        -32603,
        'internal error: this request was not handled; the server keeps serving',
      );
    }
  };
  const handleFrame = (line, setReplyId) => {
    if (line.trim() === '') return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      rpcError(null, -32700, 'parse error: frames are one JSON-RPC object per line');
      return;
    }
    // Review F5: a batch array or a bare JSON value is a valid parse but
    // not a request object — "never a silent drop" (contract #5).
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      rpcError(null, -32600, 'invalid request: one JSON-RPC object per line (batches unsupported)');
      return;
    }
    const { id, method, params } = msg;
    if (id === undefined) return; // notification — nothing to answer, nothing executed
    // the envelope is checked before any value is used (F-82)
    if (!(id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))))
      return rpcError(
        null,
        -32600,
        'invalid request: id must be a string, a finite number or null',
      );
    setReplyId(id);
    if (typeof method !== 'string')
      return rpcError(id, -32600, 'invalid request: method must be a string');
    if (method === 'initialize')
      return reply(id, {
        protocolVersion:
          typeof params?.protocolVersion === 'string' ? echo(params.protocolVersion) : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sakk', version },
      });
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      if (typeof params?.name !== 'string')
        return rpcError(id, -32602, 'invalid params: the tool name must be a string');
      const result = callTool({
        name: params?.name,
        args: params?.arguments ?? {},
        ledgerPath,
        loaded,
        decisionLogPath,
      });
      if (result === null) return rpcError(id, -32602, `unknown tool: ${echo(params.name)}`);
      return reply(id, result);
    }
    return rpcError(id, -32601, `unknown method: ${echo(method)}`);
  };

  input.setEncoding('utf8');
  // a final line without a newline is still a request (MCP review N5)
  input.on('end', () => {
    if (!dropping && buf.trim() !== '') handleLine(buf);
    buf = '';
  });
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
      // Oversized frame: ONE protocol error on entering the drop state
      // (review F11 — a 1GB flood is one refusal, not a thousand), discard
      // until the next newline, keep serving.
      if (!dropping) rpcError(null, -32600, `frame exceeds ${MAX_FRAME} bytes`);
      buf = '';
      dropping = true;
    }
  });
}

export { TOOLS };
