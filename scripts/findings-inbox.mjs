#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The inbox guarantees that a problem someone saw ends up in the ledger
// (docs/SELF_EVOLUTION.md). `npm run audit` adds an item for every red step;
// a person or agent adds one for every review finding. The commit gate
// refuses while any item is untriaged.
//
//   npm run inbox -- add "<what was seen>" [--source review|audit|human|dispute]
//   npm run inbox -- resolve <item> F-nn       logged: as a new finding or an occurrence of its class
//   npm run inbox -- dismiss <item> "<why it is not a problem, 20+ characters>"
//   npm run inbox -- list

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'findings', 'inbox');

export function addItem(text, source = 'human', extra = {}) {
  mkdirSync(DIR, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  writeFileSync(
    join(DIR, `${id}.json`),
    `${JSON.stringify({ id, source, text, ...extra }, null, 1)}\n`,
  );
  return id;
}

const itemPath = (id) => join(DIR, id.endsWith('.json') ? id : `${id}.json`);
const usage = () => {
  console.error(
    'usage: npm run inbox -- add "<text>" [--source review|audit|human|dispute] | resolve <item> F-nn | dismiss <item> "<reason>" | list',
  );
  process.exit(2);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'add') {
    const si = rest.indexOf('--source');
    const source = si >= 0 ? rest[si + 1] : 'human';
    const text = rest.filter((_, i) => si < 0 || (i !== si && i !== si + 1)).join(' ');
    if (!text || !['review', 'audit', 'human', 'dispute'].includes(source)) usage();
    console.log(`inbox: added ${addItem(text, source)}`);
  } else if (cmd === 'resolve') {
    const [item, fid] = rest;
    if (!item || !/^F-\d{2,}$/.test(fid ?? '')) usage();
    if (!existsSync(itemPath(item))) {
      console.error(`inbox: no item ${item}`);
      process.exit(1);
    }
    const ledger = JSON.parse(readFileSync(join(ROOT, 'findings', 'ledger.json'), 'utf8'));
    if (!ledger.findings.some((f) => f.id === fid)) {
      console.error(`inbox: ${fid} is not in findings/ledger.json — log it first`);
      process.exit(1);
    }
    rmSync(itemPath(item));
    console.log(`inbox: ${item} resolved as ${fid}`);
  } else if (cmd === 'dismiss') {
    const [item, ...why] = rest;
    const reason = why.join(' ');
    if (!item || reason.trim().length < 20) usage();
    if (!existsSync(itemPath(item))) {
      console.error(`inbox: no item ${item}`);
      process.exit(1);
    }
    const body = JSON.parse(readFileSync(itemPath(item), 'utf8'));
    appendFileSync(
      join(ROOT, 'findings', 'dismissed.jsonl'),
      `${JSON.stringify({ ...body, dismissed_at: new Date().toISOString(), reason })}\n`,
    );
    rmSync(itemPath(item));
    console.log(`inbox: ${item} dismissed (recorded in findings/dismissed.jsonl)`);
  } else if (cmd === 'list') {
    const items = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];
    for (const f of items) {
      const b = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
      console.log(`${f.replace(/\.json$/, '')}  [${b.source}] ${b.text}`);
    }
    if (items.length === 0) console.log('inbox: empty');
  } else usage();
}
