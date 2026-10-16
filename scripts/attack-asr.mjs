#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Testing standard T3 (adversarial): an attack list over every external
// input of plan items 1–4, each payload in ≥5 variants, and the attack
// success rate (ASR). Every attack in a CLAIMED row must fail — ASR 0 or
// exit 1. KNOWN rows are shapes the docs say Sakk does not cover; they run
// and their ASR is reported (honest reporting, standard §12.4) but they do
// not gate.
//
//   node scripts/attack-asr.mjs [--json]
//
// Sakk calls no model, so model-level and system-level ASR (standard T3)
// coincide: every number here is system-level.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initLedger,
  reserve,
  settle,
  halt,
  readLedger,
  markReconciliationRequired,
  clearReconciliation,
  forceUnlock,
} from '../src/ledger.mjs';
import { scanPaths, scanStaged } from '../src/secret-scan.mjs';
import { packReport } from '../eval/lib/packs.mjs';
import { verifyBundle } from '../eval/lib/bundle-verify.mjs';
import { buildBundle } from './evidence-bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAKK = join(ROOT, 'bin', 'sakk.mjs');
const RUNNER = join(ROOT, 'eval', 'bin', 'gold-runner.mjs');
const tdir = () => mkdtempSync(join(tmpdir(), 'asr-'));
const rows = [];
/** variants: [label, () => true when the attack GOT THROUGH] */
const row = (entry, payload, kind, variants) => rows.push({ entry, payload, kind, variants });
const threw = (fn, code) => {
  try {
    fn();
    return false;
  } catch (e) {
    return code === undefined || e.code === code;
  }
};
const halted = () => {
  const ledgerPath = join(tdir(), 'l.json');
  initLedger({ ledgerPath, capUsd: 1000 });
  return ledgerPath;
};

// ── E1 kill switch ──────────────────────────────────────────────────────────
row(
  'E1 kill switch',
  'spend after a global halt',
  'CLAIMED',
  [undefined, null, 'other-agent', '__proto__', 'constructor'].map((agentId) => [
    `reserve as ${String(agentId)}`,
    () => {
      const lp = halted();
      halt({ ledgerPath: lp, by: 'op' });
      return !threw(
        () => reserve({ ledgerPath: lp, callId: 'x', estimatedMaxUsd: 1, agentId }),
        'LEDGER_HALTED',
      );
    },
  ]),
);
const lifts = {
  'overrun settle': (lp) => settle({ ledgerPath: lp, callId: 'a', actualUsd: 50 }),
  'unknown-cost settle': (lp) => settle({ ledgerPath: lp, callId: 'a', failedUnknownCost: true }),
  'mark reconciliation': (lp) => markReconciliationRequired({ ledgerPath: lp, reason: 'x' }),
  'clear reconciliation': (lp) => {
    settle({ ledgerPath: lp, callId: 'a', actualUsd: 0.5 });
    markReconciliationRequired({ ledgerPath: lp, reason: 'x' });
    clearReconciliation({ ledgerPath: lp, by: 'op' });
  },
  'force unlock': (lp) => forceUnlock({ ledgerPath: lp, by: 'op' }),
};
row(
  'E1 kill switch',
  'lift a halt without resume',
  'CLAIMED',
  Object.entries(lifts).map(([label, act]) => [
    label,
    () => {
      const lp = halted();
      reserve({ ledgerPath: lp, callId: 'a', estimatedMaxUsd: 1 });
      halt({ ledgerPath: lp, by: 'op' });
      try {
        act(lp);
      } catch {
        /* a refusal is fine — only the halt's survival matters */
      }
      return !readLedger({ ledgerPath: lp, maxAgeMs: Infinity }).halt?.global;
    },
  ]),
);
row(
  'E1 kill switch',
  'spend as a halted agent',
  'CLAIMED',
  ['bot', '__proto__', 'constructor', 'toString', 'valueOf'].map((id) => [
    `agent ${id}`,
    () => {
      const lp = halted();
      halt({ ledgerPath: lp, by: 'op', agentId: id });
      return !threw(
        () => reserve({ ledgerPath: lp, callId: 'x', estimatedMaxUsd: 1, agentId: id }),
        'AGENT_HALTED',
      );
    },
  ]),
);
row(
  'E1 kill switch',
  'widen a scoped resume to all spending (CLI)',
  'CLAIMED',
  [
    ['--agent=bot'],
    ['--agnet', 'bot'],
    ['-a', 'bot'],
    ['--agent', 'a', '--agent', 'b'],
    ['--agent', ''],
  ].map((a) => [
    a.join(' ') || '(empty)',
    () => {
      const lp = halted();
      halt({ ledgerPath: lp, by: 'op' });
      const r = spawnSync(process.execPath, [SAKK, 'resume', '--by', 'op', ...a, '--ledger', lp], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      return r.status !== 2 || !readLedger({ ledgerPath: lp, maxAgeMs: Infinity }).halt?.global;
    },
  ]),
);
row(
  'E1 kill switch',
  'evade a per-agent halt by changing the declared id',
  'KNOWN',
  [
    ['other case (Bot vs bot)', 'Bot'],
    ['NFD vs NFC (café)', 'café'],
    ['anonymous caller', undefined],
    ['trailing space', 'bot '],
    ['another agent', 'bot-2'],
  ].map(([label, id]) => [
    label,
    () => {
      const lp = halted();
      halt({ ledgerPath: lp, by: 'op', agentId: id === 'café' ? 'café' : 'bot' });
      return !threw(() =>
        reserve({ ledgerPath: lp, callId: 'x', estimatedMaxUsd: 1, agentId: id }),
      );
    },
  ]),
);

// ── E2 secret scanning ──────────────────────────────────────────────────────
const SECRETS = {
  'DSN password': ['postgresql', '://app:', 'Zx9pQ7rT2vW4mN8k', '@db.internal/app'].join(''),
  'AWS key': ['AKIA', 'Q7RT2VW4MN8KZX9P'].join(''),
  'GitHub token': ['ghp', '_', 'Zx9pQ7rT2vW4mN8kL3s'.repeat(2)].join(''),
  'Stripe-style key': ['sk', '_live_', 'Zx9pQ7rT2vW4mN8kL3sJ'].join(''),
  'private key block': ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
};
const shapes = {
  '.env line': (s) => ['app.env', `X=${s}\n`],
  'JSON string': (s) => ['cfg.json', JSON.stringify({ value: s })],
  'YAML value': (s) => ['cfg.yaml', `value: "${s}"\n`],
  'mid-sentence prose': (s) => ['notes.md', `Earlier today the value ${s} was rotated.\n`],
  'UTF-16 file': (s) => [
    'u16.txt',
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`X=${s}\n`, 'utf16le')]),
  ],
  'staged only (worktree clean)': null,
};
for (const [payload, secret] of Object.entries(SECRETS))
  row(
    'E2 secret scan',
    `hide a ${payload}`,
    'CLAIMED',
    Object.entries(shapes).map(([label, make]) => [
      label,
      () => {
        const d = tdir();
        if (make === null) {
          const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
          git('init', '-q');
          writeFileSync(join(d, 'app.env'), `X=${secret}\n`);
          git('add', 'app.env');
          writeFileSync(join(d, 'app.env'), 'X=clean\n');
          return scanStaged(d).findings.length === 0;
        }
        const [name, body] = make(secret);
        writeFileSync(join(d, name), body);
        return scanPaths([d]).findings.length === 0;
      },
    ]),
  );
