#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Self-evolution, step 1 (docs/SELF_EVOLUTION.md): before changing code,
// read what the findings ledger already learned about it — and answer it.
//
//   npm run brief                   files changed on this branch (vs main), staged, unstaged, untracked
//   npm run brief -- <path>...      the files or directories you are about to change
//
// Prints the problem classes that touch those paths (past findings, open
// ones first), the questions this branch must answer before the change can
// be edited or committed, whether findings/acks/<branch>.json answers them,
// the known blind spots of the checks that guard those classes, and the
// checks. Informational: exit 0, or 2 when the ledger cannot be read or an
// argument is not understood. Enforcement lives in scripts/findings-check.mjs.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ackPath,
  branchOf,
  covers,
  load,
  missingAnswers,
  required,
  watchList,
} from './findings-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('-'));
if (flags.length > 0) {
  console.error(`usage: npm run brief [-- <path>...]   (unknown: ${flags.join(' ')})`);
  process.exit(2);
}

let ledger;
let registry;
try {
  ({ ledger, registry } = load(ROOT));
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
      ...(base ? git('diff', '--name-only', '--no-renames', base, 'HEAD') : []),
      ...git('diff', '--name-only', '--no-renames'),
      ...git('diff', '--name-only', '--no-renames', '--cached'),
      ...git('ls-files', '--others', '--exclude-standard'),
    ]),
  ].sort();
};
const paths = (args.length > 0 ? args : changed())
  .map((p) => p.replace(/^\.\//, '').replace(/\/+$/, ''))
  .filter(Boolean);
if (paths.length === 0) {
  console.log('brief: no changed files found — pass the paths you are about to change:');
  console.log('  npm run brief -- src/ledger.mjs');
  process.exit(0);
}

const byClass = Object.fromEntries(registry.classes.map((c) => [c.id, c]));
const num = (id) => Number(id.slice(2));
const hits = ledger.findings.filter((f) =>
  (f.areas ?? []).some((a) => paths.some((p) => covers(a, p))),
);
const branch = branchOf(ROOT);
const ap = ackPath(ROOT, branch);
const ack = existsSync(ap) ? JSON.parse(readFileSync(ap, 'utf8')) : null;
const req = required(ledger, registry, paths);
const missing = new Set(missingAnswers(ack, req).map((m) => m.qid));

const out = [];
const line = (s = '') => out.push(s);
line(
  `brief — ${paths.length} path(s): ${paths.slice(0, 6).join(', ')}${paths.length > 6 ? ', …' : ''}`,
);
line();
const local = [...new Set(hits.map((f) => f.class))];
line(
  `Problem classes here: ${local.length}${local.length === 0 ? ' (none — the watch list below still applies)' : ''}`,
);
for (const cid of local) {
  const members = hits
    .filter((f) => f.class === cid)
    .sort((a, b) => (b.status === 'open') - (a.status === 'open') || num(b.id) - num(a.id));
  const total = ledger.findings.filter((f) => f.class === cid).length;
  line(`  ${cid} ${byClass[cid]?.name} — ${members.length} here, ${total} in the ledger`);
  for (const f of members.slice(0, 4))
    line(`      ${f.id}${f.status === 'open' ? ' OPEN' : ''}  ${f.title}`);
  if (members.length > 4)
    line(
      `      … ${members
        .slice(4)
        .map((f) => f.id)
        .join(' ')}`,
    );
}

line();
line(`Answer before you change (${relative(ROOT, ap)}):`);
const watch = watchList(ledger);
for (const [qid, q] of [...req].sort()) {
  const mark = missing.has(qid) ? 'TO ANSWER' : 'answered ';
  line(
    `  ${mark} ${qid}${watch.includes(q.classId) && !local.includes(q.classId) ? ' (watch list)' : ''}  ${q.ask}`,
  );
}
if (missing.size)
  line(
    `  → ${missing.size} unanswered: edits (Claude Code hook) and commits (git hook, CI) are refused until they are`,
  );

line();
line('Known blind spots of the checks that will run (latest escapes past a detector):');
let blind = 0;
for (const cid of [...new Set([...local, ...watch])]) {
  const esc = ledger.findings
    .filter((f) => f.class === cid && f.mechanism_gap)
    .sort((a, b) => num(b.id) - num(a.id));
  for (const f of esc.slice(0, 2)) {
    blind += 1;
    line(`  ${cid} ${f.id}: ${f.mechanism_gap}`);
  }
}
if (blind === 0) line('  none recorded for these classes');

line();
line('Checks that guard these classes (they run in npm test / the gate / CI):');
for (const cid of [...new Set([...local, ...watch])])
  for (const r of byClass[cid]?.detectors ?? []) line(`  ${cid} ${r}`);

line();
line(
  'Found something? `npm run inbox -- add "<what>"`, then log it in findings/ledger.json under its',
);
line('class (a new instance of a known class is an occurrence, never a new class).');
console.log(out.join('\n'));
