import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Class detector for findings RC-10 / fail-open-absence (findings/ledger.json):
 * what the project claims must be backed by something that runs.
 *  1. every refusal code a source file can emit is asserted by some test
 *     (AGENTS.md "every refusal path needs a negative test", mechanized);
 *  2. every code the user-facing docs name exists in the code;
 *  3. no test run and no CI job can hang instead of failing.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The user-facing docs added for the open-source release (C-05.1): every scan
// below that reads README.md reads these too, so a code, file name or security
// word they cite is held to the same check.
const RELEASE_DOCS = [
  'README.zh-CN.md',
  'docs/FAQ.md',
  'docs/FAQ.zh-CN.md',
  'docs/compare.md',
  'docs/ROADMAP.md',
  'docs/tutorial/en.md',
  'docs/tutorial/zh-CN.md',
  'llms.txt',
];
const SKIP = new Set([
  'node_modules',
  '.git',
  'fixtures',
  'gold',
  'fake',
  'packs',
  'cases',
  'schemas',
]);
const walk = (d) =>
  readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (SKIP.has(e.name) ? [] : walk(join(d, e.name))) : [join(d, e.name)],
  );
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

const SOURCES = [
  ...walk('src'),
  ...walk('bin'),
  ...walk('eval/lib'),
  ...walk('eval/bin'),
  'scripts/evidence-bundle.mjs',
  'scripts/gate-certificate.mjs',
].filter((f) => f.endsWith('.mjs'));
const TESTS = [...walk('test'), ...walk('eval/__tests__')]
  .filter((f) => f.endsWith('.mjs'))
  .map(read)
  .join('\n');