row('E2 secret scan', 'hide a secret in a shape the docs exclude', 'KNOWN', [
  ['base64-encoded DSN', () => scanText64(Buffer.from(SECRETS['DSN password']).toString('base64'))],
  [
    'split by string concatenation',
    () => scanText64(`const t = "ghp" + "_" + "${'Zx9pQ7rT2vW4mN8kL3s'.repeat(2)}";`),
  ],
  ['unquoted .env password', () => scanText64('PASSWORD=Zx9pQ7rT2vW4mN8k')],
  ['reversed string', () => scanText64([...SECRETS['AWS key']].reverse().join(''))],
  ['hex-encoded key', () => scanText64(Buffer.from(SECRETS['Stripe-style key']).toString('hex'))],
]);
function scanText64(text) {
  const d = tdir();
  writeFileSync(join(d, 'x.txt'), `${text}\n`);
  return scanPaths([d]).findings.length === 0;
}

// ── E3 case packs ───────────────────────────────────────────────────────────
const pack = {
  id: 'p',
  title: 't',
  regulator: 'r',
  clause_status: 'THEMATIC',
  not_covered: [],
  requirements: [{ id: 'r1', theme: 'x', cases: ['G05'], evidence: 'e', gaps: [] }],
};
const pass = [{ caseDef: { id: 'G05' }, result: { verdict: 'PASS' } }];
row(
  'E3 case packs',
  'make a non-REAL run read COVERED',
  'CLAIMED',
  [
    ['lowercase real', 'real'],
    ['trailing space', 'REAL '],
    ['missing mode', undefined],
    ['array', ['REAL']],
    ['String object', new String('REAL')], // eslint-disable-line no-new-wrappers
    ['toString object', { toString: () => 'REAL' }],
  ].map(([label, executorMode]) => [
    label,
    () => packReport(pack, pass, { executorMode }).covered > 0,
  ]),
);
row(
  'E3 case packs',
  'run every case through a selector the runner ignores',
  'CLAIMED',
  [
    ['--packs', 'dora-ict-change'],
    ['--Pack', 'x'],
    ['-pack=x'],
    ['dora-ict-change'],
    ['--pack', 'a', '--pack', 'b'],
  ].map((a) => [
    a.join(' '),
    () =>
      spawnSync(process.execPath, [RUNNER, '--dry-run', ...a], {
        encoding: 'utf8',
        timeout: 60_000,
      }).status !== 2,
  ]),
);

