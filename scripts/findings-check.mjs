#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// The self-evolution loop, enforced (docs/SELF_EVOLUTION.md). One checker,
// four places it runs:
//
//   --edit          Claude Code PreToolUse hook: hook JSON on stdin. Blocks
//                   (exit 2) an edit — or a shell command that may write — until
//                   this branch has answered the ledger's questions for it.
//   --staged        git pre-commit: the same for every staged file, from the
//                   STAGED answers file; committed answers are not rewritten;
//                   guards resolve; misses under answered questions are named;
//                   no untriaged inbox item.
//   --commit-msg F  git commit-msg: a fix commit names the finding it fixes
//                   (F-nn in the ledger) or says why there is none.
//   --range BASE    CI: all of the above over every commit since BASE — so
//                   --no-verify locally does not get past it.
//
// A class whose last two escapes upgraded no check is stopped (R5): changes
// that must answer it are refused at all four places until it is released.
//
// Exit 0 pass, 1 violation (2 for the edit hook, which is how Claude Code
// blocks a tool call), 2 usage.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Loaded lazily (F-141): if the library itself cannot load, the edit hook can
// still let the repair of the gate's own files through — and nothing else.
let lib;
let libError = null;
try {
  lib = await import('./findings-lib.mjs');
} catch (e) {
  libError = e;
}
const {
  EXEMPT,
  ackPath,
  ackRewrites,
  answerFailedProblems,
  dataRegressions,
  branchOf,
  classifyShell,
  DISPUTE,
  hookBypass,
  explain,
  findRoot,
  guardResolution,
  load,
  messageProblem,
  missingAnswers,
  pendingChanges,
  required,
  slug,
  stopProblems,
  stoppedClasses,
} = lib ?? {};

const args = process.argv.slice(2);
const mode = args[0];

/** The gate's own files: what may be repaired while the checker cannot load. */
const REPAIRABLE = /^(scripts\/findings-[\w-]+\.mjs|src\/classify\.mjs|findings\/.*)$/;
if (libError !== null) {
  const why = `self-evolution: the checker cannot load (${libError.message.split('\n')[0]})`;
  if (mode !== '--edit') {
    console.error(`${why} — fix scripts/findings-*.mjs or src/classify.mjs`);
    process.exit(mode === undefined ? 2 : 1);
  }
  let hook = null;
  try {
    hook = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // not a hook payload: nothing to check
  }
  const repo = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const file = hook?.tool_input?.file_path ?? hook?.tool_input?.notebook_path;
  if (typeof file === 'string' && file !== '') {
    // one spelling per place (/var and /private/var): resolve the nearest existing parent
    let abs = resolve(typeof hook.cwd === 'string' ? hook.cwd : repo, file);
    for (let d = dirname(abs), tail = [abs.slice(dirname(abs).length + 1)]; ;) {
      try {
        abs = join(realpathSync(d), ...tail);
        break;
      } catch {
        if (dirname(d) === d) break;
        tail.unshift(d.slice(dirname(d).length + 1));
        d = dirname(d);
      }
    }
    const rel = relative(repo, abs);
    if (rel.startsWith('..') || isAbsolute(rel) || REPAIRABLE.test(rel)) process.exit(0);
  }
  const cmd = hook?.tool_input?.command;
  // the one shell repair: restore the gate's own files from git, nothing chained
  if (
    typeof cmd === 'string' &&
    /^git (-C \S+ )?(checkout|restore)( --)? (scripts\/findings-[\w-]+\.mjs|src\/classify\.mjs)( (scripts\/findings-[\w-]+\.mjs|src\/classify\.mjs))*$/.test(
      cmd.trim(),
    )
  )
    process.exit(0);
  console.error(
    `${why}. Only the gate's own files can be repaired now (Edit/Write on scripts/findings-*.mjs, src/classify.mjs, findings/, or: git restore <those files>).`,
  );
  process.exit(2);
}
const git = (root, ...a) =>
  execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const fail = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};
// the stop-line's debt records fall due by the calendar (R5); nothing else reads the clock
const TODAY = new Date().toISOString().slice(0, 10);

