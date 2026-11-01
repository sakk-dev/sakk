#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The open pull request cap (owner's rule, 2026-10-29): merge as you go, at most
// three pull requests in flight, drafts included. CI runs the base branch's copy
// of this file on every pull request (.github/workflows/ci.yml, base-checker):
// the three oldest open pull requests pass, a later one fails until one of them
// is merged or closed.
//
//   node scripts/wip-limit.mjs --pr <number>
//
// It asks gh for the open list (GH_TOKEN, GH_REPO). --from <file> reads that
// list from a JSON file instead; the tests use it.
//
// Exit 0 inside the cap, 1 over it or when it cannot judge, 2 usage.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LIMIT = 3;
const MAX_LISTED = 200;

/** Null when `current` is among the `limit` oldest open pull requests, else why not. */
export function wipProblem(open, current, limit = LIMIT) {
  if (!Array.isArray(open)) return 'the open pull request list is not a list';
  if (!Number.isInteger(current) || current < 1) return `not a pull request number: ${current}`;
  for (const p of open)
    if (!Number.isInteger(p?.number) || Number.isNaN(Date.parse(p?.createdAt)))
      return `an entry has no number or creation time: ${JSON.stringify(p)}`;
  if (!open.some((p) => p.number === current))
    return `#${current} is not among the ${open.length} open pull requests listed, so its place in the queue is unknown`;
  const queue = [...open].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number,
  );
  const place = queue.findIndex((p) => p.number === current);
  if (place < limit) return null;
  const ahead = queue
    .slice(0, limit)
    .map((p) => `#${p.number}`)
    .join(', ');
  return `#${current} is open pull request ${place + 1} of ${queue.length}; at most ${limit} may be in flight. Merge or close one of ${ahead} first, then re-run this check.`;
}

const USAGE = 'usage is node scripts/wip-limit.mjs --pr <number> [--from <list.json>]';
const usage = (code, why) => {
  console.error(`${code}: ${why}; ${USAGE}`);
  process.exit(2);
};

/** `--pr N [--from F]`, nothing else: an unknown or repeated flag refuses. */
export function parseArgs(argv) {
  const seen = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== '--pr' && flag !== '--from')
      return { code: 'USAGE_UNKNOWN_ARGUMENT', why: `unknown argument ${flag}` };
    if (flag in seen) return { code: 'USAGE_REPEATED_ARGUMENT', why: `${flag} given twice` };
    if (value === undefined || value.startsWith('--'))
      return { code: 'USAGE_MISSING_VALUE', why: `${flag} needs a value` };
    seen[flag] = value;
  }
  if (!('--pr' in seen)) return { code: 'USAGE_MISSING_PR', why: '--pr is required' };
  if (!/^[1-9]\d{0,9}$/.test(seen['--pr']))
    return { code: 'USAGE_BAD_PR', why: `--pr must be a pull request number, got ${seen['--pr']}` };
  return { pr: Number(seen['--pr']), from: seen['--from'] };
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  if (a.code) usage(a.code, a.why);
  let text;
  try {
    text = a.from
      ? readFileSync(a.from, 'utf8')
      : execFileSync(
          'gh',
          [
            'pr',
            'list',
            '--state',
            'open',
            '--json',
            'number,createdAt',
            '--limit',
            String(MAX_LISTED),
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 },
        );
  } catch (e) {
    console.error(
      `wip-limit: cannot read the open pull requests (${e.code ?? e.status ?? e.message}); the cap cannot judge, so it fails`,
    );
    process.exit(1);
  }
  let open;
  try {
    open = JSON.parse(text);
  } catch {
    console.error(
      'wip-limit: the open pull request list is not JSON; the cap cannot judge, so it fails',
    );
    process.exit(1);
  }
  if (Array.isArray(open) && open.length >= MAX_LISTED) {
    console.error(
      `wip-limit: ${open.length} open pull requests reached the listing limit; the queue may be cut, so the cap fails`,
    );
    process.exit(1);
  }
  const p = wipProblem(open, a.pr);
  if (p) {
    console.error(`wip-limit: ${p}`);
    process.exit(1);
  }
  console.log(
    `wip-limit: #${a.pr} is within the ${LIMIT} oldest of ${open.length} open pull request(s)`,
  );
}
