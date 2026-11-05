// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * F-241: the flat-cost test patched `fs.readFileSync` on the default `node:fs`
 * import, but the code under test calls the named import, which only follows
 * the patch after `syncBuiltinESMExports()`. The counter could never see a
 * read, so the "flat" check passed on zero reads whatever the code did. This
 * refuses that shape anywhere in test/ or scripts/: a file that assigns to a
 * member of a default or namespace builtin import must also sync it.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Lines that patch a builtin import, when the file never syncs the patch. */
export function unsyncedPatches(src) {
  if (/\bsyncBuiltinESMExports\s*\(/.test(src)) return [];
  const names = [
    ...src.matchAll(
      /^\s*import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s+['"]node:[^'"]+['"]/gm,
    ),
  ].map((m) => m[1]);
  if (names.length === 0) return [];
  const alt = names.map((n) => n.replace(/\$/g, '\\$')).join('|');
  const patch = new RegExp(
    `(?<![\\w$.])(?:${alt})(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]]+\\])\\s*=(?!=)`,
  );
  return src
    .split('\n')
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter(({ text }) => !text.startsWith('//') && !text.startsWith('*') && patch.test(text));
}

function mjsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...mjsFiles(p));
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

test('a test that patches a builtin also syncs it to named imports (F-241)', () => {
  // control: the detector sees the pre-F-241 shape, and passes the synced one
  const unsynced = [
    "import fs from 'node:fs';",
    'const orig = fs.readFileSync;',
    'fs.readFileSync = (f, ...r) => orig(f, ...r);',
    'if (fs.readFileSync === orig) fs.readFileSync = orig;',
  ].join('\n');
  assert.deepEqual(
    unsyncedPatches(unsynced).map((h) => h.line),
    [3, 4],
    'the detector missed an unsynced patch',
  );
  assert.deepEqual(
    unsyncedPatches(
      `${unsynced}\nimport { syncBuiltinESMExports } from 'node:module';\nsyncBuiltinESMExports();`,
    ),
    [],
  );
  assert.deepEqual(
    unsyncedPatches("import * as cp from 'node:child_process';\ncp['spawn'] = f;").length,
    1,
  );
  assert.deepEqual(
    unsyncedPatches("import assert from 'node:assert/strict';\nassert.equal(a, b);"),
    [],
  );

  const files = [...mjsFiles(join(ROOT, 'test')), ...mjsFiles(join(ROOT, 'scripts'))];
  assert.ok(files.length > 20, `scanned only ${files.length} files`);
  const hits = files.flatMap((f) =>
    unsyncedPatches(readFileSync(f, 'utf8')).map((h) => `${relative(ROOT, f)}:${h.line} ${h.text}`),
  );
  assert.deepEqual(
    hits,
    [],
    `these patch a builtin without syncBuiltinESMExports(), so named imports never see it:\n${hits.join('\n')}`,
  );
});
