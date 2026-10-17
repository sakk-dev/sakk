#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// The self-evolution loop, enforced (docs/SELF_EVOLUTION.md). One checker,
// four places it runs:
//
//   --edit          Claude Code PreToolUse hook: hook JSON on stdin. Blocks
//                   (exit 2) an edit until this branch has answered the
//                   ledger's questions for the file.
//   --staged        git pre-commit: the same for every staged file, from the
//                   STAGED answers file; and no untriaged inbox item.
//   --commit-msg F  git commit-msg: a fix commit names the finding it fixes
//                   (F-nn in the ledger) or says why there is none.
//   --range BASE    CI: every file changed since BASE is answered, and every
//                   commit since the rule existed follows the message rule —
//                   so --no-verify locally does not get past it.
//
// Exit 0 pass, 1 violation (2 for the edit hook, which is how Claude Code
// blocks a tool call), 2 usage.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  EXEMPT,
  ackPath,
  branchOf,
  explain,
  findRoot,
  load,
  messageProblem,
  missingAnswers,
  required,
  slug,
} from './findings-lib.mjs';

const args = process.argv.slice(2);
const mode = args[0];
const git = (root, ...a) =>
  execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const fail = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

/** Untriaged inbox items: a red audit step or a recorded review finding not yet in the ledger. */
function inbox(root) {
  const d = join(root, 'findings', 'inbox');
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')) : [];
}

if (mode === '--edit') {
  let hook;
  try {
    hook = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // not a hook payload: nothing to check
  }
  const file = hook?.tool_input?.file_path ?? hook?.tool_input?.notebook_path;
  if (typeof file !== 'string' || file === '') process.exit(0);
  const abs = resolve(hook?.cwd ?? process.cwd(), file);
  const root = findRoot(join(abs, '..'));
  if (!root) process.exit(0); // not a repository that keeps a ledger
  const rel = relative(root, abs);
  if (rel.startsWith('..') || EXEMPT(rel)) process.exit(0);
  const { ledger, registry } = load(root);
  const branch = branchOf(root);
  const req = required(ledger, registry, [rel]);
  const ap = ackPath(root, branch);
  const ack = existsSync(ap) ? JSON.parse(readFileSync(ap, 'utf8')) : null;
  const missing = missingAnswers(ack, req);
  if (missing.length) fail(explain({ root, branch, files: [rel], missing, ledger }), 2);
  process.exit(0);
}

const root = findRoot(process.cwd());
if (!root) fail('findings-check: no findings/classes.json above the current directory', 2);
const { ledger, registry } = load(root);

if (mode === '--staged') {
  const files = git(root, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
  const branch = branchOf(root);
  const rel = relative(root, ackPath(root, branch));
  let ack = null;
  try {
    ack = JSON.parse(git(root, 'show', `:${rel}`)); // the answers being committed, not a draft
  } catch {
    /* none staged */
  }
  const missing = missingAnswers(ack, required(ledger, registry, files));
  const problems = [];
  if (missing.length) problems.push(explain({ root, branch, files, missing, ledger }));
  const items = inbox(root);
  if (items.length)
    problems.push(
      `self-evolution: ${items.length} untriaged item(s) in findings/inbox/ (${items.join(', ')}) — log each in findings/ledger.json (new finding or an occurrence of its class) and delete it, or record why it is not a problem in findings/dismissed.jsonl`,
    );
  if (problems.length) fail(problems.join('\n\n'));
  process.exit(0);
}

if (mode === '--commit-msg') {
  if (!args[1]) fail('usage: findings-check --commit-msg <file>', 2);
  const msg = readFileSync(args[1], 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n');
  let staged = ledger;
  try {
    staged = JSON.parse(git(root, 'show', ':findings/ledger.json'));
  } catch {
    /* fall back to the working copy */
  }
  const p = messageProblem(msg, staged);
  if (p) fail(`self-evolution: ${p}`);
  process.exit(0);
}

if (mode === '--range') {
  const base = args[1];
  if (!base) fail('usage: findings-check --range <base-ref>', 2);
  const files = git(root, 'diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
  const branch = process.env.SAKK_BRANCH || branchOf(root);
  const ap = ackPath(root, branch);
  const ack = existsSync(ap) ? JSON.parse(readFileSync(ap, 'utf8')) : null;
  const problems = [];
  const missing = missingAnswers(ack, required(ledger, registry, files));
  if (missing.length) problems.push(explain({ root, branch, files, missing, ledger }));
  // the message rule binds commits made after it existed (its parent has the checker)
  for (const c of git(root, 'rev-list', `${base}..HEAD`).split('\n').filter(Boolean)) {
    let ruled = true;
    try {
      git(root, 'cat-file', '-e', `${c}^:scripts/findings-check.mjs`);
    } catch {
      ruled = false;
    }
    if (!ruled) continue;
    let atC = ledger;
    try {
      atC = JSON.parse(git(root, 'show', `${c}:findings/ledger.json`));
    } catch {
      /* keep HEAD's */
    }
    const p = messageProblem(git(root, 'log', '-1', '--format=%B', c), atC);
    if (p) problems.push(`commit ${c.slice(0, 7)}: ${p}`);
  }
  if (problems.length) fail(problems.join('\n\n'));
  console.log(
    `self-evolution: ${files.length} changed file(s) answered in findings/acks/${slug(branch)}.json; commit messages follow the finding rule`,
  );
  process.exit(0);
}

fail('usage: findings-check --edit | --staged | --commit-msg <file> | --range <base>', 2);
