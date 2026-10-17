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
import { loadPolicy, decide } from '../src/policy.mjs';
import { childEnv } from '../eval/lib/exec-env.mjs';
import { packReport } from '../eval/lib/packs.mjs';
import { verifyBundle } from '../eval/lib/bundle-verify.mjs';
import { buildBundle } from './evidence-bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAKK = join(ROOT, 'bin', 'sakk.mjs');
const RUNNER = join(ROOT, 'eval', 'bin', 'gold-runner.mjs');
const tdir = () => mkdtempSync(join(tmpdir(), 'asr-'));
const T3 = JSON.parse(readFileSync(join(ROOT, 'eval', 'thresholds.json'), 'utf8')).T3;
/**
 * Standard §6: every payload names its attack TARGET (what the attacker
 * wants) and its SUCCESS SIGNATURE (the observable fact that means it got
 * through — exactly what each variant's function checks).
 */
const DESCRIBED = {
  'spend after a global halt': [
    'spend money after an operator stopped all spending',
    'reserve() returns without LEDGER_HALTED',
  ],
  'lift a halt without resume': [
    'reopen spending through an ordinary money path',
    'the ledger no longer carries halt.global after the path ran',
  ],
  'spend as a halted agent': [
    'spend as an agent an operator stopped',
    'reserve() for that id returns without AGENT_HALTED',
  ],
  'widen a scoped resume to all spending (CLI)': [
    'turn "resume one agent" into "resume everything"',
    'the CLI exits other than 2, or halt.global is gone',
  ],
  'evade a per-agent halt by changing the declared id': [
    'keep spending after a per-agent stop by declaring another id',
    'reserve() succeeds under the changed id',
  ],
  'hide a ': [
    'commit a recognized secret without the scanner noticing',
    'zero findings for a text or staged blob that holds the secret',
  ],
  'hide a secret in a shape the docs exclude': [
    'commit a secret in a shape outside the recognized formats',
    'zero findings (documented non-coverage)',
  ],
  'make a non-REAL run read COVERED': [
    'sell a harness-only run as compliance evidence',
    'packReport().covered > 0 for a mode other than exactly "REAL"',
  ],
  'run every case through a selector the runner ignores': [
    'make the runner do something other than asked',
    'the runner exits other than 2 on an argument it does not know',
  ],
  'forge a PASS (files edited, manifest regenerated)': [
    'make an auditor read PASS for evidence that says otherwise',
    'verifyBundle().status === "PASS" after the edit',
  ],
  'full rebuild of every file (authenticity)': [
    'pass off a rebuilt bundle as the issued one',
    'verify.mjs reads PASS (only the out-of-band fingerprint catches it)',
  ],
  'spend past the cap or outside the books': [
    'spend more than the cap allows, or spend the books do not hold',
    'reserve() is granted at or past the cap, from a pathological ledger or input, or a reservation lands in a forked copy',
  ],
  'get a refused request allowed (deny-default policy)': [
    'make the policy kernel allow what the policy refuses',
    'decide().verdict === "allow" for a request the deny-default policy does not allow',
  ],
  'dodge a deny under an allow-default policy': [
    'slip past a deny that the policy author wrote',
    'decide().verdict === "allow" by omitting the constrained field or using a case alias (documented in README)',
  ],
  'spend or lift a stop through the agent channel': [
    'use the MCP tools to spend past the gate, settle what a person must, or kill the gate',
    'a refused reservation is booked, a reconciliation entry settles, or the server exits',
  ],
  'turn a failing suite green from the operator environment': [
    'make the judge read a failing verification as green',
    'a child `node --test` of a failing suite, spawned with childEnv(), exits 0',
  ],
  'flip a runner-recorded fact the files cannot contradict (harness_dirty)': [
    'present a run from a modified harness as a clean one',
    'verifyBundle().status === "PASS" after harness_dirty true → false (only the out-of-band fingerprint catches it)',
  ],
};
const describeRow = (payload) =>
  DESCRIBED[payload] ??
  Object.entries(DESCRIBED).find(([k]) => k.endsWith(' ') && payload.startsWith(k))?.[1];
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
  // F-65: a coherent REAL relabel — every trace, label and metric agrees —
  // with the one key that names the model deleted
  [
    'coherent REAL relabel with the model id deleted',
    forged((b, j) => {
      for (const id of readdirSync(join(b, 'run')).filter((x) => /^G\d+$/.test(x)))
        j(`run/${id}/trace.json`, (t) => {
          t.model_provider = 'anthropic';
          t.model_id = 'claude-production';
        });
      j('run/metrics.json', (m) => {
        m.mode = 'REAL';
        delete m.model_id;
        m.harness_dirty = false;
        Object.assign(m.metrics, {
          executor_mode: 'REAL',
          fake_executor_case_pass_rate: null,
          real_model_case_pass_rate: 1,
          real_model_case_status: 'RUN',
          real_model_called: true,
        });
      });
      j('bundle.json', (x) => {
        x.executorMode = 'REAL';
        x.mode = 'REAL';
      });
    }),
  ],
  [
    'harness_dirty deleted from metrics.json',
    forged((b, j) => j('run/metrics.json', (m) => delete m.harness_dirty)),
  ],
]);
row(
  'E4 evidence bundle',
  'flip a runner-recorded fact the files cannot contradict (harness_dirty)',
  'KNOWN',
  [
    [
      'harness_dirty true → false on a REAL relabel',
      forged((b, j) => {
        for (const id of readdirSync(join(b, 'run')).filter((x) => /^G\d+$/.test(x)))
          j(`run/${id}/trace.json`, (t) => {
            t.model_provider = 'anthropic';
            t.model_id = 'claude-x';
          });
        j('run/metrics.json', (m) => {
          m.mode = 'REAL';
          m.model_id = 'claude-x';
          m.harness_dirty = false; // was true: the forger flips it
          Object.assign(m.metrics, {
            executor_mode: 'REAL',
            fake_executor_case_pass_rate: null,
            real_model_case_pass_rate: 1,
            real_model_case_status: 'RUN',
            real_model_called: true,
          });
        });
        j('bundle.json', (x) => {
          x.executorMode = 'REAL';
          x.mode = 'REAL';
        });
      }),
    ],
  ],
);
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

