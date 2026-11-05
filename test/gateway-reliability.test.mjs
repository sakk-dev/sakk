// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The gateway's two reliability fixes, driven from Node so the findings proof can
 * run them (F-242, F-243). The full suite for the gateway is Python and needs
 * LiteLLM (the CI `gateway` job). Here the real sakk_gateway.py runs under plain
 * python3: the three names it imports from LiteLLM, FastAPI and PyYAML are given
 * small stand-ins, and nothing else of theirs is used by the code under test.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY = join(ROOT, 'integrations', 'litellm', 'sakk_gateway.py');
const SAKK_BIN = join(ROOT, 'bin', 'sakk.mjs');

/** True when python3 (3.9 or newer, for asyncio.to_thread) can run here. */
const HAS_PY =
  spawnSync('python3', ['-c', 'import sys; sys.exit(sys.version_info < (3, 9))'], {
    timeout: 10_000,
  }).status === 0;
const NO_PY = !HAS_PY && 'python3 3.9 or newer is not installed';

const STUBS = {
  'yaml.py': 'import json\n\n\ndef safe_load(f):\n    return json.load(f)\n',
  'fastapi.py': [
    'class HTTPException(Exception):',
    '    def __init__(self, status_code, detail=None, headers=None):',
    '        super().__init__(status_code, detail)',
    '        self.status_code = status_code',
    '        self.detail = detail',
    '',
  ].join('\n'),
  'litellm/__init__.py': '',
  'litellm/integrations/__init__.py': '',
  'litellm/integrations/custom_logger.py':
    'class CustomLogger:\n    def __init__(self, *args, **kwargs):\n        pass\n',
};

const DRIVER = `
import asyncio, importlib.util, json, math, sys
cfg = json.loads(sys.argv[1])
sys.path.insert(0, cfg["stubs"])
spec = importlib.util.spec_from_file_location("sakk_gateway", cfg["gateway"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
h = mod.handler

def req():
    return {"model": "mock-ok", "messages": [{"role": "user", "content": "hi"}]}

async def queued():
    sent = []
    class Proc:
        returncode = None
        def kill(self):
            self.returncode = -9
    async def start():
        h.client._proc = Proc()
    async def rpc(method, params):
        sent.append(params.get("name"))
        await asyncio.sleep(30)  # the ledger never answers
    h.client._start = start
    h.client._rpc = rpc
    h._next_sweep = math.inf  # this run is about the reserve, not the sweep
    out = await asyncio.gather(*(h.async_pre_call_hook(None, None, req(), "acompletion") for _ in range(5)))
    return {"sent": sent, "unmetered": [bool(d["metadata"].get("sakk_unmetered")) for d in out]}

async def expiry():
    mod.SWEEP_EVERY_S = 0
    try:
        first = await h.async_pre_call_hook(None, None, req(), "acompletion")
        await asyncio.sleep(cfg["wait_s"])
        second = await h.async_pre_call_hook(None, None, req(), "acompletion")
        task = getattr(h, "_sweep_task", None)
        if task is not None:
            await task
        return {"old": first["metadata"]["sakk_call_id"], "new": second["metadata"]["sakk_call_id"]}
    finally:
        proc = h.client._proc
        h.client.close()
        if proc is not None:
            await proc.wait()

print(json.dumps(asyncio.run({"queued": queued, "expiry": expiry}[cfg["scenario"]]())))
`;

/** A temp HOME, a ledger with a $1 cap, a priced model and the stand-in modules. */
function stack(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sakk-gw-node-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const stubs = join(dir, 'stubs');
  for (const [name, body] of Object.entries(STUBS)) {
    mkdirSync(dirname(join(stubs, name)), { recursive: true });
    writeFileSync(join(stubs, name), body);
  }
  const config = join(dir, 'config.yaml');
  const params = { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 };
  writeFileSync(
    config,
    JSON.stringify({
      model_list: [
        { model_name: 'mock-ok', litellm_params: { model: 'openai/mock-ok', ...params } },
      ],
    }),
  );
  mkdirSync(home);
  const ledger = join(dir, 'ledger.json');
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    SAKK_HOME: join(home, '.sakk'),
  };
  const init = spawnSync(
    process.execPath,
    [SAKK_BIN, 'init', '--cap', '1', '--ledger', ledger, '--by', 'gateway-test'],
    { env, encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(init.status, 0, init.stderr);
  /** Run one scenario of DRIVER against the gateway; returns its JSON answer. */
  const run = (scenario, extraEnv, extra = {}) => {
    const r = spawnSync(
      'python3',
      ['-I', '-B', '-c', DRIVER, JSON.stringify({ stubs, gateway: GATEWAY, scenario, ...extra })],
      {
        env: {
          ...env,
          SAKK_NODE: process.execPath,
          SAKK_BIN,
          SAKK_LEDGER: ledger,
          SAKK_GATEWAY_CONFIG: config,
          SAKK_GATEWAY_STATUS: join(dir, 'gateway-status.json'),
          SAKK_DEFAULT_MAX_TOKENS: '100',
          SAKK_ON_UNAVAILABLE: 'allow',
          ...extraEnv,
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    assert.equal(r.status, 0, `the gateway run failed:\n${r.stderr.slice(-3000)}`);
    return { ...JSON.parse(r.stdout), stderr: r.stderr };
  };
  return { ledger, run };
}

test(
  'once one gateway reserve times out, the reserves queued behind it fail fast instead of each waiting out the timeout (F-243)',
  { skip: NO_PY },
  (t) => {
    const s = stack(t);
    const out = s.run('queued', { SAKK_TIMEOUT_S: '0.2' });
    // five calls at once, one ledger that never answers: only the first is sent.
    // Counted, not timed (F-62): a queued call that waited out its own timeout
    // sent its own reserve first.
    assert.deepEqual(
      out.sent,
      ['sakk_reserve'],
      `each queued call waited out its own timeout:\n${out.stderr.slice(-1500)}`,
    );
    assert.deepEqual(
      out.unmetered,
      [true, true, true, true, true],
      'allow mode lets each one pass',
    );
  },
);

test(
  'a gateway reservation nobody settles is settled at its worst case once it outlives SAKK_RESERVATION_TTL_S (F-242)',
  { skip: NO_PY },
  (t) => {
    const s = stack(t);
    // the real sakk mcp and a real ledger: the settle has to land in the books
    const { old, new: fresh } = s.run('expiry', { SAKK_RESERVATION_TTL_S: '1' }, { wait_s: 1.5 });
    const entries = Object.fromEntries(
      JSON.parse(readFileSync(s.ledger, 'utf8')).entries.map((e) => [e.callId, e]),
    );
    assert.equal(entries[old]?.status, 'SETTLED', 'the stuck reservation was never released');
    assert.equal(
      entries[old].actualUsd,
      entries[old].estimatedMaxUsd,
      'booked at the most it could cost',
    );
    // control: the sweep does not settle everything it sees
    assert.equal(entries[fresh]?.status, 'RESERVED', 'a fresh reservation is left alone');
  },
);
