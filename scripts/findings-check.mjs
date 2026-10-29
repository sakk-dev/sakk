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
let libLoaded = false;
try {
  lib = await import('./findings-lib.mjs');
  libLoaded = true;
} catch (e) {
  // a thrown null/undefined/string is still a load failure (F-157): record it
  // as something printable, never leave libLoaded true
  libError = e ?? new Error('the checker library threw a non-error value');
}
const {
  EXEMPT,
  ackPath,
  ackRewrites,
  answerFailedProblems,
  dataRegressions,
  debtsDueSoon,
  debtWarning,
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

/**
 * The repository this gate guards: the one the dispatcher names when it runs
 * a copy of the gate from outside the working tree (SAKK_GATE_REPO; the last
 * known good gate, RC-09 review), else the one this file lives in. A named
 * folder that keeps no ledger is refused, never read as "nothing to check".
 */
function gateRepo() {
  const named = process.env.SAKK_GATE_REPO;
  if (named === undefined || named === '')
    return realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  try {
    const r = realpathSync(named);
    if (existsSync(join(r, 'findings', 'classes.json'))) return r;
  } catch {
    // refused below
  }
  console.error(
    `self-evolution: SAKK_GATE_REPO (${named}) is not a repository that keeps findings/classes.json — refused`,
  );
  process.exit(2);
}
/** What stays open while the checker cannot load: the answers and findings, never the gate's code. */
const OPEN_WHILE_BROKEN = /^findings\/.*$/;
/** The gate's own code: restored from git while the checker cannot load, never rewritten (RC-09 review). */
const GATE_CODE = '(?:scripts/findings-[\\w-]+\\.mjs|src/classify\\.mjs)';
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
if (!libLoaded) {
  const why = `self-evolution: the checker cannot load (${String(libError?.message ?? libError).split('\n')[0]})`;
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
  const repo = gateRepo();
  const file = hook?.tool_input?.file_path ?? hook?.tool_input?.notebook_path;
  // only an actual file tool edits a file; a Bash call with a stray file_path key
  // is judged by its command below, not by that key (F-157)
  if (FILE_TOOLS.has(hook?.tool_name) && typeof file === 'string' && file !== '') {
    // resolve the real path, the leaf included: a symlink leaf must not be judged
    // by its own name (F-157). Fall back to the nearest existing parent when the
    // leaf does not exist yet (one spelling per place: /var and /private/var).
    const start = resolve(typeof hook.cwd === 'string' ? hook.cwd : repo, file);
    let abs = start;
    for (let d = start, tail = []; ;) {
      try {
        abs = tail.length ? join(realpathSync(d), ...tail) : realpathSync(d);
        break;
      } catch {
        if (dirname(d) === d) break;
        tail.unshift(d.slice(dirname(d).length + 1));
        d = dirname(d);
      }
    }
    const rel = relative(repo, abs);
    if (rel.startsWith('..') || isAbsolute(rel) || OPEN_WHILE_BROKEN.test(rel)) process.exit(0);
  }
  const cmd = hook?.tool_input?.command;
  const here = (() => {
    try {
      return relative(repo, realpathSync(typeof hook?.cwd === 'string' ? hook.cwd : repo));
    } catch {
      return '..';
    }
  })();
  // the one shell repair: restore the gate's own code to what is committed, from the
  // repository's top folder, nothing chained and no other source
  if (
    typeof cmd === 'string' &&
    here === '' &&
    new RegExp(`^git (?:checkout|restore)(?: --)? ${GATE_CODE}(?: ${GATE_CODE})*$`).test(cmd.trim())
  )
    process.exit(0);
  console.error(
    `${why}. The gate's code is restored, not rewritten, while it cannot load: from the repository's top folder run git restore <the file> (scripts/findings-*.mjs, src/classify.mjs); findings/ stays editable.`,
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
/** Stop-line debts close to their date (R5): a warning only, never the verdict. */
const warnDebts = (registry) => {
  const actions = process.env.GITHUB_ACTIONS === 'true';
  for (const d of debtsDueSoon(registry, TODAY)) console.log(debtWarning(d, { actions }));
};

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
      const root = findRoot(gateRepo());
      // the gate always lives in the repository it guards; a copy that is not told
      // which one (SAKK_GATE_REPO) cannot place a shell write, so it refuses
      if (!root)
        fail(
          'self-evolution: this copy of the gate was not given SAKK_GATE_REPO, so it cannot tell what a shell command writes — refused',
          2,
        );
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
    // fail closed; findings/ was let through before any of this ran, so the data the
    // check reads can always be fixed — the gate's own code is never rewritten unjudged
    fail(
      `self-evolution: the check could not run (${e.message}). Fix the input it names; findings/ stays editable.`,
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
  const files = git(root, 'diff', '--cached', '--name-only', '--no-renames')
    .split('\n')
    .filter(Boolean);
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
    problems.push(
      ...guardResolution(ack, index, ledger).map((p) => `self-evolution: ${rel}: ${p}`),
    );
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
  warnDebts(registry);
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
  const lines = (...a) =>
    git(root, ...a)
      .split('\n')
      .filter(Boolean);
  // what this range changes: files changed since the merge base that still differ
  // from the base tip. A parent already rebase- or squash-merged into the base is
  // the base's change, not this range's; on CI's merge commit both diffs agree.
  const atTip = new Set(lines('diff', '--name-only', '--no-renames', base, 'HEAD'));
  const files = lines('diff', '--name-only', '--no-renames', `${base}...HEAD`).filter((f) =>
    atTip.has(f),
  );
  const branch = process.env.SAKK_BRANCH || branchOf(root);
  const rel = relative(root, ackPath(root, branch));
  // history is a graph, not a line: every commit with its parents, parents first
  // (parallel lines merged together, a pull request's merge commit)
  const graph = lines('rev-list', '--reverse', '--topo-order', '--parents', `${base}..HEAD`).map(
    (l) => l.split(' '),
  );
  const revs = graph.map(([c]) => c);
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
  // R2 over every commit, each against its own parents (every parent of a merge),
  // so a middle commit cannot rewrite and restore, and parallel lines merged
  // together are not read as one line
  const ACKS = 'findings/acks/';
  const trees = new Map(); // commit → answers file → blob
  const treeOf = (rev) => {
    if (!trees.has(rev)) {
      const m = new Map();
      try {
        for (const e of git(root, 'ls-tree', '-z', rev, ACKS).split('\0').filter(Boolean)) {
          const [meta, f] = e.split('\t');
          const [, type, blob] = meta.split(' ');
          if (type === 'blob') m.set(f, blob);
        }
      } catch {
        // no answers folder at that commit
      }
      trees.set(rev, m);
    }
    return trees.get(rev);
  };
  const blobs = new Map(); // blob → parsed file, or undefined when it is not valid JSON
  /** An answers file at a commit: null when absent, undefined when unreadable (reported once). */
  const at = (rev, f) => {
    const blob = treeOf(rev).get(f);
    if (blob === undefined) return null;
    if (!blobs.has(blob)) {
      let v;
      try {
        v = JSON.parse(git(root, 'cat-file', 'blob', blob));
      } catch (e) {
        problems.push(
          `self-evolution: ${f} at ${rev.slice(0, 7)} is not valid JSON (${e.message})`,
        );
      }
      blobs.set(blob, v);
    }
    return blobs.get(blob);
  };
  const ledgerIds = new Map();
  const idsAt = (rev) => {
    if (!ledgerIds.has(rev)) {
      let l = ledger;
      try {
        l = JSON.parse(git(root, 'show', `${rev}:findings/ledger.json`));
      } catch {
        /* keep HEAD's */
      }
      ledgerIds.set(rev, ids(l));
    }
    return ledgerIds.get(rev);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const atBase = treeOf(base);
  const head = git(root, 'rev-parse', 'HEAD').trim();
  // the answers files this range is responsible for: this branch's, every one the
  // range added, and every one already on the base that the range changes
  const tracked = new Set([rel]);
  for (const f of files) if (f.startsWith(ACKS) && atBase.has(f)) tracked.add(f);
  for (const c of revs) for (const f of treeOf(c).keys()) if (!atBase.has(f)) tracked.add(f);
  const removals = new Map(); // answers file → commits that removed it
  const last = new Map(); // answers file → its nearest versions on every path back from HEAD
  const inRange = new Set(revs);
  for (const f of tracked) {
    const near = new Map(); // commit → nearest versions along each path back from it
    const nearAt = (p) => {
      if (inRange.has(p)) return near.get(p) ?? [];
      const v = at(p, f);
      return v ? [v] : [];
    };
    for (const [c, ...parents] of graph) {
      const before = [];
      for (const v of parents.flatMap(nearAt)) if (!before.some((b) => same(b, v))) before.push(v);
      const cur = at(c, f);
      if (!cur) {
        if (cur === null && parents.some((p) => at(p, f)))
          removals.set(f, [...(removals.get(f) ?? []), c]);
        near.set(c, before);
        continue;
      }
      for (const b of before)
        if (!same(b, cur))
          for (const p of ackRewrites(b, cur, idsAt(c)))
            problems.push(`commit ${c.slice(0, 7)}: ${f}: ${p}`);
      near.set(c, [cur]);
    }
    last.set(f, near.get(head) ?? []);
  }
  // R2 across names (review I2). Another answers file the range added is either
  // inherited — the answers file of a branch that still exists (a stacked parent
  // merged into this one), which stays as that branch has it: present, append-only,
  // its guards resolving — or this branch's own file under an old name (the branch
  // was renamed), whose answers the current file carries forward unchanged.
  const refOf = (b) => {
    for (const r of [`refs/heads/${b}`, `refs/remotes/origin/${b}`])
      try {
        return git(root, 'rev-parse', '--verify', '-q', `${r}^{commit}`).trim();
      } catch {
        // not this one
      }
    return null;
  };
  const renamed = new Set();
  for (const f of tracked) {
    if (f === rel || atBase.has(f)) continue;
    const vs = last.get(f);
    const named = vs.map((v) => v?.branch).find((b) => typeof b === 'string');
    const own = named !== undefined && named !== branch && f === `${ACKS}${slug(named)}.json`;
    const tip = own ? refOf(named) : null;
    const theirs = tip ? at(tip, f) : null;
    if (theirs) {
      // both copies grow from one file: every answer they share is the same, and
      // one's revisions lead the other's (this range may append a revision, F-178)
      for (const v of vs)
        for (const [q, x] of Object.entries(v?.answers ?? {})) {
          const y = theirs.answers?.[q];
          if (!y) continue;
          const [s, l] = [x?.revisions, y?.revisions]
            .map((r) => (Array.isArray(r) ? r : []))
            .sort((m, n) => m.length - n.length);
          if (x?.answer !== y?.answer || x?.guard !== y?.guard || !s.every((r, k) => same(r, l[k])))
            problems.push(
              `self-evolution: ${f} is inherited from branch ${named}, but its ${q} differs from that branch's own copy — answers are append-only; a correction is a revision`,
            );
        }
      const kept = at(head, f);
      if (kept?.version === 2)
        problems.push(
          ...guardResolution(kept, reader(root), ledger).map((p) => `self-evolution: ${f}: ${p}`),
        );
      continue;
    }
    renamed.add(f);
    const hint =
      named !== undefined && named !== branch
        ? ` (if it is a stacked parent's answers file, keep branch ${named} on the remote so it counts as inherited)`
        : '';
    for (const v of vs)
      for (const p of ackRewrites(v, ack, ids(ledger)))
        problems.push(
          `self-evolution: ${f} was this branch's answers file under another name — ${rel} must carry its answers forward: ${p}${hint}`,
        );
  }
  // answers are never removed: this branch's, an inherited one, or one on the base
  for (const [f, cs] of removals)
    if (!renamed.has(f))
      for (const c of cs)
        problems.push(`commit ${c.slice(0, 7)}: ${f} was removed — answers are append-only`);
  if (ack?.version === 2)
    problems.push(
      ...guardResolution(ack, reader(root), ledger).map((p) => `self-evolution: ${rel}: ${p}`),
    );
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
  warnDebts(registry);
  if (problems.length) fail(problems.join('\n\n'));
  console.log(
    `self-evolution: ${files.length} changed file(s) answered in findings/acks/${slug(branch)}.json; answers append-only, guards resolve, no stopped class; commit messages follow the finding rule`,
  );
  process.exit(0);
}

fail('usage: findings-check --edit | --staged | --commit-msg <file> | --range <base>', 2);
