import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '../lib/exec-env.mjs';

/** F-81: the child environment is an allowlist; nothing the operator holds leaks, no flag fakes a green. */

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
};

describe('child environment (F-81)', () => {
  test('a failing suite stays red whatever NODE_OPTIONS or NODE_TEST_CONTEXT the operator has', () => {
    const d = mkdtempSync(join(tmpdir(), 'execenv-'));
    const file = join(d, 'f.test.mjs');
    writeFileSync(
      file,
      "import {test} from 'node:test';import assert from 'node:assert';test('t',()=>assert.equal(1,2));\n",
    );
    for (const vars of [
      { NODE_OPTIONS: '--test-skip-pattern=.' },
      { NODE_OPTIONS: '--test-only' },
      { NODE_TEST_CONTEXT: 'child-v8' },
    ]) {
      const r = withEnv(vars, () =>
        spawnSync(process.execPath, ['--test', file], { env: childEnv(), encoding: 'utf8' }),
      );
      assert.notEqual(r.status, 0, `${JSON.stringify(vars)} turned a failing suite green`);
    }
  });
  test('credentials and the organisation ledger path never reach a child; the real executor gets only its provider', () => {
    const vars = {
      ANTHROPIC_API_KEY: 'k',
      GITHUB_TOKEN: 'g',
      AWS_SECRET_ACCESS_KEY: 'a',
      SAKK_BUDGET_LEDGER_PATH: '/org/ledger.json',
      GOLD_TRACE: '/operator/leftover',
    };
    const plain = withEnv(vars, () => childEnv());
    for (const k of Object.keys(vars)) assert.ok(!(k in plain), `${k} reached a child`);
    const real = withEnv(vars, () => childEnv({}, { provider: true }));
    assert.equal(real.ANTHROPIC_API_KEY, 'k');
    for (const k of [
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'SAKK_BUDGET_LEDGER_PATH',
      'GOLD_TRACE',
    ])
      assert.ok(!(k in real), `${k} reached the real executor`);
  });
  test('control: what a process needs to run still passes, and explicit channels win', () => {
    const env = childEnv({ GOLD_TEST_LOG: '/x' });
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.GOLD_TEST_LOG, '/x');
  });
});
