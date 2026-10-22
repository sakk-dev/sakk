# Stop-line review — 2026-10-22: RC-09, failures not isolated

Standard §14.4: a root-cause class seen a third time stops the line. RC-09
("one element or one call failing takes down the whole unit") reached three
with F-141. The owner's requirement, the same day: an error must be
isolated; one broken part must never bring the whole development down.

## The three

- **F-82** — a nested caller value crashed the MCP gate: one bad frame
  stopped the server for every later call.
- **F-95** — one case's scoring failure crashed the whole batch: no result
  for any case.
- **F-141** — the checker could not load (a function was moved into a file
  that did not exist yet), and the parent dispatcher, which fails closed on
  a crash, denied every edit and shell command in the repository, including
  the edits that would have repaired it. The owner had to restore one file
  by hand.

## Why the countermeasure did not hold

The RC-09 countermeasure says: tolerate per element, retry a transient error
once, fail the whole only when everything fails, and make it visible. It
held where it was applied (the MCP frame loop, the scorer), and its
detectors live on those two product paths. Two gaps let F-141 through:

1. **Scope.** No detector fed the loop's own checker a broken version of
   itself. The gate was treated as the thing that checks, never as a thing
   that can fail.
2. **Meaning for a gate.** For a fail-closed gate, "skip the element that
   fails" would mean "let the call through", which is not allowed. The
   countermeasure never said what isolation means for a component whose
   failure must stay a refusal. Without that, "fail closed" was applied to
   everything at once, the repair path included.

## What the industry does (researched 2026-10-22)

Nobody solves lock-out by letting a broken gate pass everything. Three
lines recur:

- **The gate does not judge its own switch or its own home.**
  - Kubernetes admission webhooks exclude their own namespace and never
    send webhook configuration objects to a webhook, so the switch can
    always be removed
    (kubernetes.io, admission-webhooks-good-practices).
  - Kyverno stays fail-closed but excludes its own namespace by default,
    and states the cost: those namespaces need other protection
    (kyverno.io, installation, "Security vs Operability").
- **A new version proves itself before it takes effect, and the last good
  one keeps serving.**
  - Cloudflare, after 2025-11-18: a bad configuration file is rejected and
    the previous one keeps running; configuration changes roll out in
    stages ("Fail Small", blog.cloudflare.com).
  - CrowdStrike, after 2024-07-19: a content validator, staged rollout,
    and customer control over when updates land (crowdstrike.com,
    preliminary post-incident report).
- **A repair path that does not depend on the broken part, used and logged.**
  - Meta 2021: the out-of-band path went down with the network
    (engineering.fb.com).
  - WordPress recovery mode pauses only the failing plugin, and only for
    the person repairing it (make.wordpress.org, 2019-04-16).
  - Erlang supervisors restart only the failed child, and escalate past a
    restart limit (erlang.org, supervisor principles).

## Mechanism now (this commit)

- `scripts/findings-check.mjs` loads its library lazily. While it cannot
  load, the checker allows only:
  - the gate's own files (`scripts/findings-*.mjs`, `src/classify.mjs`,
    `findings/`);
  - `git checkout`/`git restore` of exactly those files.

  Everything else is denied with the way to repair, as a deny (exit 2),
  never a crash.

- Detector: `test/self-evolution-cli.test.mjs::F-141: the gate's own files
can be edited while the checker cannot load` and its counterpart
  `F-141: everything else is denied, with the way to repair, not a crash`.

## Class-level mechanism — proposed, waiting for the owner's go

Ordered so that the first five keep the gate fail-closed:

1. **Run the last known good gate.** The dispatcher runs the committed
   checker that passed its self-test, kept outside the working tree and
   keyed by commit. It never runs the working copy. A broken working copy
   then cannot stop enforcement or repair.
2. **Self-test before a new version takes effect.** A new checker is
   loaded in a child process against a golden set (what must be denied,
   what must pass) before it replaces the snapshot. If it fails, the old
   one keeps serving, and the agent is told its gate change did not take
   effect, and why.
3. **A dispatcher kernel that imports nothing from the repository.** Crash
   handling, the fallback to the snapshot, and the protection of the gate's
   own files live in a small kernel that cannot break with the repository's
   code.
4. **Graded failure.**
   - The new version fails: the snapshot judges.
   - The snapshot fails too: deny writes and shell, but keep reads open.
5. **Automatic incident record and circuit breaker.**
   - Every crash writes an inbox item with the error, the call and the
     version.
   - Repeated crashes switch to the snapshot and notify the owner.
6. **Break-glass for a person** (trades safety for availability; owner to
   decide). A terminal command only an owner can run. It expires on its
   own, and each use is logged and reviewed.

Narrowing that follows from (1): the repair window of this commit should
become "restore the gate's files to the committed version", not "edit the
gate's files freely". The research is explicit that a blanket exemption
for the gate's own files lets an agent rewrite the gate.

The same rule for the product: a user's broken policy file must not deny
every agent action. The hook keeps judging with the last policy that
passed `sakk` validation and says the new one is not in effect, and why.

## Also crossed in this round: RC-03, literal without context (F-145, F-146)

F-145 and F-146 join F-11 and F-63. The RC-03 detectors (secret-scan fiction
tokens, the l1 fuzz) live where the earlier two were found; the guard's
classifier is new in M1. The common shape again: a rule saw one literal (the
next word after a wrapper's flags, a path's prefix) without the structure
around it (which flags take a value; what a folder contains). Mechanisms now:

- every wrapper declares its value flags and a sample, and the guard tests
  run each sample in front of a force push;
- a delete is named for what it takes (`~protected/…`), and the home folder
  has its own name (`~home/…`).

## Remaining exposure

- **A crash of the dispatcher itself** (not of a child it calls).
  - Claude Code before 2.1.295 treats any exit other than 2 as "allow";
    the desktop app bundles 2.1.275 and 2.1.284.
  - `onFailure: "block"` closes this once the CLI is new enough.
  - Cursor needs `failClosed: true` (set by `sakk guard install`).
  - Codex documents no fail-closed setting.
- **Detectors outside the checker.** Until (1)–(3) land, the only RC-09
  detector on the gate is the F-141 pair.
