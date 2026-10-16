import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePack, loadPack, packCaseIds, packReport, PackError } from '../lib/packs.mjs';
import { loadCases } from '../bin/gold-runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, '..', 'bin', 'gold-runner.mjs');
const KNOWN = new Set(loadCases().map((c) => c.id));
const run = (args) =>
  spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', timeout: 300_000 });

const goodPack = () => ({
  schema: 'sakk-case-pack.v1',
  id: 'p',
  title: 't',
  regulator: 'r',
  clause_status: 'THEMATIC',
  requirements: [{ id: 'r1', theme: 'x', cases: ['G05'], evidence: 'e' }],
});
const expectCode = (fn, code) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof PackError, e.message);
    assert.equal(e.code, code, e.message);
    return;
  }
  assert.fail(`expected ${code}`);
};

describe('case packs: every malformed pack refuses with a name', () => {
  test('a pack pointing at a case that does not exist is invalid (no phantom evidence)', () => {
    const d = goodPack();
    d.requirements[0].cases = ['G99'];
    expectCode(() => validatePack(d, 'p.json', KNOWN), 'PACK_INVALID');
  });
  test('empty requirements, or a requirement with no cases, is invalid (empty set is an error)', () => {
    const a = goodPack();
    a.requirements = [];
    expectCode(() => validatePack(a, 'p.json', KNOWN), 'PACK_INVALID');
    const b = goodPack();
    b.requirements[0].cases = [];
    expectCode(() => validatePack(b, 'p.json', KNOWN), 'PACK_INVALID');
  });
  test('unknown keys, wrong schema, id/file mismatch, duplicate requirement ids all refuse', () => {
    expectCode(() => validatePack({ ...goodPack(), extra: 1 }, 'p.json', KNOWN), 'PACK_INVALID');
    expectCode(
      () => validatePack({ ...goodPack(), schema: 'nope' }, 'p.json', KNOWN),
      'PACK_INVALID',
    );
    expectCode(() => validatePack(goodPack(), 'other.json', KNOWN), 'PACK_INVALID');
    const dup = goodPack();
    dup.requirements.push({ ...dup.requirements[0] });
    expectCode(() => validatePack(dup, 'p.json', KNOWN), 'PACK_INVALID');
  });
  test('an unknown pack id refuses PACK_UNKNOWN', () => {
    expectCode(() => loadPack('no-such-pack', KNOWN), 'PACK_UNKNOWN');
  });
});

describe('case packs: COVERED means every backing case ran and passed', () => {
  const pack = {
    ...goodPack(),
    requirements: [{ id: 'r1', theme: 'x', cases: ['G05', 'G06'], evidence: 'e' }],
  };
  const entry = (id, verdict) => ({ caseDef: { id }, result: { verdict } });
  test('all PASS → COVERED', () => {
    const r = packReport(pack, [entry('G05', 'PASS'), entry('G06', 'PASS')]);
    assert.equal(r.requirements[0].status, 'COVERED');
    assert.equal(r.covered, 1);
  });
  test('one FAIL → NOT_COVERED', () => {
    const r = packReport(pack, [entry('G05', 'PASS'), entry('G06', 'FAIL')]);
    assert.equal(r.requirements[0].status, 'NOT_COVERED');
  });
  test('a case that never ran → NOT_RUN → NOT_COVERED (absence of evidence is not evidence)', () => {
    const r = packReport(pack, [entry('G05', 'PASS')]);
    assert.equal(r.requirements[0].status, 'NOT_COVERED');
    assert.equal(r.requirements[0].cases[1].verdict, 'NOT_RUN');
  });
});

describe('case packs: runner CLI', () => {
  test('--pack runs exactly the pack cases and writes pack-report.json', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'pack-')), 'o');
    const r = run(['--fake-executor', '--pack', 'dora-ict-change', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(readFileSync(join(out, 'pack-report.json'), 'utf8'));
    assert.equal(report.pack, 'dora-ict-change');
    assert.equal(report.covered, report.total);
    const ran = r.stdout
      .match(/^G\d\d:/gm)
      .map((x) => x.slice(0, 3))
      .sort();
    assert.deepEqual(ran, packCaseIds(loadPack('dora-ict-change', KNOWN)));
  });
  test('unknown --pack exits 2 with PACK_UNKNOWN', () => {
    const r = run(['--dry-run', '--pack', 'typo-pack']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /PACK_UNKNOWN/);
  });
  test('--case and --pack together is a usage error, never a silent merge', () => {
    const r = run(['--dry-run', '--case', 'G01', '--pack', 'dora-ict-change']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /SELECTOR_CONFLICT/);
  });
  test('--validate checks every shipped pack', () => {
    const r = run(['--validate']);
    assert.equal(r.status, 0, r.stdout);
    assert.match(
      r.stdout,
      /packs: OK \(cbuae-ai-oversight, difc-data-protection, dora-ict-change\)/,
    );
  });
});
