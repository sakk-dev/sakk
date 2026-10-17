#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Self-evolution, step 1 (docs/SELF_EVOLUTION.md): before changing code,
// read what the findings ledger already learned about it.
//
//   npm run brief                   files changed on this branch (vs main), staged, unstaged, untracked
//   npm run brief -- <path>...      the files or directories you are about to change
//
// Prints the past findings whose `areas` cover those paths, the questions
// from findings/prevention.json for their root-cause classes, the known blind
// spots of the checks that guard those classes (why earlier findings slipped
// past them), and the checks themselves. Informational: exit 0, or 2 when the
// ledger cannot be read or an argument is not understood.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOW = 12;

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('-'));
if (flags.length > 0) {
  console.error(`usage: npm run brief [-- <path>...]   (unknown: ${flags.join(' ')})`);
  process.exit(2);
}

let ledger;
let prevention;
try {
  ledger = JSON.parse(readFileSync(join(ROOT, 'findings', 'ledger.json'), 'utf8'));
  prevention = JSON.parse(readFileSync(join(ROOT, 'findings', 'prevention.json'), 'utf8'));
} catch (e) {
  console.error(`FINDINGS_UNREADABLE: ${e.message}`);
  process.exit(2);
}

const git = (...a) => {
  try {
    return execFileSync('git', a, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};
const changed = () => {
  const base = git('merge-base', 'HEAD', 'main')[0];
  return [
    ...new Set([
      ...(base ? git('diff', '--name-only', base, 'HEAD') : []),
      ...git('diff', '--name-only'),
      ...git('diff', '--name-only', '--cached'),
      ...git('ls-files', '--others', '--exclude-standard'),
    ]),
  ].sort();
};

const norm = (p) => p.replace(/^\.\//, '').replace(/\/+$/, '');
const paths = (args.length > 0 ? args : changed()).map(norm).filter(Boolean);
if (paths.length === 0) {
  console.log('brief: no changed files found — pass the paths you are about to change:');
  console.log('  npm run brief -- src/ledger.mjs');
  process.exit(0);
}

/** An area covers a path when one contains the other (file, or directory prefix). */
const covers = (area, path) => {
  const a = norm(area);
  return path === a || path.startsWith(`${a}/`) || a.startsWith(`${path}/`);
};
const F = ledger.findings;
const num = (id) => Number(id.slice(2));
const hits = F.filter((f) => (f.areas ?? []).some((a) => paths.some((p) => covers(a, p)))).sort(
  (a, b) => (a.status === 'open') - (b.status === 'open') || num(a.id) - num(b.id),
);
hits.reverse(); // open first, then newest

const out = [];
const line = (s = '') => out.push(s);
line(
  `brief — ${paths.length} path(s): ${paths.slice(0, 6).join(', ')}${paths.length > 6 ? ', …' : ''}`,
);
line();
line(
  `Past findings here: ${hits.length}${hits.length === 0 ? ' (none — the global watch list below still applies)' : ''}`,
);
for (const f of hits.slice(0, SHOW))
  line(
    `  ${f.id} ${f.status === 'open' ? 'OPEN ' : ''}[${f.rc.join(',')}${f.pattern ? ` ${f.pattern}` : ''}] ${f.title}`,
  );
if (hits.length > SHOW)
  line(
    `  … ${hits.length - SHOW} more (ids: ${hits
      .slice(SHOW)
      .map((f) => f.id)
      .join(' ')})`,
  );

// classes: those of the local findings, plus the three most frequent overall
const count = {};
for (const f of F) for (const r of f.rc) count[r] = (count[r] ?? 0) + 1;
const watch = Object.entries(count)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3)
  .map(([r]) => r);
const local = [...new Set(hits.flatMap((f) => f.rc))];
const classes = [...new Set([...local, ...watch])];
const patterns = [...new Set(hits.map((f) => f.pattern).filter(Boolean))];
if (!patterns.includes('fail-open-absence')) patterns.push('fail-open-absence'); // the most frequent pattern, always

line();
line('Ask before you build (findings/prevention.json):');
for (const rc of classes)
  for (const q of prevention.classes?.[rc] ?? [])
    line(
      `  ${rc}${local.includes(rc) ? '' : ' (watch list)'}  ${q.ask}  [${q.learned_from.join(' ')}]`,
    );
for (const p of patterns)
  for (const q of prevention.patterns?.[p] ?? [])
    line(`  ${p}  ${q.ask}  [${q.learned_from.join(' ')}]`);

line();
line('Known blind spots of the checks that will run (latest escapes past a class detector):');
let blind = 0;
for (const rc of classes) {
  const esc = F.filter((f) => f.rc.includes(rc) && f.mechanism_gap).sort(
    (a, b) => num(b.id) - num(a.id),
  );
  for (const f of esc.slice(0, 2)) {
    blind += 1;
    line(`  ${rc} ${f.id}: ${f.mechanism_gap}`);
  }
}
if (blind === 0) line('  none recorded for these classes');

line();
line('Checks that guard these classes (they run in npm test / the gate):');
for (const rc of classes)
  for (const r of (ledger.class_mechanisms?.[rc]?.refs ?? []).filter((x) => x.kind === 'detector'))
    line(`  ${rc} ${r.ref}`);

line();
line(
  'Found something new? Add it to findings/ledger.json — areas, root cause, guard; if its class',
);
line('already had a detector, also mechanism_gap (why the check missed it) and mechanism_upgrade.');
console.log(out.join('\n'));
