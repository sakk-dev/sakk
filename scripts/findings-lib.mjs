// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by `npm run brief`, the git hooks, the Claude Code edit hook and
// the CI check (docs/SELF_EVOLUTION.md): which questions a change must
// answer before it is made, and whether this branch's answers cover them.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** The repository root that carries a problem-class registry, walking up from `start`. */
export function findRoot(start) {
  let d = resolve(start);
  for (;;) {
    if (
      existsSync(join(d, 'findings', 'classes.json')) &&
      existsSync(join(d, 'findings', 'ledger.json'))
    )
      return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export function load(root) {
  return {
    ledger: JSON.parse(readFileSync(join(root, 'findings', 'ledger.json'), 'utf8')),
    registry: JSON.parse(readFileSync(join(root, 'findings', 'classes.json'), 'utf8')),
  };
}

/** Logging a problem is never blocked: these paths require no answers. */
export const EXEMPT = (rel) => rel.startsWith('findings/') || rel.startsWith('audit-logs/');

const norm = (p) => p.replace(/^\.\//, '').replace(/\/+$/, '');
/** An area covers a path when one contains the other. */
export const covers = (area, path) => {
  const a = norm(area);
  return path === a || path.startsWith(`${a}/`) || a.startsWith(`${path}/`);
};

/** The three classes with the most findings: asked of every change. */
export function watchList(ledger) {
  const n = {};
  for (const f of ledger.findings) n[f.class] = (n[f.class] ?? 0) + 1;
  return Object.entries(n)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => c);
}

/** Questions a change to `files` must answer: its classes' questions plus the watch list's. */
export function required(ledger, registry, files) {
  const byClass = Object.fromEntries(registry.classes.map((c) => [c.id, c]));
  const out = new Map(); // qid → { classId, ask, files:Set, findings:Set }
  const add = (cid, file, fid) => {
    for (const q of byClass[cid]?.questions ?? []) {
      if (!out.has(q.id))
        out.set(q.id, { classId: cid, ask: q.ask, files: new Set(), findings: new Set() });
      const e = out.get(q.id);
      if (file) e.files.add(file);
      if (fid) e.findings.add(fid);
    }
  };
  const live = files.map(norm).filter((f) => f && !EXEMPT(f));
  for (const file of live)
    for (const f of ledger.findings)
      if ((f.areas ?? []).some((a) => covers(a, file))) add(f.class, file, f.id);
  if (live.length > 0) for (const c of watchList(ledger)) add(c, null, null);
  return out;
}

export const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, '-');
export function branchOf(root) {
  try {
    const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return b === 'HEAD' ? 'detached' : b;
  } catch {
    return 'no-git';
  }
}
export const ackPath = (root, branch) => join(root, 'findings', 'acks', `${slug(branch)}.json`);

// non-answers only: 'No, because …' and 'Not applicable: …' are answers
const PLACEHOLDER = /^(todo|tbd|fixme|same( as)?|see above|ditto|as above|placeholder)\b/i;
const squash = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
/**
 * Which required questions lack an acceptable answer. An answer is at least
 * 40 characters, is not a placeholder or the question itself, and is not a
 * copy of another answer — copy-pasting one sentence everywhere is the
 * bypass this exists to stop.
 */
export function missingAnswers(ack, req) {
  const answers = ack?.answers ?? {};
  const seen = new Map();
  for (const [qid, a] of Object.entries(answers)) {
    const t = typeof a?.answer === 'string' ? squash(a.answer) : '';
    if (t) seen.set(t, [...(seen.get(t) ?? []), qid]);
  }
  const missing = [];
  for (const [qid, q] of req) {
    const a = answers[qid]?.answer;
    let why = null;
    if (typeof a !== 'string' || a.trim() === '') why = 'no answer';
    else if (a.trim().length < 40) why = 'shorter than 40 characters';
    else if (PLACEHOLDER.test(a.trim())) why = 'a placeholder, not an answer';
    else if (squash(a) === squash(q.ask)) why = 'repeats the question';
    else if ((seen.get(squash(a)) ?? []).length > 1)
      why = `the same text as ${seen
        .get(squash(a))
        .filter((x) => x !== qid)
        .join(', ')}`;
    if (why) missing.push({ qid, why, ...q });
  }
  return missing;
}

/** The message every enforcement point prints when answers are missing. */
export function explain({ root, branch, files, missing, ledger }) {
  const rel = (p) => relative(root, p);
  const lines = [
    `self-evolution: answer the ledger's questions before changing ${files.slice(0, 4).join(', ')}${files.length > 4 ? ', …' : ''}`,
    `write them to ${rel(ackPath(root, branch))} — {"branch": "${branch}", "answers": {"<id>": {"answer": "how this change avoids it"}}}`,
    '',
  ];
  const title = Object.fromEntries(ledger.findings.map((f) => [f.id, f.title]));
  for (const m of missing) {
    lines.push(`  ${m.qid} [${m.why}] ${m.ask}`);
    const past = [...m.findings].slice(0, 3);
    for (const id of past) lines.push(`        learned from ${id}: ${title[id]}`);
  }
  lines.push(
    '',
    'Run `npm run brief -- <paths>` for the full picture (past findings, blind spots, checks).',
  );
  return lines.join('\n');
}

/** Rule for commit messages: a fix names its finding, or says why there is none. */
export function messageProblem(message, ledger) {
  const subject = message.split('\n')[0];
  if (!/^(fix|hotfix|revert)\b|^fix\(/i.test(subject)) return null;
  const known = new Set(ledger.findings.map((f) => f.id));
  const cited = [...message.matchAll(/\bF-\d{2,}\b/g)].map((m) => m[0]);
  const unknown = cited.filter((id) => !known.has(id));
  if (unknown.length)
    return `cites findings not in the ledger: ${[...new Set(unknown)].join(', ')}`;
  if (cited.length) return null;
  const nf = /^No-finding:\s*(.{20,})$/m.exec(message);
  if (nf) return null;
  return 'a fix commit must name the finding it fixes (F-nn, logged in findings/ledger.json) or carry a "No-finding: <why there is none, 20+ characters>" line';
}
