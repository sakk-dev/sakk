// SPDX-License-Identifier: AGPL-3.0-only
//
// T3 — MCP protocol torture. K `sakk mcp` servers share ONE ledger (and a
// policy); each is driven by a seeded hostile client mixing valid tool
// calls with protocol garbage: random bytes, truncated JSON, batches,
// unknown tools/methods, wrong-typed params, oversized frames, rapid-fire
// bursts. Invariants:
//   I1 no server ever exits on its own (crash = fail);
//   I2 every VALID request gets exactly one response within 10s
//      (a silent drop is a defect, not luck);
//   I3 every refusal code is from the known public set;
//   I4 the shared ledger's money invariants hold throughout and at the end;
//   I5 every decision-log line is hash-pinned and parseable.
//
//   node scripts/campaign/mcp-torture.mjs [--minutes 3] [--servers 3] [--seed N]

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { initLedger, readLedger, totalsOf } from '../../src/ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLI = join(HERE, '..', '..', 'bin', 'sakk.mjs');
const CAP = 500;

const arg = (name, env, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return Number(process.argv[i + 1]);
  if (process.env[env]) return Number(process.env[env]);
  return dflt;
};
const minutes = arg('minutes', 'SAKK_TORTURE_MINUTES', 3);
const servers = arg('servers', 'SAKK_TORTURE_SERVERS', 3);
const seed = arg('seed', 'SAKK_TORTURE_SEED', Date.now());
let s = seed >>> 0 || 1;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];

// The public refusal inventory, EXTRACTED from src/ on every run: the hand
// list it replaces missed four codes reachable over MCP (2026-10-17
// regression; prevention: a hand-written list must not stand in for 'all').
const SRC = join(ROOT, 'src');
const codesIn = (text) => [
  ...[...text.matchAll(/(?:Error\(\s*|bad\(\s*)['`]([A-Z][A-Z0-9_]{3,})/g)].map((m) => m[1]),
  // every quoted code on a `code:` line, ternaries included
  ...text
    .split('\n')
    .filter((l) => /\bcode:/.test(l))
    .flatMap((l) => [...l.matchAll(/['`]([A-Z][A-Z0-9_]{3,})['`]/g)].map((m) => m[1])),
];
const KNOWN_CODES = new Set(
  readdirSync(SRC)
    .filter((f) => f.endsWith('.mjs'))
    .flatMap((f) => codesIn(readFileSync(join(SRC, f), 'utf8'))),
);
if (KNOWN_CODES.size < 20) {
  console.error(
    `mcp-torture: only ${KNOWN_CODES.size} refusal codes extracted from src/ — extractor drifted`,
  );
  process.exit(1);
}

const POLICY = {
  schema: 'sakk-policy.v1',
  default_verdict: 'deny',
  rules: [
    { id: 'small', match: { action: 'model_call', max_estimated_usd: 2 }, verdict: 'allow' },
    { id: 'deploy', match: { action: 'deploy' }, verdict: 'require_approval', approvers_min: 2 },
  ],
};

const dir = mkdtempSync(join(tmpdir(), 'sakk-torture-'));
const ledgerPath = join(dir, 'ledger.json');
const policyPath = join(dir, 'policy.json');
initLedger({ ledgerPath, capUsd: CAP, initializedBy: 'torture-conductor' });
writeFileSync(policyPath, JSON.stringify(POLICY));

const die = (why, extra = {}) => {
  console.error(`TORTURE FAILED (seed=${seed}): ${why}`, JSON.stringify(extra), `dir=${dir}`);
  process.exit(1);
};

const stats = { valid: 0, answered: 0, refused: 0, garbage: 0, protoErrors: 0, timeouts: 0 };
let stopping = false;

function startClient(k) {
  const child = spawn(
    process.execPath,
    [CLI, 'mcp', '--ledger', ledgerPath, '--policy', policyPath],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SAKK_LEDGER_PATH: undefined, SAKK_POLICY_PATH: undefined },
    },
  );
  child.on('exit', (code, sig) => {
    if (!stopping) die(`server ${k} exited on its own`, { code, sig });
  });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (l) => {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      die(`server ${k} emitted non-JSON`, { line: l.slice(0, 120) });
    }
    if (m.id !== undefined && m.id !== null && pending.has(m.id)) {
      const { timer, resolveIt } = pending.get(m.id);
      clearTimeout(timer);
      pending.delete(m.id);
      stats.answered += 1;
      resolveIt(m);
    } else if (m.id === null) stats.protoErrors += 1;
  });

  let nextId = 1;
  let callN = 0;
  const sendValid = () =>
    new Promise((resolveIt) => {
      const id = nextId++;
      callN += 1;
      const kind = rnd();
      let params;
      if (kind < 0.55) {
        params = {
          name: 'sakk_reserve',
          arguments: {
            callId: `t${k}-${callN}`,
            estimatedMaxUsd: Math.round(rnd() * 250) / 100 + 0.01,
            agent: `torture-${k}`,
            action: pick(['model_call', 'deploy', 'rm_rf']),
            ...(rnd() < 0.3 ? { scope: pick(['docs/a.md', 'src/x.mjs']) } : {}),
          },
        };
      } else if (kind < 0.8) {
        params = {
          name: 'sakk_settle',
          arguments: {
            callId: `t${k}-${Math.max(1, callN - Math.floor(rnd() * 5))}`,
            ...(rnd() < 0.05
              ? { failedUnknownCost: true }
              : { actualUsd: Math.round(rnd() * 200) / 100 }),
          },
        };
      } else params = { name: 'sakk_status', arguments: {} };
      stats.valid += 1;
      const timer = setTimeout(() => {
        stats.timeouts += 1;
        die(`server ${k}: valid request #${id} got NO response in 10s (silent drop)`, {
          params: params.name,
        });
      }, 10_000);
      pending.set(id, { timer, resolveIt });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params })}\n`,
      );
    }).then((m) => {
      if (m.error) return; // protocol-level error with id: counted as answered
      const payload = JSON.parse(m.result.content[0].text);
      if (m.result.isError) {
        stats.refused += 1;
        if (!KNOWN_CODES.has(payload.code))
          die(`unknown refusal code over the wire`, { code: payload.code });
      }
    });

  const GARBAGE = [
    () => `${'\u0000'.repeat(1 + Math.floor(rnd() * 40))}\n`,
    () =>
      `{"jsonrpc":"2.0","id":${nextId++},"method":"tools/call","params":{"name":"sakk_reserve"\n`,
    () => `[{"jsonrpc":"2.0","id":${nextId++},"method":"ping"}]\n`,
    () => `"loose string"\n`,
    () => `12345\n`,
    () =>
      `{"jsonrpc":"2.0","id":${nextId++},"method":"${pick(['tools/steal', 'shutdown', 'eval'])}"}\n`,
    () =>
      `${JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'sakk_reserve', arguments: { callId: 42, estimatedMaxUsd: 'NaN' } } })}\n`,
    () =>
      `${JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: pick(['sakk_disable', 'rm', '']), arguments: {} } })}\n`,
    () => `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    // F-82: non-string envelope members and deep nesting — the shapes that
    // crashed the gate; the corpus only ever sent strings and flat values
    () => {
      const n = 2000 + Math.floor(rnd() * 8000);
      const deep = `${'['.repeat(n)}${']'.repeat(n)}`;
      return pick([
        `{"jsonrpc":"2.0","id":${nextId++},"method":${deep}}\n`,
        `{"jsonrpc":"2.0","id":${nextId++},"method":"tools/call","params":{"name":${deep}}}\n`,
        `{"jsonrpc":"2.0","id":${nextId++},"method":"tools/call","params":{"name":"sakk_settle","arguments":{"callId":${deep}}}}\n`,
        `{"jsonrpc":"2.0","id":${nextId++},"method":"tools/call","params":{"name":"sakk_reserve","arguments":{"callId":"d","estimatedMaxUsd":${deep},"action":"model_call"}}}\n`,
        `{"jsonrpc":"2.0","id":${deep},"method":"ping"}\n`,
      ]);
    },
  ];

  const loop = setInterval(
    () => {
      if (stopping) return clearInterval(loop);
      const r = rnd();
      if (r < 0.6) sendValid();
      else if (r < 0.95) {
        stats.garbage += 1;
        child.stdin.write(pick(GARBAGE)());
      } else {
        stats.garbage += 1;
        child.stdin.write(`${'x'.repeat((1 << 20) + 10)}\n`); // oversized flood
      }
    },
    15 + Math.floor(rnd() * 25),
  );

  return { child, pendingCount: () => pending.size };
}