// ── E5–E8: the original modules (2026-10-17 regression: T3 covered only
// the four plan items, so "0 attacks got through" said nothing about the
// ledger core, the policy kernel, the MCP enforcer or the gold harness) ───
const capped = (cap = 1) => {
  const lp = join(tdir(), 'l.json');
  initLedger({ ledgerPath: lp, capUsd: cap });
  return lp;
};
const granted = (fn) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};
const editBooks = (lp, fn) => {
  const d = JSON.parse(readFileSync(lp, 'utf8'));
  fn(d);
  writeFileSync(lp, JSON.stringify(d));
};
row('E5 ledger core', 'spend past the cap or outside the books', 'CLAIMED', [
  [
    'reserve exactly the cap',
    () => granted(() => reserve({ ledgerPath: capped(1), callId: 'a', estimatedMaxUsd: 1 })),
  ],
  [
    'ten 0.1 against a 1.0 cap (float drift)',
    () => {
      const lp = capped(1);
      let ok = 0;
      for (let i = 0; i < 10; i += 1)
        if (granted(() => reserve({ ledgerPath: lp, callId: `c${i}`, estimatedMaxUsd: 0.1 })))
          ok += 1;
      return ok === 10;
    },
  ],
  [
    'negative estimate',
    () => granted(() => reserve({ ledgerPath: capped(), callId: 'a', estimatedMaxUsd: -5 })),
  ],
  [
    'estimate as a string',
    () => granted(() => reserve({ ledgerPath: capped(), callId: 'a', estimatedMaxUsd: '0.5' })),
  ],
  [
    'NaN estimate',
    () => granted(() => reserve({ ledgerPath: capped(), callId: 'a', estimatedMaxUsd: NaN })),
  ],
  [
    'same callId again after settling',
    () => {
      const lp = capped(10);
      reserve({ ledgerPath: lp, callId: 'a', estimatedMaxUsd: 1 });
      settle({ ledgerPath: lp, callId: 'a', actualUsd: 0.5 });
      return granted(() => reserve({ ledgerPath: lp, callId: 'a', estimatedMaxUsd: 1 }));
    },
  ],
  [
    'a hand-edited negative entry frees cap',
    () => {
      const lp = capped(1);
      editBooks(lp, (d) =>
        d.entries.push({ callId: 'n', estimatedMaxUsd: -1000, createdAt: 'x', status: 'RESERVED' }),
      );
      return granted(() => reserve({ ledgerPath: lp, callId: 'b', estimatedMaxUsd: 0.5 }));
    },
  ],
  [
    'two reservations through a symlinked ledger file',
    () => {
      const lp = capped(10);
      const alias = join(dirname(lp), 'alias.json');
      symlinkSync(lp, alias);
      const a = granted(() => reserve({ ledgerPath: alias, callId: 'a', estimatedMaxUsd: 6 }));
      const b = granted(() => reserve({ ledgerPath: lp, callId: 'b', estimatedMaxUsd: 6 }));
      return a && b;
    },
  ],
  [
    'spend from a stale ledger after settling an old reservation',
    () => {
      const lp = capped(10);
      reserve({ ledgerPath: lp, callId: 'old', estimatedMaxUsd: 1 });
      editBooks(lp, (d) => (d.updatedAt = new Date(Date.now() - 30 * 864e5).toISOString()));
      try {
        settle({ ledgerPath: lp, callId: 'old', actualUsd: 0 });
      } catch {
        /* a refusal is fine */
      }
      return granted(() => reserve({ ledgerPath: lp, callId: 'new', estimatedMaxUsd: 1 }));
    },
  ],
]);

