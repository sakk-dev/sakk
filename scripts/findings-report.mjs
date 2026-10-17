#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Testing standard §14.6: the five evolution indicators from
// findings/ledger.json, with the counting rule printed next to each number
// (§12.4). Informational — the ledger's own gate is
// test/findings-ledger.test.mjs. Exit 1 only if the ledger cannot be read.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let ledger;
try {
  ledger = JSON.parse(readFileSync(join(ROOT, 'findings', 'ledger.json'), 'utf8'));
} catch (e) {
  console.error(`FINDINGS_UNREADABLE: ${e.message}`);
  process.exit(1);
}
const F = [...ledger.findings].sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
const mech = ledger.class_mechanisms ?? {};
const pct = (a, b) => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(0)}% (${a}/${b})`);

const seen = new Set();
let recurrent = 0;
for (const f of F) {
  if (seen.has(f.rc[0])) recurrent += 1;
  for (const r of f.rc) seen.add(r);
}
const AFTER_GATES = ['review', 'human', 'prod', 'client'];
const escaped = F.filter((f) => AFTER_GATES.includes(f.found_by)).length;
const closed = F.filter((f) => f.status !== 'open');
const hasDetector = (rc) => (mech[rc]?.refs ?? []).some((r) => r.kind === 'detector');
const classClosed = closed.filter((f) => f.rc.some(hasDetector)).length;
const refs = Object.values(mech).flatMap((m) => m.refs);
const mechanized = refs.filter((r) => r.kind === 'detector' || r.kind === 'runtime_guard').length;
const swept = F.filter((f) => f.sweep_status === 'done').length;

const byRc = {};
for (const f of F) for (const r of f.rc) byRc[r] = (byRc[r] ?? 0) + 1;
const byStatus = {};
for (const f of F) byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;

console.log(
  `findings ${F.length} · ${Object.entries(byStatus)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ')}`,
);
console.log(
  `by root-cause class: ${Object.entries(byRc)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join(' ')}`,
);
console.log(
  `class recurrence rate  ↓ ${pct(recurrent, F.length)}   primary RC already seen in an earlier finding`,
);
console.log(
  `escape rate           ↓ ${pct(escaped, F.length)}   found by review/human/prod/client, i.e. after the automated gates`,
);
console.log(
  `class-level closure   ↑ ${pct(classClosed, closed.length)}   closed findings whose class has a running detector`,
);
console.log(
  `mechanization rate    ↑ ${pct(mechanized, refs.length)}   class-mechanism refs that are detectors or runtime guards`,
);
console.log(
  `sweep completion      ↑ ${pct(swept, F.length)}   findings whose lateral sweep is done`,
);
// self-evolution (docs/SELF_EVOLUTION.md): findings in a class whose detector
// already existed, and how many of those upgraded a check rather than only
// fixing the instance
const num = (id) => Number(id.slice(2));
const escapedPast = F.filter((f) =>
  f.rc.some((rc) =>
    (mech[rc]?.refs ?? []).some((r) => r.kind === 'detector' && num(r.since) < num(f.id)),
  ),
);
const upgraded = escapedPast.filter((f) => !String(f.mechanism_upgrade ?? '').startsWith('none:'));
console.log(
  `past-detector escapes ↓ ${pct(escapedPast.length, F.length)}   findings whose class already had a detector that missed them`,
);
console.log(
  `detector upgrade rate ↑ ${pct(upgraded.length, escapedPast.length)}   of those, escapes that upgraded a check (not only the instance)`,
);
const open = F.filter((f) => f.status === 'open');
if (open.length) console.log(`open: ${open.map((f) => `${f.id} ${f.title}`).join(' | ')}`);
