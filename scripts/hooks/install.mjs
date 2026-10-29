#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// `npm install` (prepare) and `npm run hooks`: point git at scripts/hooks so
// the self-evolution gate runs for every clone. Outside a git checkout (a
// package installed from the registry) this does nothing.

import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...a) =>
  execFileSync('git', a, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
let top;
try {
  top = git('rev-parse', '--show-toplevel');
} catch {
  process.exit(0);
}
if (top !== ROOT && git('rev-parse', '--show-prefix') !== '') process.exit(0); // vendored copy: not ours to configure
for (const h of ['pre-commit', 'commit-msg', 'pre-push'])
  chmodSync(join(ROOT, 'scripts', 'hooks', h), 0o755);
git('config', 'core.hooksPath', 'scripts/hooks');
console.log('self-evolution: git hooks active (core.hooksPath = scripts/hooks)');