/** Read a repository file from the working tree, the index (rev ''), or a commit. */
const reader = (root, rev) => (p) => {
  if (rev === undefined) {
    try {
      return readFileSync(join(root, p), 'utf8');
    } catch {
      return null;
    }
  }
  try {
    return git(root, 'show', `${rev}:${p}`);
  } catch {
    return null;
  }
};
/** Parsed JSON, null when absent; a malformed file is a refusal, never "no answers yet". */
const json = (text, what) => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} is not valid JSON (${e.message})`);
  }
};
const ids = (ledger) => new Set((ledger?.findings ?? []).map((f) => f.id));
/** One spelling per place: /tmp and /private/tmp, a symlinked checkout and its target. */
const real = (p) => {
  const tail = [];
  let d = resolve(p);
  for (;;) {
    try {
      return join(realpathSync.native(d), ...tail); // the nearest part that exists, plus the rest
    } catch {
      const up = dirname(d);
      if (up === d) return resolve(p);
      tail.unshift(d.slice(up.length).replace(/^\//, ''));
      d = up;
    }
  }
};

/** Untriaged inbox items: a red audit step or a recorded review finding not yet in the ledger. */
function inbox(root) {
  const d = join(root, 'findings', 'inbox');
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')) : [];
}

/**
 * The answer checks shared by the edit hook and the commit: a new answers
 * file is version 2, required questions are answered (with guards in v2), and
 * no class the change must answer is stopped.
 */
function answerProblems({ root, branch, files, req, ledger, registry, ack, prev, read }) {
  const rel = relative(root, ackPath(root, branch));
  const out = [];
  const isNew = prev === null;
  if (ack && isNew && ack.version !== 2)
    out.push(
      `self-evolution: ${rel} is new on this branch, so it must carry "version": 2 — every answer then names its guard (docs/SELF_EVOLUTION.md)`,
    );
  const missing = missingAnswers(ack, req, { v2: ack?.version === 2 || isNew });
  if (missing.length) out.push(explain({ root, branch, files, missing, ledger }));
  out.push(...stopProblems(req, stoppedClasses(ledger, registry, { read, today: TODAY })));
  return out;
}

if (mode === '--edit') {
  let hook;
  try {
    hook = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // not a hook payload: nothing to check
  }
  const tool = hook?.tool_name;
  const cwd = real(typeof hook?.cwd === 'string' && hook.cwd ? hook.cwd : process.cwd());
  let rel = null;
  try {
    if (tool === 'Bash') {
      // R1: the repository this hook belongs to, wherever the session started
      const root = findRoot(real(join(dirname(fileURLToPath(import.meta.url)), '..')));
      if (!root) process.exit(0);
      const skip = hookBypass(hook?.tool_input?.command);
      if (skip)
        fail(
          `self-evolution: refused — ${skip}. Commits go through the hooks; CI checks the same rules anyway.\n${DISPUTE}`,
          2,
        );
      const cls = classifyShell(hook?.tool_input?.command, cwd);
      if (cls.kind === 'unclassifiable')
        fail(
          `self-evolution: this shell command cannot be classified (${cls.why}) — split it into smaller commands`,
          2,
        );
      if (cls.kind === 'read') process.exit(0);
      const pending = pendingChanges(root);
      if (pending === null)
        fail('self-evolution: git status is unreadable here, so shell writes cannot be checked', 2);
      const named = cls.targets
        .map((t) => relative(root, real(t)))
        .filter((r) => r && !r.startsWith('..') && !isAbsolute(r));
      const files = [...new Set([...pending, ...named])].filter((f) => !EXEMPT(f));
      if (files.length === 0 && cls.kind !== 'opaque') process.exit(0);
      const { ledger, registry } = load(root);
      const req = required(ledger, registry, files, { watch: cls.kind === 'opaque' });
      if (req.size === 0) process.exit(0);
      const branch = branchOf(root);
      const ap = ackPath(root, branch);
      const ack = json(existsSync(ap) ? readFileSync(ap, 'utf8') : null, relative(root, ap));
      const prev = reader(root, 'HEAD')(relative(root, ap));
      const problems = answerProblems({
        root,
        branch,
        files: files.length ? files : ['(files this command writes)'],
        req,
        ledger,
        registry,
        ack,
        prev,
        read: reader(root),
      });
      if (problems.length)
        fail(
          [
            `self-evolution: this shell command may write (${cls.why}). It meets the same gate as an edit: answer first — the Write tool on findings/acks/ is always open.`,
            ...problems,
          ].join('\n\n'),
          2,
        );
      process.exit(0);
    }
    const file = hook?.tool_input?.file_path ?? hook?.tool_input?.notebook_path;
    if (typeof file !== 'string' || file === '') process.exit(0);
    const abs = real(resolve(cwd, file));
    const root = findRoot(join(abs, '..'));
    if (!root) process.exit(0); // not a repository that keeps a ledger
    rel = relative(root, abs);
    if (rel.startsWith('..') || EXEMPT(rel)) process.exit(0);
    const { ledger, registry } = load(root);
    const branch = branchOf(root);
    const req = required(ledger, registry, [rel]);
    const ap = ackPath(root, branch);
    const ack = json(existsSync(ap) ? readFileSync(ap, 'utf8') : null, relative(root, ap));
    const prev = reader(root, 'HEAD')(relative(root, ap));
    const problems = answerProblems({
      root,
      branch,
      files: [rel],
      req,
      ledger,
      registry,
      ack,
      prev,
      read: reader(root),
    });
    if (problems.length) fail([...problems, DISPUTE].join('\n\n'), 2);
    process.exit(0);
  } catch (e) {
    // fail closed — but leave the way to repair the checker itself open
    if (rel !== null && /^scripts\/findings-[\w-]+\.mjs$/.test(rel)) process.exit(0);
    fail(
      `self-evolution: the check could not run (${e.message}). Fix the input it names; findings/ and scripts/findings-*.mjs stay editable with the Edit tool.`,
      2,
    );
  }
}

const root = findRoot(process.cwd());
if (!root) fail('findings-check: no findings/classes.json above the current directory', 2);

if (mode === '--staged') {
  const index = reader(root, '');
  const head = reader(root, 'HEAD');
  const work = load(root);
  let ledger, registry, headLedger, ack, prev;
  const branch = branchOf(root);
  const rel = relative(root, ackPath(root, branch));
  try {
    ledger = json(index('findings/ledger.json'), 'the staged ledger') ?? work.ledger;
    registry = json(index('findings/classes.json'), 'the staged classes') ?? work.registry;
    headLedger = json(head('findings/ledger.json'), "HEAD's ledger");
    ack = json(index(rel), `the staged ${rel}`); // the answers being committed, not a draft
    prev = json(head(rel), `HEAD's ${rel}`);
  } catch (e) {
    fail(`self-evolution: ${e.message}`);
  }
  const files = git(root, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
  const req = required(ledger, registry, files);
  const problems = answerProblems({
    root,
    branch,
    files,
    req,
    ledger,
    registry,
    ack,
    prev,
    read: index,
  });
  problems.push(...ackRewrites(prev, ack, ids(ledger)).map((p) => `self-evolution: ${rel}: ${p}`));
  // R6: the ledger and the registry only move forward
  let headRegistry = null;
  try {
    headRegistry = json(head('findings/classes.json'), "HEAD's classes");
  } catch (e) {
    problems.push(`self-evolution: ${e.message}`);
  }
  if (headLedger && headRegistry)
    problems.push(
      ...dataRegressions({ ledger: headLedger, registry: headRegistry }, { ledger, registry }).map(
        (p) => `self-evolution: ${p}`,
      ),
    );
  if (ack?.version === 2)
    problems.push(...guardResolution(ack, index).map((p) => `self-evolution: ${rel}: ${p}`));
  problems.push(
    ...answerFailedProblems(headLedger, ledger, ack, (f) => f.introduced_in === 'worktree').map(
      (p) => `self-evolution: ${p}`,
    ),
  );
  const items = inbox(root);
  if (items.length)
    problems.push(
      `self-evolution: ${items.length} untriaged item(s) in findings/inbox/ (${items.join(', ')}) — log each in findings/ledger.json (new finding or an occurrence of its class) and delete it, or record why it is not a problem in findings/dismissed.jsonl`,
    );
  if (problems.length) fail(problems.join('\n\n'));
  process.exit(0);
}

