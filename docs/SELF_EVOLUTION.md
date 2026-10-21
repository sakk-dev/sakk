# Self-evolution loop

The findings ledger (`findings/ledger.json`) records every problem with its
root cause and its **problem class** (`findings/classes.json`). This loop
makes the ledger act before the next problem, and makes skipping it fail:
check the ledger → avoid what it knows → log what is new under its class →
upgrade the check that missed it → check the ledger again. It implements
section 15 of the internal AI-agent testing standard.

## What is enforced, and where

| Rule                                                         | Before an edit (Claude Code)                            | Before a commit (git hooks)                                   | In CI (whole branch)                             |
| ------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| Answer the ledger's questions for every file you change      | PreToolUse hook blocks the edit (exit 2) until answered | pre-commit refuses unless the answers are staged              | `findings-check --range` over every changed file |
| A shell command that may write meets the same rule           | PreToolUse hook on Bash (see "Shell commands")          | every staged file, whatever wrote it                          | every changed file                               |
| A committed answer is never rewritten                        | —                                                       | staged answers compared with HEAD's                           | every commit compared with the one before        |
| Every answer names its check                                 | the `guard` field must be present                       | the guard must resolve                                        | the guard must resolve                           |
| A miss under an answered question names that answer          | —                                                       | findings new against HEAD                                     | findings new against the base                    |
| A stopped class stops the changes that must answer it        | refused                                                 | refused                                                       | refused                                          |
| Every problem seen is logged                                 | —                                                       | refused while `findings/inbox/` holds an item                 | —                                                |
| A fix names the finding it fixes                             | —                                                       | commit-msg hook: `F-nn` in the ledger, or `No-finding: <why>` | every commit made since the rule existed         |
| A known problem is an occurrence of its class, not a new one | —                                                       | the ledger gate runs in pre-commit                            | the ledger gate runs in `npm test`               |

`npm install` installs the git hooks (`prepare` sets `core.hooksPath` to
`scripts/hooks`), so every clone has them. Codex and people meet the git
hooks and CI. Claude Code sessions also meet the edit hook
(`.claude/settings.json`), but Claude Code loads that file only from the
folder a session **starts** in. A session started in a parent folder meets
the hook only if the parent's own settings route tool calls to it (F-132).
`--no-verify` skips the local hooks, not CI.

## The answers

`npm run brief -- <paths>` lists, for the files a change touches, the
problem classes they have hit and the questions to answer — every question
of those classes plus those of the three most frequent classes (the watch
list). Answers go in `findings/acks/<branch>.json`:

```json
{
  "version": 2,
  "branch": "feat/x",
  "answers": {
    "C-01.1": {
      "answer": "how this change avoids it",
      "guard": "test/x.test.mjs::the test that fails if it does not"
    }
  }
}
```

An answer is at least 40 characters, not a placeholder (todo, tbd, same,
see above) and not a copy of another answer. Whether it is true is for
review; the file is committed, so the review sees it.

- **Version 2.** An answers file that is new on a branch carries
  `"version": 2`. Older files keep the earlier rules.
- **Every answer names its check.** `guard` is a `path::test name` that
  resolves (the file exists and contains the name), or `none: <why there is
none, 20+ characters>`. The edit hook needs only the field, because the
  test may not exist yet. The commit and CI need it to resolve.
- **Committed answers are frozen.** Once an answer is in a commit, its
  `answer` and `guard` never change. A correction is appended, so the
  original stays readable:
  `"revisions": [{"finding": "F-nn", "answer": "what is true now", "guard": "…"}]`.

## Shell commands

The PreToolUse hook also sees `Bash`. A command passes without answers only
if every part of it is provably read-only:

- inspection (`cat`, `grep`, `ls`, `sed` without `-i`)
- `git` reads, and commands that only record or move between existing
  commits (`add`, `commit`, `fetch`, `pull`, `branch`, `switch <branch>`).
  A checkout or restore of a path, `stash`, `reset --hard`, `clean`,
  `cherry-pick`, `revert`, `apply` and setting a `config` value are writes.
- `npm ci` (it writes only ignored files)
- the checks (`npm test`, `npm run lint`)
- this loop's own tools (`npm run brief`, `npm run inbox`)

Anything else, including commands nobody listed, needs the answers for:

- every file the working tree has changed, whatever wrote it;
- the files the command names (redirects, `tee`, `sed -i`, `cp`, `mv`,
  `rm`, `touch`, `git checkout|restore <path>`, and `npm install`, which
  names `package.json` and `package-lock.json`); and
- the watch list, when the command's targets cannot be read: interpreters,
  heredocs, `eval`, `sh -c`, `npx`, and unknown tools.

A command over 64 KiB is refused as unclassifiable. The Write tool on
`findings/acks/` stays open, so the way out is always to answer.

## A miss under an answered question

The answers can fail, and the loop records it. A finding that this branch
introduced carries `"answer_failed": {"qid": "C-xx.n", "why": "…"}` when
its class has a question the branch answered. A finding introduced on this
branch has `introduced_in` set to `worktree` or to a commit in the range.
`npm run findings-report` counts these misses by question.

