// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * F-239: the gateway's outage tests write a stand-in `node` script, and the gateway
 * spawns it under a 1 s SAKK_TIMEOUT_S. macOS checks a freshly written executable on
 * its first run (0.3-1.0 s measured), so the gateway's first spawn timed out and o1/o2
 * failed on a Mac while Linux CI stayed green. Linux has no such delay, so the slow
 * first run cannot be reproduced here. This checks the shape instead: every helper in
 * the gateway tests that makes a file executable runs it before handing it back.
 * The behavior itself is checked by o1 ("the first call is metered") in the CI
 * `gateway` job, which has LiteLLM installed.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'integrations', 'litellm', 'test_sakk_gateway.py');

/** Each `def` with its body: the lines after it that are indented deeper. */
function functions(src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)def (\w+)\(/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() !== '' && l.length - l.trimStart().length <= m[1].length) break;
      body.push(l);
    }
    out.push({ name: m[2], body });
  }
  return out;
}

// `w.chmod(0o755)` or `os.chmod(w, 0o755)`: the owner may execute it
const CHMOD = [/(\w+)\.chmod\(\s*0o7[0-7]{2}\s*\)/, /os\.chmod\(\s*(\w+)\s*,\s*0o7[0-7]{2}\s*\)/];

test('every stand-in script the gateway tests write runs once before it is timed (F-239)', () => {
  const makers = [];
  for (const f of functions(readFileSync(FILE, 'utf8'))) {
    f.body.forEach((line, k) => {
      const v = CHMOD.map((re) => re.exec(line)?.[1]).find(Boolean);
      if (!v) return;
      const run = new RegExp(
        `subprocess\\.run\\(\\s*\\[\\s*(?:str\\(\\s*${v}\\s*\\)|${v})\\s*[,\\]]`,
      );
      makers.push({ name: f.name, warmed: f.body.slice(k + 1).some((l) => run.test(l)) });
    });
  }
  // control: the check found the stand-in, so it cannot pass on zero helpers
  assert.ok(makers.length > 0, `no helper in ${FILE} makes an executable stand-in`);
  const cold = makers.filter((m) => !m.warmed).map((m) => m.name);
  assert.deepEqual(
    cold,
    [],
    `these helpers hand back a script that has never run: ${cold.join(', ')}`,
  );
});