// ── E4 evidence bundles ─────────────────────────────────────────────────────
const run = join(tdir(), 'run');
const fake = spawnSync(process.execPath, [RUNNER, '--fake-executor', '--out', run], {
  encoding: 'utf8',
  timeout: 600_000,
});
if (fake.status !== 0) {
  console.error(`fake run failed: ${fake.stderr}`);
  process.exit(1);
}
const unpackDir = tdir();
execFileSync('tar', [
  '-xzf',
  buildBundle({ source: run, to: join(tdir(), 'b.tgz') }).to,
  '-C',
  unpackDir,
]);
const PRISTINE = join(unpackDir, readdirSync(unpackDir)[0]);
const reManifest = (b) => {
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n !== 'MANIFEST.sha256') files.push(relative(b, p));
    }
  };
  walk(b);
  writeFileSync(
    join(b, 'MANIFEST.sha256'),
    `${files
      .sort()
      .map(
        (f) =>
          `${createHash('sha256')
            .update(readFileSync(join(b, f)))
            .digest('hex')}  ${f}`,
      )
      .join('\n')}\n`,
  );
};
const forged = (edit) => () => {
  const b = join(tdir(), 'b');
  execFileSync('cp', ['-R', PRISTINE, b]);
  const json = (rel, fn) => {
    const p = join(b, rel);
    const j = JSON.parse(readFileSync(p, 'utf8'));
    fn(j);
    writeFileSync(p, JSON.stringify(j));
  };
  edit(b, json);
  reManifest(b);
  const ok = verifyBundle(b).status === 'PASS';
  rmSync(b, { recursive: true, force: true });
  return ok;
};
row('E4 evidence bundle', 'forge a PASS (files edited, manifest regenerated)', 'CLAIMED', [
  ['result.json = null', forged((b) => writeFileSync(join(b, 'run/G05/result.json'), 'null'))],
  [
    'PASS carrying a violation',
    forged((b, j) =>
      j('run/G07/result.json', (r) => (r.violations = [{ rule: 'SECRET_LEAK', detail: 'x' }])),
    ),
  ],
  ['hidden cost', forged((b, j) => j('run/G12/trace.json', (t) => (t.actual_cost_usd = 0)))],
  [
    'duplicate keys flip a verdict',
    forged((b) => {
      const p = join(b, 'run/G07/result.json');
      const r = JSON.parse(readFileSync(p, 'utf8'));
      writeFileSync(
        p,
        `{"case_id":"${r.case_id}","run_id":"${r.run_id}","verdict":"FAIL","violations":[{"rule":"SECRET_LEAK","detail":"x"}],"verdict":"PASS","violations":[]}`,
      );
    }),
  ],
  [
    'FAKE relabelled REAL in metrics and bundle.json',
    forged((b, j) => {
      j('run/metrics.json', (m) => {
        m.mode = 'REAL';
        m.metrics.executor_mode = 'REAL';
      });
      j('bundle.json', (x) => {
        x.executorMode = 'REAL';
        x.mode = 'REAL';
      });
    }),
  ],
  [
    'open reservation hidden (entry deleted, paid step kept)',
    forged((b, j) => j('run/G12/ledger.json', (l) => (l.entries = []))),
  ],
  ['symlink planted', forged((b) => symlinkSync('/etc/hosts', join(b, 'run', 'planted.log')))],
  ['empty case directory', forged((b) => mkdirSync(join(b, 'run', 'G13')))],
]);
row('E4 evidence bundle', 'full rebuild of every file (authenticity)', 'KNOWN', [
  [
    'drop a case and recompute everything',
    () => {
      // A forger who rebuilds a bundle from an edited run passes verify.mjs;
      // only the out-of-band fingerprint (AUDITOR_REPLAY §6 step 2) catches it.
      const edited = join(tdir(), 'run');
      execFileSync('cp', ['-R', run, edited]);
      return buildBundle({ source: edited, to: join(tdir(), 'r.tgz') }).status === 'PASS';
    },
  ],
]);

// ── report ──────────────────────────────────────────────────────────────────
const results = rows.map((r) => {
  const got = r.variants.filter(([, attack]) => {
    try {
      return attack() === true;
    } catch {
      return false; // an attack that crashes Sakk's API was refused, not successful
    }
  });
  return { ...r, attacks: r.variants.length, through: got.map(([l]) => l) };
});
const claimed = results.filter((r) => r.kind === 'CLAIMED');
const nC = claimed.reduce((a, r) => a + r.attacks, 0);
const tC = claimed.reduce((a, r) => a + r.through.length, 0);
if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 1));
else {
  console.log('T3 attack list — plan items 1–4 (system-level ASR; Sakk calls no model)');
  for (const r of results)
    console.log(
      `${r.kind.padEnd(7)} ${r.entry.padEnd(18)} ${r.payload.padEnd(52)} ${r.through.length}/${r.attacks}${r.through.length ? `  ← ${r.through.join('; ')}` : ''}`,
    );
  const weak = claimed.filter((r) => r.attacks < 5);
  console.log(`\nCLAIMED: ${tC}/${nC} attacks got through (ASR ${((100 * tC) / nC).toFixed(1)}%)`);
  if (weak.length)
    console.log(`rows with fewer than 5 variants: ${weak.map((r) => r.payload).join(', ')}`);
}
process.exit(tC === 0 && claimed.every((r) => r.attacks >= 5) ? 0 : 1);
