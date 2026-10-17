import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Class detector for findings F-53 / F-54 (testing standard §5 L1): every
 * core file has a written spec and at least one mutation-drill anchor, and
 * the guard tests a spec names exist. A new source file must be classified
 * here — core (with its spec) or not core (with the reason) — or this fails.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

const CORE = {
  'src/ledger.mjs': 'specs/kill-switch/spec.md',
  'src/policy.mjs': 'specs/policy-engine/spec.md',
  'src/match.mjs': 'specs/policy-engine/spec.md',
  'src/mcp.mjs': 'specs/mcp-server/spec.md',
  'src/secret-scan.mjs': 'specs/secret-scan/spec.md',
  'eval/lib/scorer.mjs': 'eval/02_SCORING_POLICY.md',
  'eval/lib/paid-step.mjs': 'eval/03_COST_POLICY.md',
  'eval/bin/gold-runner.mjs': 'eval/00_EXECUTION_MODEL.md',
  'eval/lib/packs.mjs': 'specs/case-packs/spec.md',
  'eval/lib/bundle-verify.mjs': 'specs/evidence-bundle/spec.md',
  'scripts/evidence-bundle.mjs': 'specs/evidence-bundle/spec.md',
};
const NOT_CORE = {
  'eval/lib/trace.mjs': 'trace file I/O; every field it writes is re-checked by the scorer',
  'eval/lib/validate.mjs': 'JSON-schema helper; schema failures surface through --validate tests',
  'eval/lib/exec-env.mjs': 'child-process environment; covered by the runner tests',
};
const SOURCES = ['src', 'eval/lib', 'eval/bin']
  .flatMap((d) => readdirSync(join(ROOT, d)).map((f) => `${d}/${f}`))
  .filter((f) => f.endsWith('.mjs'));
const drill = read('scripts/mutation-drill.sh');

describe('core files: classified, specified, drilled', () => {
  test('every source file is classified core or not core', () => {
    const unclassified = SOURCES.filter(
      (f) => !Object.hasOwn(CORE, f) && !Object.hasOwn(NOT_CORE, f),
    );
    assert.deepEqual(
      unclassified,
      [],
      'add the file to CORE (with its spec) or NOT_CORE (with the reason)',
    );
  });
  for (const [file, spec] of Object.entries(CORE))
    test(`${file}: has a spec and a mutation-drill anchor`, () => {
      assert.ok(existsSync(join(ROOT, file)), `${file} is listed but missing`);
      assert.ok(existsSync(join(ROOT, spec)), `${spec} missing`);
      assert.match(
        drill,
        new RegExp(`run_drill MUT-[A-Z] ${file.replace(/[.]/g, '\\.')} `),
        'no drill anchor',
      );
    });
  test('every guard test a three-tables spec names exists', () => {
    const missing = [];
    for (const spec of new Set(Object.values(CORE).filter((s) => s.startsWith('specs/'))))
      for (const m of read(spec).matchAll(
        /`((?:test|eval\/__tests__)\/[\w.-]+\.test\.mjs)::([^`]+)`/g,
      ))
        if (!existsSync(join(ROOT, m[1])) || !read(m[1]).includes(m[2]))
          missing.push(`${spec}: ${m[1]}::${m[2]}`);
    assert.deepEqual(missing, []);
  });
});

describe('the audit runs every applicable layer of the standard', () => {
  test('scripts/audit.mjs covers T0, T2, T3 and §14, and every npm script it calls exists', () => {
    const audit = read('scripts/audit.mjs');
    for (const layer of ['T0 ', 'T2 ', 'T3 ', '§14 '])
      assert.ok(audit.includes(`'${layer}`), layer);
    const scripts = JSON.parse(read('package.json')).scripts;
    for (const m of audit.matchAll(/\['run', '--silent', '([\w:-]+)'\]/g))
      assert.ok(Object.hasOwn(scripts, m[1]), `npm script ${m[1]}`);
    for (const m of audit.matchAll(/'(scripts\/[\w.-]+\.(?:mjs|sh))'/g))
      assert.ok(existsSync(join(ROOT, m[1])), m[1]);
  });
});

describe('every red line is drilled (self-evolution upgrade of F-54)', () => {
  // F-54's detector asked for one anchor per core FILE, so src/ledger.mjs
  // passed on its halt anchors while the cap check — the first red line —
  // had none. Now every red line in the profile names anchors that exist.
  test('each red line in docs/testing-profile.md names a drill anchor that exists', () => {
    const profile = read('docs/testing-profile.md');
    const drill = read('scripts/mutation-drill.sh');
    const section = profile.slice(
      profile.indexOf('## Red lines'),
      profile.indexOf('## Governance'),
    );
    const rows = [...section.matchAll(/^\| (No [^|]+?)\s*\| ([^|]+?)\s*\|$/gm)];
    assert.ok(rows.length >= 5, `only ${rows.length} red-line rows found`);
    for (const [, line, anchors] of rows) {
      const ids = anchors.split(/,\s*/).filter((a) => /^MUT-[A-Z]$/.test(a));
      assert.ok(ids.length > 0, `${line}: no drill anchor`);
      for (const id of ids)
        assert.match(
          drill,
          new RegExp(`^run_drill ${id} `, 'm'),
          `${line}: ${id} is not in the drill`,
        );
    }
  });
});