const DENY_DEFAULT = {
  schema: 'sakk-policy.v1',
  default_verdict: 'deny',
  rules: [
    { id: 'no-prod', match: { scope: ['prod/'] }, verdict: 'deny' },
    { id: 'small', match: { action: 'model_call', max_estimated_usd: 1 }, verdict: 'allow' },
    { id: 'docs', match: { action: 'file_write', scope: ['docs/'] }, verdict: 'allow' },
  ],
};
const policyFrom = (doc) => {
  const p = join(tdir(), 'p.json');
  writeFileSync(p, JSON.stringify(doc));
  return loadPolicy({ policyPath: p });
};
const allows = (doc, context) => {
  try {
    const { policy, policyHash } = policyFrom(doc);
    return (
      decide({ policy, policyHash, context: { callId: 'c', estimatedUsd: 0.5, ...context } })
        .verdict === 'allow'
    );
  } catch {
    return false;
  }
};
row(
  'E6 policy kernel',
  'get a refused request allowed (deny-default policy)',
  'CLAIMED',
  [
    ['write prod through a traversal', { action: 'file_write', scope: 'docs/../prod/x' }],
    ['write prod through a double slash', { action: 'file_write', scope: 'docs//../prod/x' }],
    ['write prod through a leading ./', { action: 'file_write', scope: './docs/x' }],
    ['model_call just over the limit', { action: 'model_call', estimatedUsd: 1.0000001 }],
    ['model_call with a string amount', { action: 'model_call', estimatedUsd: '0.5' }],
    ['action in another case', { action: 'Model_call' }],
    ['empty action name', { action: '' }],
    ['prototype-named action', { action: '__proto__' }],
  ].map(([label, ctx]) => [label, () => allows(DENY_DEFAULT, ctx)]),
);
const ALLOW_DEFAULT = {
  schema: 'sakk-policy.v1',
  default_verdict: 'allow',
  rules: [
    { id: 'no-prod-deploys', match: { action: 'deploy', scope: ['prod/'] }, verdict: 'deny' },
  ],
};
row('E6 policy kernel', 'dodge a deny under an allow-default policy', 'KNOWN', [
  ['deploy with the scope omitted', () => allows(ALLOW_DEFAULT, { action: 'deploy' })],
  [
    'deploy to a case alias of prod/',
    () => allows(ALLOW_DEFAULT, { action: 'deploy', scope: 'Prod/api' }),
  ],
]);