const clients = Array.from({ length: servers }, (_, k) => startClient(k));

const audit = (label) => {
  const doc = readLedger({ ledgerPath, maxAgeMs: Infinity });
  const t = totalsOf(doc);
  if (t.committedUsd > CAP + 1e-6) die(`${label}: OVERSPEND`, { committed: t.committedUsd });
  const ids = new Set();
  for (const e of doc.entries) {
    if (ids.has(e.callId)) die(`${label}: duplicate entry`, { callId: e.callId });
    ids.add(e.callId);
  }
  return t;
};
const auditTick = setInterval(() => audit('mid'), 5000);

setTimeout(() => {
  stopping = true;
  clearInterval(auditTick);
  setTimeout(() => {
    for (const c of clients) c.child.kill();
    const t = audit('final');
    const decisions = `${resolve(ledgerPath)}.decisions.jsonl`;
    let decisionLines = 0;
    if (existsSync(decisions))
      for (const line of readFileSync(decisions, 'utf8').split('\n'))
        if (line) {
          decisionLines += 1;
          const d = JSON.parse(line);
          if (!/^[0-9a-f]{64}$/.test(d.policyHash))
            die('unpinned decision line', { line: line.slice(0, 120) });
        }
    console.log(
      `mcp-torture: ${minutes}min · servers=${servers} · valid=${stats.valid} answered=${stats.answered} refused=${stats.refused} garbage=${stats.garbage} protoErrors=${stats.protoErrors} timeouts=${stats.timeouts} · decisions=${decisionLines} all hash-pinned · final committed=$${t.committedUsd.toFixed(2)}/${CAP} — ALL INVARIANTS HELD (seed=${seed})`,
    );
    process.exit(0);
  }, 2000);
}, minutes * 60_000);
