import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { initLedger, reserve, settle, readLedger, halt } from '../src/ledger.mjs';

/** Contract tests for the MCP enforcer (specs/mcp-server/contract.md):
 * every adversary row drives the REAL server binary over REAL stdio
 * frames — a scripted fake agent, the same philosophy as the eval
 * harness's fake executors. */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'sakk.mjs');
const tdir = () => mkdtempSync(join(tmpdir(), 'sakk-mcp-'));

const POLICY = {
  schema: 'sakk-policy.v1',
  default_verdict: 'deny',
  rules: [
    { id: 'small-ok', match: { action: 'model_call', max_estimated_usd: 1 }, verdict: 'allow' },
    {
      id: 'deploy-four-eyes',
      match: { action: 'deploy' },
      verdict: 'require_approval',
      approvers_min: 2,
    },
    {
      id: 'docs-ok',
      match: { action: 'file_write', scope: ['docs/'], max_estimated_usd: 1 },
      verdict: 'allow',
    },
  ],
};

/** Spawns `sakk mcp`, speaks newline JSON-RPC, resolves responses by id. */
function client({ ledgerPath, policyPath }) {
  const args = [CLI, 'mcp', '--ledger', ledgerPath];
  if (policyPath) args.push('--policy', policyPath);
  const child = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SAKK_LEDGER_PATH: undefined, SAKK_POLICY_PATH: undefined },
  });
  const pending = new Map();
  const errors = [];
  createInterface({ input: child.stdout }).on('line', (l) => {
    try {
      const m = JSON.parse(l);
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      } else if (m.id === null) errors.push(m);
    } catch {
      /* non-JSON noise is itself a failure surfaced by timeouts */
    }
  });
  let nextId = 1;
  const call = (method, params, { raw } = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method} #${id}`)), 8000);
      pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      child.stdin.write(raw ?? `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const tool = async (name, args2) => {
    const m = await call('tools/call', { name, arguments: args2 });
    if (m.error) return { rpcError: m.error };
    const payload = JSON.parse(m.result.content[0].text);
    return { isError: m.result.isError === true, payload };
  };
  return { child, call, tool, errors, writeRaw: (s) => child.stdin.write(s) };
}

const children = [];
const mk = (opts) => {
  const c = client(opts);
  children.push(c.child);
  return c;
};
after(() => children.forEach((c) => c.kill()));

describe('MCP enforcer: protocol surface', () => {
  test('initialize → tools/list exposes exactly the three tools (the whole attack surface)', async () => {
    const d = tdir();
    const ledgerPath = join(d, 'l.json');
    initLedger({ ledgerPath, capUsd: 10 });
    const c = mk({ ledgerPath });
    const init = await c.call('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.result.serverInfo.name, 'sakk');
    const list = await c.call('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [
      'sakk_reserve',
      'sakk_settle',
      'sakk_status',
    ]);
  });
  test('garbage line, unknown method and unknown tool answer errors — and the server SURVIVES', async () => {
    const d = tdir();
    const ledgerPath = join(d, 'l.json');
    initLedger({ ledgerPath, capUsd: 10 });
    const c = mk({ ledgerPath });
    c.writeRaw('this is not json\n');
    const bad = await c.call('no/such/method', {});
    assert.equal(bad.error.code, -32601);
    const badTool = await c.call('tools/call', { name: 'sakk_disable_policy', arguments: {} });
    assert.equal(badTool.error.code, -32602);
    const status = await c.tool('sakk_status', {});
    assert.equal(status.isError, false, 'server must keep serving after garbage');
    assert.ok(
      c.errors.some((e) => e.error.code === -32700),
      'parse error was reported',
    );
  });
  test('F5: batch arrays and bare JSON values answer -32600 — never a silent drop', async () => {
    const d = tdir();
    const ledgerPath = join(d, 'l.json');
    initLedger({ ledgerPath, capUsd: 10 });
    const c = mk({ ledgerPath });
    for (const frame of ['[{"jsonrpc":"2.0","id":77,"method":"ping"}]', '"str"', '42', 'null'])
      c.writeRaw(`${frame}\n`);
    const st = await c.tool('sakk_status', {});
    assert.equal(st.isError, false);
    assert.equal(c.errors.filter((e) => e.error.code === -32600).length, 4);
  });
  test('an oversized frame answers -32600 and the next call still works', async () => {
    const d = tdir();
    const ledgerPath = join(d, 'l.json');
    initLedger({ ledgerPath, capUsd: 10 });
    const c = mk({ ledgerPath });
    c.writeRaw(`${'x'.repeat((1 << 20) + 50)}\n`);
    const status = await c.tool('sakk_status', {});
    assert.equal(status.isError, false);
    assert.equal(
      c.errors.filter((e) => e.error.code === -32600).length,
      1,
      'one flood, ONE refusal (review F11)',
    );
  });
});

describe('MCP enforcer: money semantics are the ledger, verbatim', () => {
  test('reserve → settle → status; duplicate callId refuses with the LEDGER code; one entry', async () => {
    const d = tdir();
    const ledgerPath = join(d, 'l.json');
    initLedger({ ledgerPath, capUsd: 10 });
    const c = mk({ ledgerPath });
    const r1 = await c.tool('sakk_reserve', { callId: 'a', estimatedMaxUsd: 1 });
    assert.equal(r1.isError, false);
    const dup = await c.tool('sakk_reserve', { callId: 'a', estimatedMaxUsd: 1 });
    assert.equal(dup.isError, true);
    assert.equal(dup.payload.code, 'DUPLICATE_CALL_ID');
    const s = await c.tool('sakk_settle', { callId: 'a', actualUsd: 0.4 });
    assert.equal(s.isError, false);
    const st = await c.tool('sakk_status', {});
    assert.equal(st.payload.settled_usd, 0.4);
    assert.equal(st.payload.entries, 1);
    assert.equal(readLedger({ ledgerPath }).entries.length, 1);
  });
  test('F1 attack: a settle that HALTS the ledger says so — never a bare settled:true', async () => {
    const d = tdir();
    const ledgerPath = join(d, 'l.json');
    initLedger({ ledgerPath, capUsd: 10 });
    const c = mk({ ledgerPath });
    await c.tool('sakk_reserve', { callId: 'u', estimatedMaxUsd: 1 });
    const s = await c.tool('sakk_settle', { callId: 'u', failedUnknownCost: true });
    assert.equal(s.isError, false);
    assert.equal(s.payload.reconciliationRequired, true, 'the halt must ride the response (R-15)');
    const next = await c.tool('sakk_reserve', { callId: 'v', estimatedMaxUsd: 1 });
    assert.equal(next.isError, true);
    assert.equal(next.payload.code, 'RECONCILIATION_REQUIRED');
  });
  test('F2 attack: truthy-but-not-true failedUnknownCost behaves EXACTLY like the library', async () => {
    const d = tdir();
    const viaMcp = join(d, 'mcp.json');
    const viaLib = join(d, 'lib.json');
    initLedger({ ledgerPath: viaMcp, capUsd: 10 });
    initLedger({ ledgerPath: viaLib, capUsd: 10 });
    const c = mk({ ledgerPath: viaMcp });
    await c.tool('sakk_reserve', { callId: 'w', estimatedMaxUsd: 1 });
    reserve({ ledgerPath: viaLib, callId: 'w', estimatedMaxUsd: 1 });
    const viaMcpResp = await c.tool('sakk_settle', { callId: 'w', failedUnknownCost: 'false' });
    let libCode = null;
    try {
      settle({ ledgerPath: viaLib, callId: 'w', failedUnknownCost: 'false' });
    } catch (e) {
      libCode = e.code;
    }
    if (libCode === null) {
      assert.equal(viaMcpResp.isError, false, 'library accepted — MCP must too');
    } else {
      assert.equal(viaMcpResp.isError, true, 'library refused — MCP must too');
      assert.equal(viaMcpResp.payload.code, libCode);
    }
    const entryOf = (lp) => readLedger({ ledgerPath: lp }).entries[0];
    assert.equal(entryOf(viaMcp).status, entryOf(viaLib).status, 'books must not diverge');
    assert.equal(
      readLedger({ ledgerPath: viaMcp }).flags?.reconciliationRequired === true,
      readLedger({ ledgerPath: viaLib }).flags?.reconciliationRequired === true,
    );
  });
  test('settle without reserve refuses with the ledger code; nothing invented', async () => {
    const d = tdir();
    const ledgerPath = join(d, 'l.json');
    initLedger({ ledgerPath, capUsd: 10 });
    const c = mk({ ledgerPath });
    const s = await c.tool('sakk_settle', { callId: 'ghost', actualUsd: 1 });
    assert.equal(s.isError, true);
    assert.equal(readLedger({ ledgerPath }).entries.length, 0);
  });
  test('thinness: the same sequence through the library yields identical books', async () => {
    const d = tdir();
    const viaMcp = join(d, 'mcp.json');
    const viaLib = join(d, 'lib.json');
    initLedger({ ledgerPath: viaMcp, capUsd: 10 });
    initLedger({ ledgerPath: viaLib, capUsd: 10 });
    const c = mk({ ledgerPath: viaMcp });
    await c.tool('sakk_reserve', { callId: 'x', estimatedMaxUsd: 2 });
    await c.tool('sakk_settle', { callId: 'x', actualUsd: 1.5 });
    reserve({ ledgerPath: viaLib, callId: 'x', estimatedMaxUsd: 2 });
    settle({ ledgerPath: viaLib, callId: 'x', actualUsd: 1.5 });
    const strip = (p) =>
      readLedger({ ledgerPath: p }).entries.map(
        ({ callId, status, estimatedMaxUsd, actualUsd }) => ({
          callId,
          status,
          estimatedMaxUsd,
          actualUsd,
        }),
      );
    assert.deepEqual(strip(viaMcp), strip(viaLib));
  });
});

describe('MCP enforcer: bounded inputs (F4)', () => {
  test('a 900KB callId refuses MCP_ARG_TOO_LONG and the books stay small', async () => {
    const d = tdir();
    const ledgerPath = join(d, 'l.json');
    initLedger({ ledgerPath, capUsd: 10 });
    const c = mk({ ledgerPath });
    const r = await c.tool('sakk_reserve', { callId: 'x'.repeat(900_000), estimatedMaxUsd: 1 });
    assert.equal(r.isError, true);
    assert.equal(r.payload.code, 'MCP_ARG_TOO_LONG');
    assert.equal(readLedger({ ledgerPath }).entries.length, 0);
  });
});

describe('MCP enforcer: the policy gate', () => {
  const setup = () => {
    const d = tdir();
    const ledgerPath = join(d, 'l.json');
    const policyPath = join(d, 'policy.json');
    initLedger({ ledgerPath, capUsd: 10 });
    writeFileSync(policyPath, JSON.stringify(POLICY));
    return { d, ledgerPath, policyPath, decisions: `${ledgerPath}.decisions.jsonl` };
  };
  test('allow reserves; THREE denied retries = three refusals, three log lines, ZERO entries', async () => {
    const { ledgerPath, policyPath, decisions } = setup();
    const c = mk({ ledgerPath, policyPath });
    const okCall = await c.tool('sakk_reserve', {
      callId: 'ok1',
      estimatedMaxUsd: 0.5,
      agent: 'dev',
      action: 'model_call',
    });
    assert.equal(okCall.isError, false);
    for (let i = 0; i < 3; i++) {
      const r = await c.tool('sakk_reserve', {
        callId: `bad${i}`,
        estimatedMaxUsd: 0.5,
        agent: 'dev',
        action: 'rm_rf',
      });
      assert.equal(r.isError, true);
      assert.equal(r.payload.code, 'POLICY_DENIED');
    }
    const entries = readLedger({ ledgerPath }).entries;
    assert.equal(entries.length, 1, 'denied retries never touch the ledger');
    assert.equal(entries[0].agentId, 'dev', 'agent identity reaches the books');
    const lines = readFileSync(decisions, 'utf8').trim().split('\n');
    assert.equal(lines.length, 4, 'every decision logged, allow and deny alike');
    assert.ok(lines.every((l) => /"policyHash":"[0-9a-f]{64}"/.test(l)));
  });
  test('require_approval refuses carrying approversMin — approval is NOT collectable here', async () => {
    const { ledgerPath, policyPath } = setup();
    const c = mk({ ledgerPath, policyPath });
    const r = await c.tool('sakk_reserve', {
      callId: 'dep',
      estimatedMaxUsd: 0.5,
      agent: 'dev',
      action: 'deploy',
    });
    assert.equal(r.isError, true);
    assert.equal(r.payload.code, 'POLICY_APPROVAL_REQUIRED');
    assert.equal(r.payload.decision.approversMin, 2);
    assert.equal(readLedger({ ledgerPath }).entries.length, 0);
  });
  test('F2 at the wire: a scope alias refuses CONTEXT_INVALID, nothing reserved', async () => {
    const { ledgerPath, policyPath } = setup();
    const c = mk({ ledgerPath, policyPath });
    const r = await c.tool('sakk_reserve', {
      callId: 'al',
      estimatedMaxUsd: 0.5,
      agent: 'dev',
      action: 'file_write',
      scope: 'docs//x',
    });
    assert.equal(r.isError, true);
    assert.equal(r.payload.code, 'CONTEXT_INVALID');
    assert.equal(readLedger({ ledgerPath }).entries.length, 0);
  });
  test('status carries the policy hash when configured', async () => {
    const { ledgerPath, policyPath } = setup();
    const c = mk({ ledgerPath, policyPath });
    const st = await c.tool('sakk_status', {});
    assert.match(st.payload.policy_hash, /^[0-9a-f]{64}$/);
  });
});

describe('MCP enforcer: kill switch (specs/kill-switch rows 1 and 7)', () => {
  test('a halted ledger refuses over MCP with LEDGER_HALTED; status shows who stopped it', async () => {
    const d = tdir();
    const ledgerPath = join(d, 'l.json');
    initLedger({ ledgerPath, capUsd: 10 });
    halt({ ledgerPath, by: 'maintainer', reason: 'incident' });
    const c = mk({ ledgerPath });
    const r = await c.tool('sakk_reserve', { callId: 'h1', estimatedMaxUsd: 1 });
    assert.equal(r.isError, true);
    assert.equal(r.payload.code, 'LEDGER_HALTED');
    const st = await c.tool('sakk_status', {});
    assert.equal(st.payload.halted.by, 'maintainer');
  });
  test('row 7: no MCP tool can halt or resume — an agent cannot lift its own stop', async () => {
    const d = tdir();
    const ledgerPath = join(d, 'l.json');
    initLedger({ ledgerPath, capUsd: 10 });
    const c = mk({ ledgerPath });
    const list = await c.call('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.ok(!names.some((n) => /halt|resume|unlock|reconcile/.test(n)), names.join(','));
    const tried = await c.call('tools/call', { name: 'sakk_resume', arguments: { by: 'agent' } });
    assert.equal(tried.error.code, -32602);
  });
});

describe('MCP enforcer: startup is fail-closed', () => {
  test('no ledger path → MCP_LEDGER_PATH_REQUIRED, exit 2', () => {
    const r = spawnSync(process.execPath, [CLI, 'mcp'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, SAKK_LEDGER_PATH: '' },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /MCP_LEDGER_PATH_REQUIRED/);
  });
  test('a vacuous policy refuses to START — never "runs without policy"', () => {
    const d = tdir();
    const ledgerPath = join(d, 'l.json');
    initLedger({ ledgerPath, capUsd: 10 });
    const bad = join(d, 'bad.json');
    writeFileSync(
      bad,
      JSON.stringify({ schema: 'sakk-policy.v1', default_verdict: 'allow', rules: [] }),
    );
    const r = spawnSync(process.execPath, [CLI, 'mcp', '--ledger', ledgerPath, '--policy', bad], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /POLICY_VACUOUS_ALLOW/);
  });
  test('F8: SAKK_POLICY_PATH set-but-empty refuses to start — never a silently ungated server', () => {
    const d = tdir();
    const ledgerPath = join(d, 'l.json');
    initLedger({ ledgerPath, capUsd: 10 });
    const r = spawnSync(process.execPath, [CLI, 'mcp', '--ledger', ledgerPath], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, SAKK_POLICY_PATH: '' },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /POLICY_UNREADABLE/);
  });
  test('F10: --ledger beats a different SAKK_LEDGER_PATH (flag wins)', async () => {
    const d = tdir();
    const flagLedger = join(d, 'flag.json');
    const envLedger = join(d, 'env.json');
    initLedger({ ledgerPath: flagLedger, capUsd: 10 });
    initLedger({ ledgerPath: envLedger, capUsd: 10 });
    const child = spawn(process.execPath, [CLI, 'mcp', '--ledger', flagLedger], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SAKK_LEDGER_PATH: envLedger },
    });
    children.push(child);
    const rl = createInterface({ input: child.stdout });
    const resp = new Promise((res) => rl.on('line', (l) => res(JSON.parse(l))));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sakk_reserve', arguments: { callId: 'f', estimatedMaxUsd: 1 } } })}\n`,
    );
    await resp;
    assert.equal(readLedger({ ledgerPath: flagLedger }).entries.length, 1);
    assert.equal(readLedger({ ledgerPath: envLedger }).entries.length, 0);
  });
  test('F10: an unwritable decision log refuses the action and the ledger stays untouched', async () => {
    const d = tdir();
    const ledgerPath = join(d, 'l.json');
    const policyPath = join(d, 'policy.json');
    initLedger({ ledgerPath, capUsd: 10 });
    writeFileSync(policyPath, JSON.stringify(POLICY));
    mkdirSync(`${ledgerPath}.decisions.jsonl`);
    const c = mk({ ledgerPath, policyPath });
    const r = await c.tool('sakk_reserve', {
      callId: 'dl',
      estimatedMaxUsd: 0.5,
      agent: 'dev',
      action: 'model_call',
    });
    assert.equal(r.isError, true);
    assert.equal(r.payload.code, 'DECISION_UNLOGGABLE');
    assert.equal(readLedger({ ledgerPath }).entries.length, 0);
  });
  test('missing ledger FILE refuses on first use with the ledger code (never auto-creates)', async () => {
    const d = tdir();
    const ledgerPath = join(d, 'never-created.json');
    const c = mk({ ledgerPath });
    const r = await c.tool('sakk_reserve', { callId: 'x', estimatedMaxUsd: 1 });
    assert.equal(r.isError, true);
    assert.equal(r.payload.code, 'LEDGER_MISSING');
    assert.equal(existsSync(ledgerPath), false);
  });
});