const mcp = (lp, frames, { policy } = {}) => {
  const args = [SAKK, 'mcp', '--ledger', lp];
  if (policy) {
    const pp = join(tdir(), 'p.json');
    writeFileSync(pp, JSON.stringify(policy));
    args.push('--policy', pp);
  }
  const r = spawnSync(process.execPath, args, {
    input: `${frames.map((f) => (typeof f === 'string' ? f : JSON.stringify(f))).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 30_000,
    // the variables are REMOVED, not emptied: set-but-empty is a refusal, and
    // a server that never started made every variant read "blocked" (F-93)
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => k !== 'SAKK_LEDGER_PATH' && k !== 'SAKK_POLICY_PATH',
      ),
    ),
  });
  return {
    status: r.status,
    replies: r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  };
};
const call = (id, name, args) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});
const entries = (lp) => readLedger({ ledgerPath: lp, maxAgeMs: Infinity }).entries;
{
  // control: the helper reaches a working gate — an allowed reserve is booked
  const lp = capped(10);
  const r = mcp(lp, [call(1, 'sakk_reserve', { callId: 'ok', estimatedMaxUsd: 0.5 })]);
  if (r.status !== 0 || entries(lp).length !== 1) {
    console.error(
      `E7 control failed: the MCP helper did not reach a working gate (exit ${r.status})`,
    );
    process.exit(1);
  }
}
row('E7 MCP enforcer', 'spend or lift a stop through the agent channel', 'CLAIMED', [
  [
    'reserve an action the policy denies',
    () => {
      const lp = capped(10);
      mcp(
        lp,
        [
          call(1, 'sakk_reserve', {
            callId: 'd',
            estimatedMaxUsd: 0.5,
            action: 'deploy',
            scope: 'prod/x',
          }),
        ],
        {
          policy: DENY_DEFAULT,
        },
      );
      return entries(lp).length > 0;
    },
  ],
  [
    'reserve as a notification (no id)',
    () => {
      const lp = capped(10);
      mcp(lp, [
        {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'sakk_reserve', arguments: { callId: 'n', estimatedMaxUsd: 1 } },
        },
      ]);
      return entries(lp).length > 0;
    },
  ],
  [
    'settle a reconciliation entry at $0',
    () => {
      const lp = capped(10);
      reserve({ ledgerPath: lp, callId: 'r', estimatedMaxUsd: 1 });
      settle({ ledgerPath: lp, callId: 'r', failedUnknownCost: true });
      mcp(lp, [call(1, 'sakk_settle', { callId: 'r', actualUsd: 0 })]);
      return entries(lp)[0].status === 'SETTLED';
    },
  ],
  [
    'lift a halt with an invented tool',
    () => {
      const lp = capped(10);
      halt({ ledgerPath: lp, by: 'op' });
      mcp(lp, [call(1, 'sakk_resume', { by: 'agent' }), call(2, 'sakk_unlock', { by: 'agent' })]);
      return !readLedger({ ledgerPath: lp, maxAgeMs: Infinity }).halt?.global;
    },
  ],
  [
    'kill the gate with a deeply nested frame',
    () => {
      const lp = capped(10);
      const deep = `${'['.repeat(8000)}${']'.repeat(8000)}`;
      const r = mcp(lp, [
        `{"jsonrpc":"2.0","id":1,"method":${deep}}`,
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ]);
      return !r.replies.some((m) => m.id === 2);
    },
  ],
]);

const failingSuite = (() => {
  const f = join(tdir(), 'f.test.mjs');
  writeFileSync(
    f,
    "import {test} from 'node:test';import assert from 'node:assert';test('t',()=>assert.equal(1,2));\n",
  );
  return f;
})();
row(
  'E8 gold harness',
  'turn a failing suite green from the operator environment',
  'CLAIMED',
  [
    { NODE_OPTIONS: '--test-only' },
    { NODE_OPTIONS: '--test-skip-pattern=.' },
    { NODE_OPTIONS: '--test-name-pattern=no-such-test' },
    { NODE_TEST_CONTEXT: 'child' },
    { NODE_TEST_CONTEXT: 'child-v8' },
  ].map((vars) => [
    Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join(' '),
    () => {
      const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
      Object.assign(process.env, vars);
      try {
        return (
          spawnSync(process.execPath, ['--test', failingSuite], {
            env: childEnv(),
            encoding: 'utf8',
          }).status === 0
        );
      } finally {
        for (const [k, v] of Object.entries(saved))
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
      }
    },
  ]),
);

// ── report ──────────────────────────────────────────────────────────────────
const undescribed = rows.filter((r) => !describeRow(r.payload)).map((r) => r.payload);
if (undescribed.length) {
  console.error(`attack rows without target/signature (standard §6): ${undescribed.join(', ')}`);
  process.exit(1);
}
if (process.argv.includes('--list')) {
  console.log('| Entry | Payload | Kind | Variants | Target | Success signature |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const [target, signature] = describeRow(r.payload);
    console.log(
      `| ${r.entry} | ${r.payload} | ${r.kind} | ${r.variants.map(([l]) => l).join('; ')} | ${target} | ${signature} |`,
    );
  }
  process.exit(0);
}
const results = rows.map((r) => {
  const got = r.variants.filter(([, attack]) => {
    try {
      return attack() === true;
    } catch {
      return false; // an attack that crashes Sakk's API was refused, not successful
    }
  });
  const [target, signature] = describeRow(r.payload);
  return { ...r, target, signature, attacks: r.variants.length, through: got.map(([l]) => l) };
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
  const weak = claimed.filter((r) => r.attacks < T3.variants_min);
  console.log(`\nCLAIMED: ${tC}/${nC} attacks got through (ASR ${((100 * tC) / nC).toFixed(1)}%)`);
  if (weak.length)
    console.log(
      `rows with fewer than ${T3.variants_min} variants: ${weak.map((r) => r.payload).join(', ')}`,
    );
}
const asr = nC === 0 ? 1 : tC / nC;
process.exit(
  nC > 0 && asr <= T3.claimed_asr_max && claimed.every((r) => r.attacks >= T3.variants_min) ? 0 : 1,
);
