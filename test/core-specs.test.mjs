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
  'src/ledger.mjs': ['specs/ledger/spec.md', 'specs/kill-switch/spec.md'],
  'src/archive.mjs': 'specs/ledger/spec.md',
  'src/prices.mjs': 'specs/spend/spec.md',
  'src/spend.mjs': 'specs/spend/spec.md',
  'src/policy.mjs': 'specs/policy-engine/spec.md',
  'src/match.mjs': 'specs/policy-engine/spec.md',
  'src/mcp.mjs': 'specs/mcp-server/spec.md',
  'src/secret-scan.mjs': 'specs/secret-scan/spec.md',
  'src/classify.mjs': 'specs/guard/spec.md',
  'src/hook.mjs': 'specs/guard/spec.md',
  'src/guard-install.mjs': 'specs/guard/spec.md',
  'eval/lib/scorer.mjs': 'eval/02_SCORING_POLICY.md',
  'eval/lib/paid-step.mjs': 'eval/03_COST_POLICY.md',
  'eval/bin/gold-runner.mjs': 'eval/00_EXECUTION_MODEL.md',
  'eval/lib/packs.mjs': 'specs/case-packs/spec.md',
  'eval/lib/bundle-verify.mjs': 'specs/evidence-bundle/spec.md',
  'scripts/evidence-bundle.mjs': 'specs/evidence-bundle/spec.md',
};
const NOT_CORE = {
  'src/append.mjs':
    'append-only file writes that refuse to follow a symlink; driven by the ledger and policy tests',
  'eval/lib/trace.mjs': 'trace file I/O; every field it writes is re-checked by the scorer',
  'eval/lib/validate.mjs': 'JSON-schema helper; schema failures surface through --validate tests',
  'eval/lib/exec-env.mjs': 'child-process environment; covered by the runner tests',
};
const SOURCES = ['src', 'eval/lib', 'eval/bin']
  .flatMap((d) => readdirSync(join(ROOT, d)).map((f) => `${d}/${f}`))
  .filter((f) => f.endsWith('.mjs'));
const drill = read('scripts/mutation-drill.sh');
/** A drill entry for a file, whatever the length of its id (F-147: the 27th drill is MUT-AA). */
const drillLine = (file) => new RegExp(`run_drill MUT-[A-Z]+ ${file.replace(/[.]/g, '\\.')} `);

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
      for (const sp of [].concat(spec)) assert.ok(existsSync(join(ROOT, sp)), `${sp} missing`);
      assert.match(drill, drillLine(file), 'no drill anchor');
    });
  test('every drill anchor is found exactly once in its file, without running the drill (F-149)', () => {
    // the drill takes an hour and was the only reader of its anchors, so a
    // reformat or an edit broke them unseen until it ran; this reads each
    // anchor the way run_drill receives it, in milliseconds
    const drifted = (text) => {
      const calls = [
        ...text.matchAll(
          /^run_drill (MUT-[A-Z]+) (\S+) \\\n {2}(?:"((?:[^"\\]|\\.)*)"|'([^']*)') \\\n/gm,
        ),
      ];
      // every entry is read, none skipped because it is laid out differently
      assert.equal(calls.length, text.match(/^run_drill /gm).length);
      // a double-quoted shell argument drops the backslash before " \\ $ and `
      const anchor = (dq, sq) => sq ?? dq.replace(/\\(["\\$`])/g, '$1');
      return calls
        .map(([, id, file, dq, sq]) => [id, file, read(file).split(anchor(dq, sq)).length - 1])
        .filter(([, , n]) => n !== 1)
        .map(([id, file, n]) => `${id} ${file}: anchor found ${n} times`);
    };
    assert.deepEqual(drifted(drill), []);
    // control: an anchor the source no longer has is reported
    assert.deepEqual(
      drifted('run_drill MUT-ZZ src/hook.mjs \\\n  "if (no such line)" \\\n  "x" \\\n'),
      ['MUT-ZZ src/hook.mjs: anchor found 0 times'],
    );
  });
  test('every drill entry is recognised, however many letters its id has (F-147)', () => {
    const entries = [...drill.matchAll(/^run_drill (\S+) (\S+) /gm)];
    assert.ok(entries.length > 26, 'the drill has more entries than one letter can name');
    for (const [line, id, file] of entries) {
      assert.match(id, /^MUT-[A-Z]+$/, line);
      assert.match(line, drillLine(file), line);
    }
  });
  test('every guard test a three-tables spec names exists', () => {
    const missing = [];
    for (const spec of new Set(
      Object.values(CORE)
        .flat()
        .filter((s) => s.startsWith('specs/')),
    ))
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

describe('every campaign runs somewhere (F-98)', () => {
  // fault injection, the soak and the MCP torture existed for days and ran
  // in neither the audit nor CI — a check nobody runs is not a check
  test('each script in scripts/campaign/ is a step of the audit', () => {
    const audit = read('scripts/audit.mjs');
    const campaigns = readdirSync(join(ROOT, 'scripts', 'campaign')).filter((f) =>
      f.endsWith('.mjs'),
    );
    assert.ok(campaigns.length >= 3, campaigns.join());
    for (const c of campaigns)
      assert.ok(audit.includes(`scripts/campaign/${c}`), `${c} is not run by the audit`);
  });
});
