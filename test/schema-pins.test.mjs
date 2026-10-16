import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER_SCHEMA, LEDGER_SCHEMA_V2 } from '../src/ledger.mjs';

/**
 * Class detector for findings RC-07 (F-14): "a new field means a schema
 * version bump" used to be a code comment. A closed format's key list is
 * pinned here together with its schema id — change one without the other
 * and this fails.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arrayLiteral = (file, name) => {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const m = src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(m, `${name} not found in ${file}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

describe('closed formats: key lists are pinned to their schema ids', () => {
  test('the v1 ledger key list is pinned to sakk-ledger.v1', () => {
    assert.equal(LEDGER_SCHEMA, 'sakk-ledger.v1');
    assert.deepEqual(arrayLiteral('src/ledger.mjs', 'LEDGER_TOP_KEYS_V1'), [
      'schema',
      'initializedAt',
      'initializedBy',
      'capUsd',
      'flags',
      'entries',
      'updatedAt',
    ]);
  });
  test('v2 is exactly v1 plus halt', () => {
    assert.equal(LEDGER_SCHEMA_V2, 'sakk-ledger.v2');
    assert.match(
      readFileSync(join(ROOT, 'src/ledger.mjs'), 'utf8'),
      /const LEDGER_TOP_KEYS_V2 = \[\.\.\.LEDGER_TOP_KEYS_V1, 'halt'\];/,
    );
  });
  test('the case-pack top-level key list is pinned to sakk-case-pack.v1', () => {
    const src = readFileSync(join(ROOT, 'eval/lib/packs.mjs'), 'utf8');
    assert.match(src, /const PACK_SCHEMA = 'sakk-case-pack\.v1';/);
    assert.deepEqual(arrayLiteral('eval/lib/packs.mjs', 'TOP_KEYS'), [
      'schema',
      'id',
      'title',
      'regulator',
      'clause_status',
      'not_covered',
      'requirements',
    ]);
  });
});
