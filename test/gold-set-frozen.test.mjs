import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Testing standard §6 / principle 8: the gold set is a frozen ruler —
 * versioned, append-only. A case that changed after freezing makes old and
 * new results incomparable, so it fails here until it gets a new id or the
 * set gets a new version.
 */
const EVAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval');
const CASES = join(EVAL, 'cases');
const meta = JSON.parse(readFileSync(join(EVAL, 'cases-version.json'), 'utf8'));
const frozen = new Map(
  readFileSync(join(EVAL, meta.manifest), 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split(/ {2}/).reverse()),
);

test('the gold set declares a version and a freeze date', () => {
  assert.match(meta.version, /^\d+$/);
  assert.ok(!Number.isNaN(Date.parse(meta.frozen_at)), meta.frozen_at);
});
test('every frozen case is unchanged, and every case file is frozen', () => {
  const files = readdirSync(CASES).filter((f) => /^G\d+\.json$/.test(f));
  for (const f of files) {
    assert.ok(frozen.has(f), `${f} is not in ${meta.manifest} — freeze it (append) before use`);
    const h = createHash('sha256')
      .update(readFileSync(join(CASES, f)))
      .digest('hex');
    assert.equal(
      h,
      frozen.get(f),
      `${f} changed after freezing — give it a new id or bump the set version`,
    );
  }
  for (const f of frozen.keys())
    assert.ok(files.includes(f), `${f} was removed — the set is append-only`);
});
