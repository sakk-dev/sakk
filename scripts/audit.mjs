#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// One-command audit against the AI-agent testing standard (v1.2), following
// its reference implementation. Every step's exit code is taken by this
// process directly — never through a pipe (standard §12.3) — and its full
// output is written to audit-logs/<stamp>/NN.log. Any red step = red audit.
//
//   npm run audit
//
// The layer map (which layers apply to Sakk and why) is docs/testing-profile.md.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const STEPS = [
  ['T0 unit + CLI suite', 'npm', ['run', '--silent', 'test']],
  ['T0 eval harness suite', 'npm', ['run', '--silent', 'test:eval']],
  ['T0 lint', 'npm', ['run', '--silent', 'lint']],
  ['T0 format', 'npm', ['run', '--silent', 'format:check']],
  ['T0 secret self-scan', node, ['bin/sakk.mjs', 'scan', '.']],
  ['T0 mutation drill', 'sh', ['scripts/mutation-drill.sh']],
  ['T0 ledger invariant fuzz', node, ['scripts/invariant-fuzz.mjs']],
  ['T0 policy invariant fuzz', node, ['scripts/policy-fuzz.mjs']],
  ['L1 invariant fuzz (packs, scan, bundle)', node, ['scripts/l1-fuzz.mjs']],
  // campaigns ran nowhere until the 2026-10-17 regression (F-80): short legs here and in CI
  ['T0 fault injection campaign', node, ['scripts/campaign/fault-injection.mjs']],
  [
    'T0 ledger soak with crash injection (12 s)',
    node,
    ['scripts/campaign/soak-ledger.mjs', '--minutes', '0.2', '--workers', '4'],
  ],
  [
    'T3 MCP protocol torture (15 s)',
    node,
    ['scripts/campaign/mcp-torture.mjs', '--minutes', '0.25', '--servers', '2'],
  ],
  ['T2 gold k=3, key cases k=5 (FAKE executor — harness only)', node, ['scripts/golden-k.mjs']],
  ['T3 attack list + ASR', node, ['scripts/attack-asr.mjs']],
  [
    '§14 findings ledger gate',
    node,
    ['--test', '--test-timeout=300000', 'test/findings-ledger.test.mjs'],
  ],
  ['§14 evolution indicators', node, ['scripts/findings-report.mjs']],
];
const NOT_APPLICABLE = [
  [
    'T1 judge',
    'Sakk has no model judge — the gold scorer is deterministic code, falsified by the drill',
  ],
  ['T4 conversation', 'Sakk gates single calls; it holds no dialogue'],
  ['T5 production', 'not deployed; no production traffic to sample or watch for drift'],
];

if (process.argv.length > 2) {
  console.error('usage: npm run audit   (no arguments)');
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logdir = join(ROOT, 'audit-logs', stamp);
mkdirSync(logdir, { recursive: true });
const rows = [];
STEPS.forEach(([name, cmd, args], i) => {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    maxBuffer: 1 << 28,
  });
  const code = r.status ?? `signal ${r.signal}`;
  const log = join(logdir, `${String(i + 1).padStart(2, '0')}.log`);
  writeFileSync(
    log,
    `$ ${cmd} ${args.join(' ')}\n\n${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}\n` : ''}`,
  );
  const secs = Math.round((Date.now() - t0) / 1000);
  rows.push({ name, code, secs, log: relative(ROOT, log) });
  console.log(
    `${code === 0 ? '✅' : '❌'} ${name}  exit ${code}  ${secs}s  ${relative(ROOT, log)}`,
  );
});
const bad = rows.filter((r) => r.code !== 0);
const verdict = bad.length === 0 ? 'ALL GREEN' : `${bad.length} step(s) RED`;
writeFileSync(
  join(logdir, 'SUMMARY.md'),
  [
    `# Audit ${stamp}`,
    '',
    'Standard: AI-agent testing standard v1.2 · profile: docs/testing-profile.md',
    'Executor mode for T2: FAKE (harness only). Real-model T2/T3: not verified (needs a model key).',
    '',
    '| Step | Exit | Seconds | Log |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (r) => `| ${r.name} | ${r.code === 0 ? '✅ 0' : `❌ ${r.code}`} | ${r.secs} | ${r.log} |`,
    ),
    '',
    '| Not applicable | Why |',
    '| --- | --- |',
    ...NOT_APPLICABLE.map(([l, w]) => `| ${l} | ${w} |`),
    '',
    `Verdict: ${verdict}`,
    '',
  ].join('\n'),
);
for (const [l, w] of NOT_APPLICABLE) console.log(`·  ${l}: not applicable — ${w}`);
console.log(`\n${verdict} → ${relative(ROOT, join(logdir, 'SUMMARY.md'))}`);
process.exit(bad.length === 0 ? 0 : 1);