## Stop-the-line

A class is **stopped** when its two latest escapes both upgraded no check
(`mechanism_upgrade: "none: …"`). A stopped class refuses every change
whose questions include it, in the hook, at commit and in CI. A stop-line
review is still written, but writing it releases nothing.

A stopped class is released by a `stopline` record in
`findings/classes.json` for its latest escape:

```json
"stopline": { "after": "F-nn", "detector": "test/x.test.mjs::the class-level check" }
```

The record carries exactly one of:

- `detector`: listed in the class's `detectors`, and it must resolve.
- `waiver: {by, on, record}`: the owner accepts the risk.
- `debt: {plan, until}`: the detector is planned by that date. On the next
  day the class is stopped again.

A new escape that upgrades a check also releases the class, because its
last two escapes are then no longer both "none".

## The gate's own data only moves forward

The checker judges a change by `findings/classes.json` and
`findings/ledger.json`, so a change must not loosen them (R6, F-137).
Pre-commit compares them with HEAD, and CI compares them with the base:

- Nothing is removed: no class, question, detector or finding.
- A question's text may only be appended to.
- A finding's account of the past is frozen: its class, date, title,
  introduced_in, found_by, symptom, evidence, direct cause, root cause,
  mechanism gap and answer_failed.
- A finding's lists only grow, its status only moves forward, and its
  upgrade only moves from "none" to a check.

A deliberate change carries its own record in `corrections`:
`{"field": "title", "from": "<the old value>", "why": "…"}`.

CI also runs the **base branch's** checker over the pull request, read with
`git show`, so a branch that weakens the checker is still judged by the one
already merged (F-138).

## A fix is proven, not claimed

For every finding a pull request fixes, CI runs its guard test twice
(R7, `scripts/findings-proof.mjs`). This is the FAIL_TO_PASS rule SWE-bench
uses to validate a fix:

1. On the base, the code before the fix, with the new test file copied in,
   the guard must fail.
2. On the branch, it must pass.

A guard that already passes before the fix does not guard the bug, so it
is refused.

A bug that predates the branch needs a guard that **runs** on the old code
and fails by its own assertion. A test that cannot even load there, because
it imports what the fix added, shows nothing about the old code. Drive the
command instead of the new function (`test/self-evolution-cli.test.mjs` is
written that way). A bug introduced in the same branch may have a guard
that needs the new code to load.

## Logging every problem

- `npm run audit` puts every red step in `findings/inbox/` itself.
- A person or agent adds anything else they saw — a review finding, a bug
  met in passing: `npm run inbox -- add "<what>"`.
- An item leaves the inbox only as a ledger entry
  (`npm run inbox -- resolve <item> F-nn`) or with a recorded reason
  (`npm run inbox -- dismiss <item> "<why>"`, kept in `findings/dismissed.jsonl`).

## One problem, one class

Every finding names one class from `findings/classes.json` (definition,
root-cause axis, questions, detectors). A new instance of a known problem
is an **occurrence** of that class: same class, its own evidence, and — if
the class had a detector — why the detector missed it (`mechanism_gap`)
and what now catches it (`mechanism_upgrade`). The ledger gate enforces:

- every finding belongs to a registered class;
- a class with two closed findings has a detector the suite runs;
- a class added after the baseline states, for **every** existing class,
  why it is not that one, and carries an approval `{by, on, record}`;
- a new finding beside an open finding of the same class (same area) says
  whether it is the same problem — if it is, the evidence goes into the
  open finding instead of a new entry.

Text similarity cannot do this job: measured on the 115 baseline findings,
the nearest neighbour by wording sits in another class for 76 of them. The
rules are therefore structural, and rewording a problem does not make it a
new class.

## Indicators (`npm run findings-report`)

- **past-detector escapes ↓** — findings whose class already had a detector
  that missed them.
- **detector upgrade rate ↑** — of those, the escapes that upgraded a check
  rather than only fixing the instance.

## What it does not do

- Merge protection: a red CI blocks a merge only once `main` has branch
  protection (F-116, open).
- Order before the first commit: answers written after the code, but
  before the first commit, look the same as answers written first. Only the
  edit hook observes the order, and only on the routes it sees.
- Strength of a guard: a guard that resolves shows the test exists, not that
  it fails on the bug. That is mutation work (`npm run drill`).
- Waivers and debt dates are the author's own words. They are visible in the
  pull request, and the owner merges.
- Shell classification is conservative. Some read-only commands it does not
  know are treated as writes and need answers. It aims never to treat a
  writing command as read-only; its table of forms is the test, and review
  found git writes it had missed (F-133). `node --test` is trusted, so a test
  file that writes runs unanswered.
- Renaming the branch: every answers file a branch added stays frozen, and
  the current one must carry its answers forward. This is checked in CI;
  pre-commit cannot see the base.
- The miss count trusts `introduced_in`. A finding marked `unknown`, or
  logged under a class the branch did not answer, needs no `answer_failed`.
  Review checks both.
- Truth of answers and correctness of a class choice stay with review; a
  model judge for the class choice needs a CI model key.