// `rule:` too — scorer rules are refusals of a case, and eleven of them had no
// test that could fail (gold review S6, F-89)
const EMIT =
  /(?:Error\(\s*|bad\(\s*|gap\(\s*|fail\(\s*|usage\(\s*|code:\s*|rule:\s*)['`]([A-Z][A-Z0-9_]{3,}[A-Za-z0-9_]*)/g;

/**
 * Codes on purely defensive paths that no input can reach without a broken
 * dependency. Each entry needs its reason; adding one is a reviewed choice.
 */
const DEFENSIVE = {
  SCAN_FAILED: 'git produced output the scanner cannot parse, or an unexpected I/O error',
  VERIFIER_ERROR: 'a bug inside the verifier itself (it must still fail closed)',
  HOOK_SECRET_SCAN_FAILED:
    'scanText threw on a string the hook already bounded — only reachable if the scanner dependency is broken; caught so the hook fails closed (a deny via the rules-unknown branch, which other triggers do exercise) instead of crashing. The throw itself cannot be provoked by hook input, so there is no unit for this specific trigger.',
  CONSOLE_HALT_FAILED:
    "the console's halt catch-all for a non-LedgerError — halt() raises a typed LedgerError on every reachable path, so this only fires if the ledger dependency throws something else; it still answers a typed 409, never a crash",
  CONSOLE_TRY_FAILED:
    'the console try-box catch-all for a non-ConsoleError from evaluate — evaluate answers rather than throws on reachable input, so this only fires on an unexpected internal error; it still answers a typed 400',
  UI_FAILED:
    'the sakk ui catch-all for a startConsole rejection other than EADDRINUSE — no reachable input produces one, but the CLI still exits with a typed message instead of a bare stack',
  SPEND_TOO_MANY_LOGS:
    'more than 50,000 transcript files under the log dir — a readdir counter, not reproducible as a cheap unit test (would need 50k files)',
};

describe('claims are checked', () => {
  test('every refusal code a source can emit is asserted by at least one test', () => {
    const untested = [];
    for (const f of SOURCES)
      for (const m of read(f).matchAll(EMIT))
        if (!Object.hasOwn(DEFENSIVE, m[1]) && !TESTS.includes(m[1]))
          untested.push(`${m[1]} (${f})`);
    assert.deepEqual(
      [...new Set(untested)],
      [],
      'write the negative test, or justify it in DEFENSIVE',
    );
  });
  test('every DEFENSIVE entry is still emitted somewhere (no stale exemptions)', () => {
    const all = SOURCES.map(read).join('\n');
    for (const code of Object.keys(DEFENSIVE)) assert.ok(all.includes(`'${code}'`), code);
  });
  test('every code the user-facing docs name exists in the code', () => {
    const code = [...walk('src'), ...walk('bin'), ...walk('eval'), ...walk('scripts')]
      .filter((f) => /\.(mjs|sh)$/.test(f))
      .map(read)
      .join('\n');
    const missing = [];
    for (const doc of [
      'README.md',
      'docs/AUDITOR_REPLAY.md',
      'eval/README.md',
      'SECURITY.md',
      ...RELEASE_DOCS,
    ])
      for (const m of read(doc).matchAll(/`([A-Z][A-Z0-9_]{5,})`/g))
        if (!code.includes(m[1])) missing.push(`${doc}: ${m[1]}`);
    assert.deepEqual([...new Set(missing)], []);
  });
});

describe('every file name the docs cite exists (F-83, RC-10 detector upgrade)', () => {
  // claims-are-checked matched refusal CODES only; a backticked file name in
  // the README (the decision log) was wrong for two releases of review.
  test('each backticked file name in the docs appears in the code or the repository', () => {
    const docs = [
      ...new Set([
        'README.md',
        'CHANGELOG.md',
        'eval/README.md',
        ...readdirSync(join(ROOT, 'docs'))
          .filter((f) => f.endsWith('.md'))
          .map((f) => `docs/${f}`),
        ...RELEASE_DOCS,
      ]),
    ];
    const code = [
      ...walk('src'),
      ...walk('bin'),
      ...walk('eval/lib'),
      ...walk('eval/bin'),
      ...walk('scripts'),
    ]
      .filter((f) => /\.(mjs|sh)$/.test(f))
      .map(read)
      .join('\n');
    const all = (d) =>
      readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? ['node_modules', '.git', 'audit-logs'].includes(e.name)
            ? []
            : all(join(d, e.name))
          : [e.name],
      );
    const names = new Set(all('.'));
    const missing = [];
    let cited = 0;
    for (const d of docs)
      for (const [, t] of read(d).matchAll(
        /`([A-Za-z0-9_.-]+\.(?:jsonl|json|mjs|md|sh|yml|yaml|tgz|sha256))`/g,
      )) {
        cited += 1;
        if (!code.includes(t) && !names.has(t)) missing.push(`${d}: ${t}`);
      }
    assert.ok(cited >= 20, `only ${cited} file names cited — pattern drifted?`);
    assert.deepEqual(missing, []);
  });
});

describe('a security word is backed by a mechanism (F-126, C-05 detector upgrade)', () => {
  // The checks above match codes and file names. "signed" described a
  // self-declared --by name in the CLI help and four documents because no
  // check read adjectives: a name somebody typed is not a signature.
  const SCANNED = [
    'README.md',
    'CHANGELOG.md',
    'SECURITY.md',
    'docs/ARCHITECTURE.md',
    'docs/AUDITOR_REPLAY.md',
    'specs/kill-switch/spec.md',
    'bin/sakk.mjs',
    ...RELEASE_DOCS,
  ];
  // the Chinese docs get the same words in Chinese: 签名 (signed), 防篡改 /
  // 不可篡改 (tamper-proof), 不可变 (immutable)
  const WORD =
    /\b(?:signed|signatures?|tamper-proof|immutable|cryptographically)\b|签名|防篡改|不可篡改|不可变/gi;
  // Each permitted use is a person who really signs something, or a mechanism
  // that exists in the code. Adding one is a reviewed choice.
  const ALLOWED = [
    ['CHANGELOG.md', 'design signed 2026-10-15', 'the maintainer signed the policy-engine design review'],
  ];
  test('every scanned file exists and has text', () => {
    for (const f of SCANNED) assert.ok(read(f).trim().length > 0, f);
  });
  test('no user-facing text calls a record signed, immutable or tamper-proof without a mechanism', () => {
    const hits = [];
    for (const f of SCANNED)
      read(f)
        .split('\n')
        .forEach((line, i) => {
          if ([...line.matchAll(WORD)].length === 0) return;
          if (ALLOWED.some(([af, phrase]) => af === f && line.includes(phrase))) return;
          hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    assert.deepEqual(
      hits,
      [],
      'say "named" (self-declared), or point to the mechanism and allow it here',
    );
  });
  test('every allowed phrase is still present (no stale exemptions)', () => {
    for (const [f, phrase] of ALLOWED) assert.ok(read(f).includes(phrase), `${f}: ${phrase}`);
  });
});

// one `node … --test …` launch per match, up to the next shell separator
const testLaunches = (text) => text.match(/\bnode\b[^\n&|;'"]*?\s--test\b[^\n&|;'"]*/g) ?? [];

describe('a suite never acts on the repository that started it (findings F-214)', () => {
  test('every node --test launch in package.json and the hooks loads test/clean-git-env.mjs first', () => {
    const where = [
      ['package.json', Object.values(JSON.parse(read('package.json')).scripts).join('\n')],
      ['scripts/hooks/pre-commit', read('scripts/hooks/pre-commit')],
      ['scripts/hooks/commit-msg', read('scripts/hooks/commit-msg')],
      ['scripts/hooks/pre-push.mjs', read('scripts/hooks/pre-push.mjs')],
    ];
    let seen = 0;
    for (const [f, text] of where)
      for (const launch of testLaunches(text)) {
        seen++;
        assert.match(launch, /--import \.\/test\/clean-git-env\.mjs --test\b/, `${f}: ${launch}`);
      }
    assert.ok(seen >= 3, `only ${seen} node --test launches found`);
  });
  test('test/clean-git-env.mjs removes every GIT_ variable before the runner starts a test file', () => {
    const d = mkdtempSync(join(tmpdir(), 'clean-git-env-'));
    try {
      const probe = join(d, 'probe.test.mjs');
      writeFileSync(
        probe,
        `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n` +
          `test('probe', () => assert.deepEqual(Object.keys(process.env).filter((k) => k.startsWith('GIT_')), []));\n`,
      );
      const r = spawnSync(
        process.execPath,
        ['--import', join(ROOT, 'test', 'clean-git-env.mjs'), '--test', probe],
        {
          cwd: d,
          encoding: 'utf8',
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([k]) => k !== 'NODE_TEST_CONTEXT' && k !== 'NODE_OPTIONS',
              ),
            ),
            GIT_DIR: join(d, 'not-a-repo'),
            GIT_INDEX_FILE: join(d, 'index'),
            GIT_PREFIX: 'x/',
          },
        },
      );
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
      assert.match(`${r.stdout}`, /pass 1/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('nothing hangs instead of failing (findings F-15)', () => {
  test('every node --test script carries --test-timeout', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    let seen = 0;
    for (const [name, cmd] of Object.entries(scripts))
      for (const launch of testLaunches(cmd)) {
        seen++;
        assert.match(launch, /--test-timeout=\d+/, name);
      }
    assert.ok(seen >= 2, `only ${seen} node --test launches found in package.json`);
  });
  test('the commit gate passes exit codes straight through', () => {
    const gate = read('scripts/gate.sh');
    assert.match(gate, /set -euo pipefail/);
    assert.doesNotMatch(
      gate,
      /\|\s*(tail|grep|head)\b/,
      'no pipe may sit between a check and its exit code',
    );
    for (const step of ['lint', 'format:check', 'test', 'test:eval'])
      assert.match(gate, new RegExp(`npm run --silent ${step}\\b`), step);
  });
  test('every CI job has timeout-minutes', () => {
    // every workflow file, not one named file: the review workflow had no
    // timeout while this test said "every CI job" (F-91, F-79 class)
    const files = readdirSync(join(ROOT, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f));
    assert.ok(files.length >= 2, files.join());
    let jobs = 0;
    for (const f of files) {
      const wf = read(join('.github', 'workflows', f));
      const body = wf.slice(wf.indexOf('\njobs:\n'));
      for (const [, job] of body.matchAll(/^ {2}([a-z][\w-]*):\n/gm)) {
        jobs += 1;
        const jb = body.slice(body.indexOf(`  ${job}:\n`)).split(/\n {2}[a-z][\w-]*:\n/)[0];
        assert.match(jb, /timeout-minutes:\s*\d+/, `${f}: ${job}`);
      }
    }
    assert.ok(jobs >= 4, `only ${jobs} jobs found`);
  });
  test('the drill job has time for every mutant it runs (F-166)', () => {
    // Each mutant runs only the files that hold its named test (F-219), so
    // the drill still grows with the mutant count; CI cancels it at
    // timeout-minutes and the check reads red. Measured on one commit,
    // locally: 366 s for 40 mutants and the full control, against 1698 s when
    // each mutant reran its whole suite; CI ran that older drill 1.8-2.4x
    // slower than local, so about 15 minutes is expected there. 40 s per
    // mutant leaves about twice that for runner variance and the fuzz and
    // campaign steps. Adding mutants without raising the limit fails here.
    const PER_MUTANT_S = 40;
    const mutants = (read('scripts/mutation-drill.sh').match(/^run_drill MUT-/gm) ?? []).length;
    assert.ok(mutants >= 30, `found only ${mutants} mutants — the count is broken`);
    const ci = read(join('.github', 'workflows', 'ci.yml'));
    const drill = ci.slice(ci.indexOf('\n  drill:\n') + 1).split(/\n {2}[a-z][\w-]*:\n/)[0];
    const limit = Number(drill.match(/timeout-minutes:\s*(\d+)/)?.[1]);
    assert.ok(
      limit * 60 >= mutants * PER_MUTANT_S,
      `drill: ${limit} min for ${mutants} mutants needs ${Math.ceil((mutants * PER_MUTANT_S) / 60)}`,
    );
  });
});

describe('a stopwatch never stands in for a work bound (findings F-62)', () => {
  // Upper wall-clock bounds (`elapsed < N`, `elapsed > N → fail`) must be
  // pathology lines ≥ 30 s: the audit's mutation drill ran a test 14x slower
  // than idle, so anything tighter reports machine load, not code. Speed
  // guarantees belong to a deterministic counter (e.g. the shadow-scan
  // budget). Lower bounds (`elapsed >= N`, "it really waited") are fine.
  const MIN_MS = 30_000;
  const UPPER = [
    /Date\.now\(\)\s*-\s*\w+\s*[<>](?!=)\s*([\w]+)/g,
    /\b\w+Ms\s*[<>](?!=)\s*([\w]+)/g,
    // a deadline that decides pass/fail is a stopwatch too (F-66)
    /Date\.now\(\)\s*\+\s*([\d_]+)\b/g,
  ];
  const offenders = (src) => {
    const bad = [];
    let checked = 0;
    for (const re of UPPER)
      for (const m of src.matchAll(re)) {
        // `while (Date.now() - t < N) {}` is a deliberate wait, not a bound
        if (/while\s*\(\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
        checked += 1;
        let v = m[1];
        if (!/^[\d_]+$/.test(v)) {
          const def = src.match(new RegExp(`const ${v} = ([\\d_]+);`));
          v = def ? def[1] : 'NaN';
        }
        if (!(Number(v.replaceAll('_', '')) >= MIN_MS)) bad.push(m[0]);
      }
    return { bad, checked };
  };
  test('the detector flags a tight bound and passes a pathology line', () => {
    assert.equal(offenders('assert.ok(Date.now() - t0 < 1000);').bad.length, 1);
    assert.equal(offenders('if (evilMs > 15_000) die();').bad.length, 1);
    assert.equal(offenders('const P = 30_000; ok(Date.now() - t0 < P);').bad.length, 0);
    assert.equal(offenders('assert.ok(Date.now() - t0 >= 2900);').bad.length, 0);
    assert.equal(offenders('while (Date.now() - t < 5000) {}').bad.length, 0);
    assert.equal(offenders('const until = Date.now() + 20000;').bad.length, 1);
    assert.equal(offenders('const until = Date.now() + 120_000;').bad.length, 0);
  });
  test('no test or check script asserts speed with a tight wall clock', () => {
    let checked = 0;
    const bad = [];
    for (const f of [...walk('test'), ...walk('eval/__tests__'), ...walk('scripts')]) {
      if (!f.endsWith('.mjs') || f.endsWith('claims-are-checked.test.mjs')) continue;
      const r = offenders(read(f));
      checked += r.checked;
      bad.push(...r.bad.map((b) => `${f}: ${b}`));
    }
    assert.deepEqual(bad, []);
    assert.ok(checked >= 6, `detector saw only ${checked} wall-clock bounds — pattern drifted?`);
  });
});
