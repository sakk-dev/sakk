// SPDX-License-Identifier: Apache-2.0
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

/**
 * Questions a change to `files` must answer: its classes' questions plus the
 * watch list's. `watch` asks the watch list even with no file named — for a
 * shell command whose targets cannot be read (R1).
 */
export function required(ledger, registry, files, { watch = false } = {}) {
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
  if (live.length > 0 || watch) for (const c of watchList(ledger)) add(c, null, null);
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
 * bypass this exists to stop. In a version-2 answers file every answer also
 * names its guard (R3); whether the guard resolves is checked at commit.
 */
export function missingAnswers(ack, req, { v2 = ack?.version === 2 } = {}) {
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
    else if (v2) why = guardProblem(answers[qid]?.guard);
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

// ---------------------------------------------------------------------------
// Closing the bypasses (specs/self-evolution/spec.md, R1–R5).

const num = (id) => Number(String(id).slice(2));

/** Answer files new on a branch are version 2: every answer names a guard (R3). */
export const GUARD = /^(none: .{20,}|[\w.@/-]+\.\w+::.{3,})$/s;
export function guardProblem(guard) {
  if (typeof guard !== 'string' || guard.trim() === '')
    return 'no guard — name the check: "path::test name", or "none: <why there is none, 20+ characters>"';
  if (!GUARD.test(guard.trim()))
    return 'guard is not "path::test name" or "none: <why there is none, 20+ characters>"';
  const g = guard.trim();
  const path = g.startsWith('none: ') ? null : g.slice(0, g.indexOf('::'));
  if (path !== null && (!TEST_PATH.test(path) || /\.(md|txt|json|ya?ml)$/i.test(path)))
    return `guard must point at a test file, not ${path} (review I4)`;
  return null;
}
/** A guard is a test: a file in a test folder or named like a test — never the answers file or a doc. */
export const TEST_PATH =
  /^(?!findings\/)(?:(?:[\w.@-]+\/)*(?:test|tests|__tests__|spec|specs)\/[\w.@/-]+|(?:[\w.@-]+\/)*[\w.@-]*(?:\.test|\.spec|_test)\.\w+|(?:[\w.@-]+\/)*test_[\w.@-]+\.\w+)$/;

/** `path::name` resolves when the file exists and contains the name. `read(path)` returns text or null. */
export function resolveRef(ref, read) {
  const i = ref.indexOf('::');
  const path = i < 0 ? ref : ref.slice(0, i);
  const name = i < 0 ? '' : ref.slice(i + 2);
  const text = read(path);
  if (text === null) return false;
  return name === '' || text.includes(name);
}

/**
 * Guards in an answers file (answers and revisions) that do not resolve. A
 * guard a later revision supersedes may stop resolving only when that
 * revision's finding records a correction from it — a gap test renamed to the
 * fix (F-178); the current guard always resolves.
 */
export function guardResolution(ack, read, ledger) {
  const out = [];
  const byId = new Map((ledger?.findings ?? []).map((f) => [f?.id, f]));
  const retires = (r, g) => {
    const cs = byId.get(r?.finding)?.corrections;
    return (Array.isArray(cs) ? cs : []).some(
      (c) => c?.from === g && typeof c.why === 'string' && c.why.trim().length >= 20,
    );
  };
  for (const [qid, a] of Object.entries(ack?.answers ?? {})) {
    const revisions = Array.isArray(a?.revisions) ? a.revisions : [];
    for (const [i, [where, g]] of [
      [qid, a?.guard],
      ...revisions.map((r, k) => [`${qid} revision ${k + 1}`, r?.guard]),
    ].entries()) {
      if (typeof g !== 'string' || g.startsWith('none: ')) continue;
      if (revisions.slice(i).some((r) => retires(r, g))) continue;
      if (!resolveRef(g, read))
        out.push(`${where}: guard ${g} does not resolve (no such file or name)`);
    }
  }
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/**
 * R2: once committed, an answer and its guard never change; corrections are
 * appended as revisions that name a ledger finding. `prev` is the committed
 * answers file (or null), `next` the one being committed.
 */
export function ackRewrites(prev, next, ledgerIds) {
  const out = [];
  if (!prev) return out;
  if (prev.version === 2 && next?.version !== 2) out.push('the answers file dropped "version": 2');
  const pa = prev.answers ?? {};
  const na = next?.answers ?? {};
  for (const [qid, p] of Object.entries(pa)) {
    const n = na[qid];
    if (!n) {
      out.push(`${qid}: a committed answer was removed — answers are append-only`);
      continue;
    }
    if (n.answer !== p.answer || (p.guard !== undefined && n.guard !== p.guard))
      out.push(
        `${qid}: a committed answer was rewritten — keep it and append {"finding": "F-nn", "answer": "…", "guard": "…"} to its "revisions"`,
      );
    const pr = p.revisions ?? [];
    const nr = n.revisions ?? [];
    if (!pr.every((r, k) => same(r, nr[k])))
      out.push(`${qid}: a committed revision was changed or removed — revisions only grow`);
  }
  for (const [qid, n] of Object.entries(na))
    for (const [k, r] of (n.revisions ?? []).entries()) {
      if (!ledgerIds.has(r?.finding))
        out.push(
          `${qid} revision ${k + 1}: "finding" must name a finding in the ledger (got ${JSON.stringify(r?.finding)})`,
        );
      if (typeof r?.answer !== 'string' || r.answer.trim().length < 40)
        out.push(`${qid} revision ${k + 1}: the corrected answer is shorter than 40 characters`);
      const g = guardProblem(r?.guard);
      if (g) out.push(`${qid} revision ${k + 1}: ${g}`);
    }
  return out;
}

/**
 * R4: a finding introduced on this branch, in a class whose question this
 * branch answered, names the answer that failed. `onBranch(f)` says whether
 * the finding was introduced here ('worktree', or a commit in the range).
 */
export function answerFailedProblems(baseLedger, ledger, ack, onBranch) {
  const out = [];
  const before = new Set((baseLedger?.findings ?? []).map((f) => f.id));
  const answered = Object.keys(ack?.answers ?? {});
  for (const f of ledger.findings) {
    if (before.has(f.id) || !onBranch(f)) continue;
    const mine = answered.filter((q) => q.startsWith(`${f.class}.`));
    if (mine.length === 0) continue;
    const af = f.answer_failed;
    if (!af || typeof af !== 'object')
      out.push(
        `${f.id} (${f.class}) was introduced on this branch after it answered ${mine.join(', ')}: add "answer_failed": {"qid": "<one of them>", "why": "why the answer and its guard did not prevent it"}`,
      );
    else if (!mine.includes(af.qid))
      out.push(
        `${f.id}: answer_failed.qid must be one of this branch's answers for ${f.class} (${mine.join(', ')})`,
      );
    else if (typeof af.why !== 'string' || af.why.trim().length < 20)
      out.push(`${f.id}: answer_failed.why must say why the answer failed (20+ characters)`);
  }
  return out;
}

/**
 * R5: a class whose two latest escapes (findings with a mechanism_gap) both
 * upgraded nothing is stopped, until its registry entry carries a stopline
 * record for the later escape: a detector the class lists and that resolves,
 * a waiver, or debt not yet due. Returns Map classId → { escapes, why }.
 */
export function stoppedClasses(ledger, registry, { read, today }) {
  const esc = {};
  for (const f of ledger.findings) if (f.mechanism_gap) (esc[f.class] ??= []).push(f);
  // an upgrade counts only when it names a check that resolves — prose upgrades nothing (review I3)
  const upgraded = (f) => {
    const u = String(f.mechanism_upgrade ?? '');
    return u.includes('::') && resolveRef(u, read);
  };
  const out = new Map();
  for (const [cid, list] of Object.entries(esc)) {
    const last = list.sort((a, b) => num(a.id) - num(b.id)).slice(-2);
    if (last.length < 2 || last.some(upgraded)) continue;
    const after = last[1].id;
    const why = stoplineGap(
      registry.classes.find((c) => c.id === cid),
      after,
      { read, today },
    );
    if (why) out.set(cid, { escapes: last.map((f) => f.id), after, why });
  }
  return out;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Why a stopped class is not released, or null when its stopline record releases it. */
export function stoplineGap(cls, after, { read, today }) {
  const s = cls?.stopline;
  if (!s) return 'no stopline record';
  if (s.after !== after)
    return `the stopline record is for ${s.after}, not the latest escape ${after}`;
  if (s.detector !== undefined) {
    if (!(cls.detectors ?? []).includes(s.detector))
      return 'stopline.detector is not in the class detectors';
    if (!resolveRef(s.detector, read)) return `stopline.detector ${s.detector} does not resolve`;
    return null;
  }
  if (s.waiver !== undefined) {
    const w = s.waiver;
    if (
      !w ||
      typeof w.by !== 'string' ||
      !w.by.trim() ||
      !DAY.test(String(w.on)) ||
      typeof w.record !== 'string' ||
      w.record.trim().length < 20
    )
      return 'stopline.waiver needs {by, on: YYYY-MM-DD, record: 20+ characters}';
    return null;
  }
  if (s.debt !== undefined) {
    const d = s.debt;
    if (!d || typeof d.plan !== 'string' || d.plan.trim().length < 20 || !DAY.test(String(d.until)))
      return 'stopline.debt needs {plan: 20+ characters, until: YYYY-MM-DD}';
    if (today > d.until) return `stopline.debt was due ${d.until}`;
    return null;
  }
  return 'stopline needs one of detector, waiver or debt';
}

export const DEBT_WARN_DAYS = 7;
const MS_DAY = 86400000;
/**
 * Stop-line debts that fall due within `days` days, or are overdue: warn before
 * the gate locks. Advisory only; a malformed debt is skipped here because
 * stoplineGap already refuses it.
 */
export function debtsDueSoon(registry, today, days = DEBT_WARN_DAYS) {
  if (!DAY.test(String(today)))
    throw new Error(`debtsDueSoon: today must be YYYY-MM-DD, got ${today}`);
  const t = Date.parse(`${today}T00:00:00Z`);
  const out = [];
  for (const c of registry?.classes ?? []) {
    const until = c?.stopline?.debt?.until;
    if (!DAY.test(String(until))) continue;
    const at = Date.parse(`${until}T00:00:00Z`);
    if (Number.isNaN(at)) continue;
    const left = Math.round((at - t) / MS_DAY);
    if (left <= days)
      out.push({ id: String(c.id), until, left, plan: String(c.stopline.debt.plan ?? '') });
  }
  return out;
}

const PLAN_MAX = 200;
// C0, DEL, C1 and the Unicode line separators, as in src/secret-scan.mjs display()
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g;
const plural = (n) => `${n} day${n === 1 ? '' : 's'}`;
/**
 * One warning line for a due debt. With `actions`, a GitHub workflow command:
 * the text is encoded so a hand-edited plan cannot start a command of its own.
 */
export function debtWarning({ id, until, left, plan }, { actions = false } = {}) {
  const flat = (s) => String(s).replace(CONTROL, ' ').trim();
  const cid = flat(id).slice(0, 20);
  let p = flat(plan);
  if (p.length > PLAN_MAX) p = `${p.slice(0, PLAN_MAX)}…`;
  const text =
    left >= 0
      ? `stop-line debt on ${cid} falls due ${until} (${left === 0 ? 'today' : `in ${plural(left)}`}): after that day, changes that must answer ${cid} are refused until its plan lands or the owner decides. Plan: ${p}`
      : `stop-line debt on ${cid} was due ${until} (${plural(-left)} ago): changes that must answer ${cid} are refused until its plan lands or the owner decides. Plan: ${p}`;
  if (!actions) return `self-evolution: warning: ${text}`;
  const data = text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return `::warning title=stop-line debt::self-evolution: ${data}`;
}

/** Refusal text for the stopped classes a change must answer. */
export function stopProblems(req, stopped) {
  const hit = [...new Set([...req.values()].map((q) => q.classId))].filter((c) => stopped.has(c));
  return hit.map((c) => {
    const s = stopped.get(c);
    return `${c} is stopped: its last two escapes (${s.escapes.join(', ')}) upgraded no check, and ${s.why}. Before changing files that must answer ${c}, add a class detector to findings/classes.json and record {"stopline": {"after": "${s.after}", "detector": "<path::test name>"}} — or the owner's waiver, or dated debt (docs/SELF_EVOLUTION.md).`;
  });
}

// --- R1: shell commands -----------------------------------------------------

// One tokenizer for the loop and the guard (F-133): src/classify.mjs.
import { MAX_COMMAND, shellSegments } from '../src/classify.mjs';
export { MAX_COMMAND, shellSegments };

const READ_ONLY = new Set(
  (
    'cat head tail less more wc ls pwd grep egrep fgrep rg ag stat file du df which type whereis ' +
    'diff cmp comm sort uniq cut tr jq column nl date true false test [ basename dirname realpath ' +
    'readlink shasum sha256sum sha1sum md5 md5sum cksum xxd od hexdump strings tree printenv id ' +
    'whoami uname hostname echo printf sleep say open cd'
  ).split(' '),
);
const WRAPPERS = new Set(['sudo', 'command', 'nice', 'nohup', 'time', 'exec']);
const TARGET_ALL = new Set([
  'rm',
  'rmdir',
  'touch',
  'mkdir',
  'chmod',
  'chown',
  'truncate',
  'tee',
  'unlink',
]);
const TARGET_LAST = new Set(['cp', 'ln', 'install']);
const GIT_READ = new Set(
  (
    'status diff log show rev-parse ls-files ls-tree blame grep describe shortlog cat-file ' +
    'rev-list merge-base show-ref name-rev for-each-ref whatchanged'
  ).split(' '),
);
// record, or move between commits that already exist: no new file content
// (a commit meets pre-commit; merged content met its own gates)
const GIT_VCS = new Set(
  'add commit push fetch pull merge rebase branch tag worktree init clone notes'.split(' '),
);
/**
 * What a git command does to the working tree: 'read', 'vcs' (no new content),
 * 'write' (with targets) or 'opaque'. Copying content into tracked files,
 * discarding changes and deleting files are writes (review I1); setting a
 * config value is not a read (review I6).
 */
function gitKind(rest, isPath) {
  const [sub, ...a] = rest;
  const flags = a.filter((x) => x.startsWith('-'));
  const plain = a.filter((x) => !x.startsWith('-'));
  const dd = a.indexOf('--');
  const paths = dd >= 0 ? a.slice(dd + 1) : [];
  if (sub === undefined || GIT_READ.has(sub)) return { kind: 'read' };
  if (sub === 'config') {
    const query = a.some((x) => /^(--get(-all|-regexp)?|--list|-l)$/.test(x));
    return query || plain.length <= 1 ? { kind: 'read' } : { kind: 'opaque' };
  }
  if (sub === 'remote')
    return plain.length === 0 || ['show', 'get-url'].includes(plain[0])
      ? { kind: 'read' }
      : { kind: 'vcs' };
  if (sub === 'reflog')
    return plain.length === 0 || plain[0] === 'show' ? { kind: 'read' } : { kind: 'vcs' };
  if (sub === 'stash')
    return ['list', 'show'].includes(plain[0]) ? { kind: 'read' } : { kind: 'opaque' };
  if (sub === 'checkout' || sub === 'switch') {
    if (paths.length) return { kind: 'write', targets: paths };
    if (flags.some((f) => /^(-f|--force|-m|--merge|-p|--patch|--overwrite-ignore)$/.test(f)))
      return { kind: 'opaque' };
    const creates = flags.some((f) => /^(-[bBcC]|--orphan)$/.test(f));
    // `git checkout <ref> <path>` and `git checkout <path>` copy content without --
    if (sub === 'checkout' && !creates && plain.length > 1)
      return { kind: 'write', targets: plain.slice(1) };
    // one bare word is a branch unless it names a file or folder that exists
    if (sub === 'checkout' && !creates && plain.length === 1 && isPath(plain[0]))
      return { kind: 'write', targets: plain };
    return { kind: 'vcs' };
  }
  if (sub === 'restore') return { kind: 'write', targets: plain.length ? plain : ['.'] };
  if (sub === 'reset')
    return flags.some((f) => /^--(hard|merge|keep)$/.test(f))
      ? { kind: 'opaque' }
      : { kind: 'vcs' };
  if (sub === 'rm')
    return a.includes('--cached') ? { kind: 'vcs' } : { kind: 'write', targets: plain };
  if (sub === 'mv') return { kind: 'write', targets: plain };
  if (GIT_VCS.has(sub)) return { kind: 'vcs' };
  return { kind: 'opaque' }; // clean, apply, am, cherry-pick, revert, submodule, bisect, …
}
const NPM_READ =
  /^(test|t|lint|format:check|gate|audit|brief|inbox|findings-report|findings:check|test:[\w:-]+)$/;
const LOOP_TOOLS = /^scripts\/findings-(brief|check|inbox|report)\.mjs$/;

/**
 * R1. What a shell command may write. kind: 'read' (provably read-only),
 * 'write' (writes only the listed targets), 'opaque' (may write anything),
 * 'unclassifiable' (too long to read). Targets are absolute paths.
 */
export function classifyShell(cmd, cwd, home = process.env.HOME ?? '', exists = existsSync) {
  if (typeof cmd !== 'string') return { kind: 'unclassifiable', targets: [], why: 'no command' };
  if (cmd.length > MAX_COMMAND)
    return { kind: 'unclassifiable', targets: [], why: `longer than ${MAX_COMMAND} characters` };
  const { segs, redirects, opaque } = shellSegments(cmd);
  let here = cwd;
  const abs = (p) => (p.startsWith('~/') ? join(home, p.slice(2)) : resolve(here, p));
  const targets = [];
  let kind = opaque ? 'opaque' : 'read';
  const why = [];
  if (opaque) why.push('heredoc or command substitution');
  const write = (k, reason) => {
    if (k === 'opaque') kind = 'opaque';
    else if (kind === 'read') kind = 'write';
    why.push(reason);
  };
  for (const [i, seg] of segs.entries()) {
    for (const { target: r } of redirects.filter((x) => x.seg === i))
      if (!/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(r)) {
        targets.push(abs(r));
        write('write', `writes ${r}`);
      }
    let k = 0;
    for (;;) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[k] ?? '')) k++;
      else if (WRAPPERS.has(seg[k])) k++;
      else if (seg[k] === 'env') {
        k++;
        while ((seg[k] ?? '').startsWith('-')) k++;
      } else if (seg[k] === 'timeout') k += 2;
      else break;
    }
    const words = seg.slice(k);
    const name = (words[0] ?? '').split('/').pop();
    const args = words.slice(1);
    const plain = args.filter((a) => !a.startsWith('-'));
    if (words.length === 0) continue;
    if (name === 'cd') {
      if (args[0] && args[0] !== '-') here = abs(args[0]);
      continue;
    }
    if (READ_ONLY.has(name)) continue;
    if (name === 'find') {
      if (args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a)))
        write('opaque', 'find with -delete/-exec');
      continue;
    }
    if (name === 'sed') {
      let inPlace = false;
      const scripts = [];
      const files = [];
      for (let x = 0; x < args.length; x++) {
        const a = args[x];
        if (a === '-e' || a === '-f' || a === '--expression' || a === '--file')
          scripts.push(args[++x] ?? '');
        else if (a === '--in-place' || a.startsWith('--in-place=') || /^-[a-zA-Z]*i/.test(a)) {
          inPlace = true;
          // BSD sed takes the backup suffix as its own word: -i '' or -i .bak
          if (a === '-i' && (args[x + 1] === '' || /^\.[^/]*$/.test(args[x + 1] ?? ''))) x++;
        } else if (!a.startsWith('-')) files.push(a);
      }
      if (scripts.length === 0) scripts.push(files.shift() ?? '');
      const script = scripts.join(' ');
      if (inPlace) {
        for (const f of files) targets.push(abs(f));
        write('write', 'sed -i');
      } else if (/(^|[;}\s\d/])[wWe](\s|$)/.test(script))
        write('opaque', 'sed script writes or executes');
      continue;
    }
    if (name === 'awk' || name === 'gawk') {
      if (/>|\|\s*"|system\s*\(/.test(args.join(' '))) write('opaque', 'awk writes or executes');
      continue;
    }
    if (name === 'git') {
      let j = 0;
      let gitHere = here;
      while (j < args.length && args[j].startsWith('-')) {
        if (args[j] === '-C' && args[j + 1]) gitHere = resolve(gitHere, args[j + 1]);
        j += /^-(C|c)$|^--(git-dir|work-tree)$/.test(args[j]) ? 2 : 1;
      }
      const at = (f) => resolve(gitHere, f);
      const g = gitKind(args.slice(j), (f) => exists(at(f)));
      if (g.kind === 'read' || g.kind === 'vcs') continue;
      for (const f of g.targets ?? []) targets.push(at(f));
      write(g.kind, `git ${args[j]}`);
      continue;
    }
    if (name === 'npm') {
      const sub = args[0];
      if (
        sub === 'test' ||
        sub === 't' ||
        ['ls', 'view', 'outdated', 'ci', '--version', '-v'].includes(sub)
      )
        continue; // npm ci writes only node_modules, which git ignores
      if (sub === 'install' || sub === 'i') {
        for (const f of ['package.json', 'package-lock.json']) targets.push(abs(f));
        write('write', 'npm install');
        continue;
      }
      if (sub === 'run' && NPM_READ.test(args.find((a, x) => x > 0 && !a.startsWith('-')) ?? ''))
        continue;
      write('opaque', `npm ${sub ?? ''}`.trim());
      continue;
    }
    if (name === 'node') {
      // node runs code, so it is read-only only when it injects none: --test,
      // --version, -v with no --import/--require/-r/--loader/-e/--eval (F-157:
      // `node --test --import 'data:…writeFileSync' x` ran arbitrary code)
      const injects = args.some((a) =>
        /^(--import|--require|-r|--loader|--experimental-loader|-e|--eval|--input-type)(=|$)/.test(
          a,
        ),
      );
      if (!injects && (args[0] === '--test' || args[0] === '--version' || args[0] === '-v'))
        continue;
      if (!injects && args[0] && LOOP_TOOLS.test(args[0].replace(/^\.\//, ''))) continue;
      write('opaque', 'node');
      continue;
    }
    if (name === 'gh') {
      const two = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (/^(pr checkout|repo clone|release download|run download|gist clone)$/.test(two))
        write('opaque', `gh ${two}`);
      continue;
    }
    if (name === 'curl') {
      if (args.some((a) => /^-(o|O)$|^--output|^--remote-name|^-[a-zA-Z]*[oO]$/.test(a)))
        write('opaque', 'curl -o');
      continue;
    }
    if (TARGET_ALL.has(name)) {
      for (const f of plain) targets.push(abs(f));
      write('write', name);
      continue;
    }
    if (TARGET_LAST.has(name) || name === 'mv') {
      const files = name === 'mv' ? plain : plain.slice(-1);
      for (const f of files) targets.push(abs(f));
      write('write', name);
      continue;
    }
    write('opaque', name);
  }
  return { kind, targets: [...new Set(targets)], why: [...new Set(why)].join('; ') };
}

/** Files the working tree has changed against HEAD, tracked or not (R1: wherever they came from). */
export function pendingChanges(root) {
  let out = '';
  try {
    out = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // not readable: the caller refuses
  }
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    files.push(p.slice(3));
    if (p[0] === 'R' || p[0] === 'C') i++; // the original path follows a rename or copy
  }
  return files;
}

// --- R6: the data the gate reads only moves forward ---------------------------

// what a finding says about the past: it never changes, unless a correction says why
export const FROZEN = [
  'class',
  'date',
  'title',
  'introduced_in',
  'found_by',
  'symptom',
  'evidence',
  'direct_cause',
  'root_cause',
  'mechanism_gap',
  'answer_failed',
];
const GROWS = ['areas', 'why', 'dt', 'rc', 'es'];
const STATUS_ORDER = ['open', 'fixed', 'verified', 'class_closed'];

/** A changed field is allowed when the head carries {field, from: <the base value>, why: 20+ chars}. */
const corrected = (headItem, field, baseValue) =>
  (headItem?.corrections ?? []).some(
    (c) =>
      c?.field === field &&
      same(c.from, baseValue) &&
      typeof c.why === 'string' &&
      c.why.trim().length >= 20,
  );
const superset = (a, b) => (b ?? []).every((x) => (a ?? []).some((y) => same(x, y)));

/**
 * R6: what existed at the base still exists at the head, unchanged or grown.
 * Findings keep their account of the past; status only moves forward; an
 * upgrade only moves from "none" to a check. Classes keep their definition,
 * questions (text may only be appended to) and detectors. A deliberate change
 * is a `corrections` entry naming the field, its old value and why.
 */
export function dataRegressions(base, head) {
  const out = [];
  const hf = new Map((head.ledger?.findings ?? []).map((f) => [f.id, f]));
  for (const b of base.ledger?.findings ?? []) {
    const h = hf.get(b.id);
    if (!h) {
      out.push(`${b.id} was removed from the ledger — findings are never deleted`);
      continue;
    }
    for (const k of FROZEN)
      if (b[k] !== undefined && !same(b[k], h[k]) && !corrected(h, k, b[k]))
        out.push(
          `${b.id}.${k} changed — restore it, or add {"field": "${k}", "from": <the old value>, "why": "…"} to its "corrections"`,
        );
    for (const k of GROWS)
      if (!superset(h[k], b[k]) && !corrected(h, k, b[k]))
        out.push(`${b.id}.${k} lost entries — lists only grow`);
    const si = STATUS_ORDER.indexOf(b.status);
    if (si >= 0 && STATUS_ORDER.indexOf(h.status) < si && !corrected(h, 'status', b.status))
      out.push(`${b.id}.status moved back from ${b.status} to ${h.status}`);
    const bu = String(b.mechanism_upgrade ?? '');
    if (
      bu &&
      !bu.startsWith('none:') &&
      h.mechanism_upgrade !== b.mechanism_upgrade &&
      !corrected(h, 'mechanism_upgrade', b.mechanism_upgrade)
    )
      out.push(`${b.id}.mechanism_upgrade changed from a check to something else`);
    if (!superset(h.corrections, b.corrections))
      out.push(`${b.id}.corrections lost entries — corrections only grow`);
  }
  const hc = new Map((head.registry?.classes ?? []).map((c) => [c.id, c]));
  for (const b of base.registry?.classes ?? []) {
    const h = hc.get(b.id);
    if (!h) {
      out.push(`${b.id} was removed from findings/classes.json — classes are never deleted`);
      continue;
    }
    for (const k of ['name', 'definition', 'rc'])
      if (b[k] !== undefined && h[k] !== b[k] && !corrected(h, k, b[k]))
        out.push(
          `${b.id}.${k} changed — restore it, or add a correction with the old value and why`,
        );
    const hq = new Map((h.questions ?? []).map((q) => [q.id, q]));
    for (const q of b.questions ?? []) {
      const n = hq.get(q.id);
      if (!n) out.push(`${q.id} was removed — questions are never deleted`);
      else {
        if (typeof n.ask !== 'string' || !n.ask.startsWith(q.ask))
          out.push(`${q.id}.ask was reworded — text may only be appended`);
        if (!superset(n.learned_from, q.learned_from))
          out.push(`${q.id}.learned_from lost entries`);
      }
    }
    if (!superset(h.detectors, b.detectors) && !corrected(h, 'detectors', b.detectors))
      out.push(`${b.id}.detectors lost entries — a class keeps every check it had`);
    if (!superset(h.corrections, b.corrections))
      out.push(`${b.id}.corrections lost entries — corrections only grow`);
  }
  if (!superset(head.registry?.baseline, base.registry?.baseline))
    out.push('the class baseline lost entries');
  return out;
}

// --- skipping the hooks is not a write: it is refused outright --------------

/**
 * A command that turns the git hooks off (`--no-verify`, `commit -n`, setting
 * or clearing core.hooksPath) is refused whatever the answers say: agents
 * reach for it when a gate blocks them (anthropics/claude-code#40117). Returns
 * the reason, or null.
 */
export function hookBypass(cmd, depth = 0) {
  if (typeof cmd !== 'string' || depth > 3) return null;
  for (const seg of shellSegments(cmd).segs) {
    // environment that switches hooks off or rewrites git's configuration
    for (const w of seg) {
      if (
        /^(GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)=/.test(w)
      )
        return 'setting git configuration through the environment can switch the hooks off';
      if (/^(HUSKY=0|SKIP=|PRE_COMMIT_ALLOW_NO_CONFIG=|LEFTHOOK=0)/.test(w))
        return `${w.split('=')[0]} switches the hooks off`;
    }
    const words = seg.filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    // a shell wrapping a script: judge the script too (Codex sends `bash -lc '…'`)
    const si = words.findIndex((w) => /^(ba|z|da|k)?sh$/.test(w.split('/').pop()));
    if (si >= 0) {
      const ci = words.findIndex((w, k) => k > si && /^-[a-z]*c[a-z]*$/.test(w));
      if (ci >= 0 && words[ci + 1] !== undefined) {
        const inner = hookBypass(words[ci + 1], depth + 1);
        if (inner) return inner;
      }
    }
    const gi = words.findIndex((w) => w === 'git' || w.endsWith('/git'));
    if (gi < 0) continue;
    const rest = words.slice(gi + 1);
    for (let k = 0; k < rest.length; k++)
      if (rest[k] === '-c' && /^core\.hookspath=/i.test(rest[k + 1] ?? ''))
        return 'git -c core.hooksPath=… runs git without the hooks';
    let j = 0;
    while (j < rest.length && rest[j].startsWith('-')) j += /^-(C|c)$/.test(rest[j]) ? 2 : 1;
    const sub = rest[j];
    const args = rest.slice(j + 1);
    if (args.includes('--no-verify')) return `git ${sub} --no-verify skips the hooks`;
    // -n is --no-verify for commit, merge and am (for push it is a dry run)
    if (
      ['commit', 'merge', 'am'].includes(sub) &&
      args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))
    )
      return `git ${sub} -n is --no-verify`;
    if (
      sub === 'config' &&
      args.some((a) => /^core\.hookspath$/i.test(a)) &&
      !args.some((a) => /^--get/.test(a))
    )
      return 'changing core.hooksPath turns the hooks off';
    // plumbing writes commits and refs without any hook
    if (['commit-tree', 'update-ref', 'replace'].includes(sub))
      return `git ${sub} writes history without the hooks`;
    if (sub === 'hash-object' && args.includes('-w'))
      return 'git hash-object -w writes objects without the hooks';
  }
  return null;
}

/** The way out every refusal offers instead of routing around the gate. */
export const DISPUTE =
  'If you believe this gate is wrong, do not route around it: run `npm run inbox -- add --source dispute "<why the gate is wrong>"` and stop for the owner.';