const { ledger, registry } = load(root);

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
  const rel = relative(root, ackPath(root, branch));
  const revs = git(root, 'rev-list', '--reverse', `${base}..HEAD`).split('\n').filter(Boolean);
  const problems = [];
  let ack, baseAck, baseLedger;
  try {
    ack = json(reader(root)(rel), rel);
    baseAck = json(reader(root, base)(rel), `${base}'s ${rel}`);
    baseLedger = json(reader(root, base)('findings/ledger.json'), `${base}'s ledger`);
  } catch (e) {
    fail(`self-evolution: ${e.message}`);
  }
  const req = required(ledger, registry, files);
  problems.push(
    ...answerProblems({
      root,
      branch,
      files,
      req,
      ledger,
      registry,
      ack,
      prev: baseAck,
      read: reader(root),
    }),
  );
  // R2 over every commit, so a middle commit cannot rewrite and restore
  let prev = baseAck;
  for (const c of revs) {
    let cur;
    try {
      cur = json(reader(root, c)(rel), `${rel} at ${c.slice(0, 7)}`);
    } catch (e) {
      problems.push(`self-evolution: ${e.message}`);
      continue;
    }
    if (cur === null) {
      if (prev !== null)
        problems.push(`commit ${c.slice(0, 7)}: ${rel} was removed — answers are append-only`);
      continue;
    }
    let atC = ledger;
    try {
      atC = JSON.parse(git(root, 'show', `${c}:findings/ledger.json`));
    } catch {
      /* keep HEAD's */
    }
    for (const p of ackRewrites(prev, cur, ids(atC)))
      problems.push(`commit ${c.slice(0, 7)}: ${rel}: ${p}`);
    prev = cur;
  }
  // R2 across names (review I2): renaming the branch starts a new answers file;
  // every answers file this range added is frozen too, so the current one must
  // carry its answers forward unchanged
  const acksAt = (rev) => {
    try {
      return git(root, 'ls-tree', '--name-only', rev, 'findings/acks/').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const atBase = new Set(acksAt(base));
  const earlier = new Map(); // another answers file the range added → its last version
  for (const c of revs)
    for (const f of acksAt(c)) {
      if (atBase.has(f) || f === rel) continue;
      let cur;
      try {
        cur = JSON.parse(git(root, 'show', `${c}:${f}`));
      } catch {
        problems.push(`self-evolution: ${f} at ${c.slice(0, 7)} is not valid JSON`);
        continue;
      }
      // every answers file the range added is append-only through its own history
      if (earlier.has(f))
        for (const p of ackRewrites(earlier.get(f), cur, ids(ledger)))
          problems.push(`commit ${c.slice(0, 7)}: ${f}: ${p}`);
      earlier.set(f, cur);
    }
  // within a pull request's own range there is one answers file: another one the
  // range added (kept or removed) is this branch under another name, and the
  // current file carries its answers forward — keeping the old file while a
  // looser new one is read would be the same bypass (CI ranges from the PR's own
  // base, so a stacked parent's file is already at the base)
  for (const [f, last] of earlier)
    for (const p of ackRewrites(last, ack, ids(ledger)))
      problems.push(
        `self-evolution: ${f} was this branch's answers file under another name — ${rel} must carry its answers forward: ${p}`,
      );
  if (ack?.version === 2)
    problems.push(...guardResolution(ack, reader(root)).map((p) => `self-evolution: ${rel}: ${p}`));
  // R6: the ledger and the registry only move forward from the base
  let baseRegistry = null;
  try {
    baseRegistry = json(reader(root, base)('findings/classes.json'), `${base}'s classes`);
  } catch (e) {
    problems.push(`self-evolution: ${e.message}`);
  }
  if (baseLedger && baseRegistry)
    problems.push(
      ...dataRegressions({ ledger: baseLedger, registry: baseRegistry }, { ledger, registry }).map(
        (p) => `self-evolution: ${p}`,
      ),
    );
  const onBranch = (f) =>
    f.introduced_in === 'worktree' ||
    (/^[0-9a-f]{7,40}$/.test(f.introduced_in ?? '') &&
      revs.some((r) => r.startsWith(f.introduced_in)));
  problems.push(
    ...answerFailedProblems(baseLedger, ledger, ack, onBranch).map((p) => `self-evolution: ${p}`),
  );
  // the message rule binds commits made after it existed (its parent has the checker)
  for (const c of revs) {
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
    `self-evolution: ${files.length} changed file(s) answered in findings/acks/${slug(branch)}.json; answers append-only, guards resolve, no stopped class; commit messages follow the finding rule`,
  );
  process.exit(0);
}

fail('usage: findings-check --edit | --staged | --commit-msg <file> | --range <base>', 2);
