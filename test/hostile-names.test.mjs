import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLedger, reserve, settle, halt, resume, readLedger } from '../src/ledger.mjs';
import { loadPolicy, decide } from '../src/policy.mjs';
import { loadCases } from '../eval/bin/gold-runner.mjs';
import { loadPack, PackError } from '../eval/lib/packs.mjs';

/**
 * Class detector for findings RC-05 (F-01, F-13): caller-supplied strings
 * must behave like any other string at every public entry point — never
 * read off Object.prototype, never swallowed on write. A new entry point
 * that takes a caller string belongs in this file.
 */
export const HOSTILE = [
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  'valueOf',
  'prototype',
  '__defineGetter__',
];

const fresh = () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'hostile-')), 'l.json');
  initLedger({ ledgerPath, capUsd: 1000 });
  return ledgerPath;
};

describe('ledger', () => {
  test('callIds and agentIds that are prototype names reserve, settle, halt and resume like any id', () => {
    for (const name of HOSTILE) {
      const ledgerPath = fresh();
      reserve({ ledgerPath, callId: name, estimatedMaxUsd: 1, agentId: name });
      settle({ ledgerPath, callId: name, actualUsd: 0.5 });
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      assert.equal(onDisk.entries[0].callId, name);
      assert.equal(onDisk.entries[0].agentId, name);
      assert.equal(halt({ ledgerPath, by: 'r', agentId: name }).alreadyHalted, false, name);
      assert.ok(Object.hasOwn(JSON.parse(readFileSync(ledgerPath, 'utf8')).halt.agents, name));
      assert.throws(
        () => reserve({ ledgerPath, callId: `${name}-2`, estimatedMaxUsd: 1, agentId: name }),
        (e) => e.code === 'AGENT_HALTED',
      );
      assert.equal(resume({ ledgerPath, by: 'r', agentId: name }).wasHalted, true);
      assert.equal(readLedger({ ledgerPath }).entries.length, 1);
    }
  });
});

describe('policy kernel', () => {
  test('agent/action names that are prototype names match only rules that name them', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'hostile-pol-')), 'p.json');
    writeFileSync(
      p,
      JSON.stringify({
        schema: 'sakk-policy.v1',
        default_verdict: 'deny',
        rules: [{ id: 'dev-read', verdict: 'allow', match: { agent: 'dev', action: 'read' } }],
      }),
    );
    const loaded = loadPolicy({ policyPath: p });
    const verdict = (name, extra = {}) =>
      decide({
        ...loaded,
        context: { callId: `c-${name}`, agent: name, action: name, estimatedUsd: 1, ...extra },
      }).verdict;
    for (const name of HOSTILE) assert.equal(verdict(name), 'deny', name);
    assert.equal(
      decide({ ...loaded, context: { callId: 'c', agent: 'dev', action: 'read', estimatedUsd: 1 } })
        .verdict,
      'allow',
    );
  });
});

describe('case packs', () => {
  test('pack ids that are prototype names are unknown, never resolved off a prototype', () => {
    const cases = new Map(loadCases().map((c) => [c.id, c]));
    for (const name of HOSTILE)
      assert.throws(
        () => loadPack(name, cases),
        (e) => e instanceof PackError && e.code === 'PACK_UNKNOWN',
        name,
      );
  });
});
