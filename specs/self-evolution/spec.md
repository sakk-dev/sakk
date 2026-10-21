# Self-evolution loop, closing the bypasses — spec + three tables

The loop (docs/SELF_EVOLUTION.md) asks every change to answer the ledger's
questions before it is made. On 2026-10-21 the project owner reported that
work still gets past it. This spec measures how, and moves each bypass from
rule text into a gate.

## What was measured (2026-10-21)

A second project runs the same loop: same questions, answers file, edit hook,
commit hooks and CI range check. It had the larger record, so it was
measured. Then Sakk's own ledger was checked for the same holes.

| #   | Bypass                                                                                                                                                                            | Evidence                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | The edit hook was never loaded. Claude Code reads `.claude/settings.json` from the folder a session starts in, and sessions started in the parent folder.                         | 0 hook firings across 228 edit-tool writes to that project's files (2026-10-17 to 10-21). Sakk's hook ran only because the parent folder's settings call it.                     |
| B2  | Shell writes are not gated. The hook matches the edit tools; most writes go through the shell.                                                                                    | 587 shell writes against 228 edit-tool writes in the same window. Sakk: F-120, open.                                                                                             |
| B3  | Answers are rewritten after review. The gates read only the final answers file, so what was promised before the change is lost.                                                   | About 70 in-place rewrites of existing answers, most right after a review round.                                                                                                 |
| B4  | An answer is prose with nothing tied to it. The class recurs under the very question that was answered, and nothing records which answer failed.                                  | Of 91 findings logged since 2026-10-18 whose branch could be identified, 91 belong to a class whose question that branch had answered before coding. 73 of 80 upgraded no check. |
| B5  | Stop-the-line is a document. When a class's last two escapes upgraded nothing, a review file naming them satisfies the gate, and the next change in that area proceeds as before. | Sakk today: C-02, C-03, C-04, C-13 and C-15 each have two latest escapes with `mechanism_upgrade: none`, and the gate is green.                                                  |

B1 is fixed outside this repository. The parent folder now routes each tool
call to the hooks of the repository it touches. This spec closes B2–B5 in
Sakk and states the B1 lesson in the docs.

## Design

### R1 — a shell command that may write meets the same gate (B2, F-120)

`.claude/settings.json` adds `Bash` to the PreToolUse matcher, and
`findings-check --edit` handles it. The rule is stated once: a command passes
without answers only if **every segment is provably read-only**. Anything
else, including commands nobody listed, must have answers for:

- the files the working tree has changed (`git diff HEAD` plus untracked),
  wherever they came from; and
- the files the command names as targets (redirects, `tee`, `sed -i`, `cp`,
  `mv`, `rm`, `touch`, `install`, `git apply|checkout|restore`); and
- the watch list, when the command is opaque: an interpreter (`node -e`,
  `python`, `uv run`), a heredoc, `eval`, `sh -c`, `xargs`, `make`,
  `npx`, or anything unknown. Its targets cannot be read, so it answers
  what every change answers.

Read-only means one of these, with no output redirect and no heredoc:

- `cat`, `head`, `tail`, `ls`, `wc`, `grep`, `rg`, `find`, `stat`, `diff` and
  similar inspection commands. `find` must not carry `-delete`, `-exec` or
  `-ok`. `sed` must carry `-n` and not `-i`.
- `git` with a read subcommand.
- The checks: `npm test`, `npm run lint`, `format:check`, `gate`, `audit`,
  `node --test`.
- The loop's own tools: `npm run brief|inbox|findings-report`.

A command over 64 KiB is refused as unclassifiable.

The changes are checked at the next command, and the check cannot be
dodged: once a shell write lands without answers, every later writing
command is refused until the answers exist. The Write tool on
`findings/acks/` stays open, so the way out is always to answer.

### R2 — an answer, once committed, is never rewritten (B3)

Answers files carry `"version": 2`. A file that is new on a branch must be
version 2. Older files keep the earlier rules. Once an answer is in a
commit, its `answer` and `guard` never change. A correction is appended:

```json
"C-06.1": { "answer": "…", "guard": "…",
            "revisions": [{ "finding": "F-131", "answer": "what is true now", "guard": "…" }] }
```

`revisions` only grows, and each entry names a finding in the ledger.
Removing an answer is refused.

- pre-commit compares the staged file against HEAD's.
- The CI range check walks every commit in the range in order, so an
  intermediate commit cannot rewrite either.

### R3 — every answer names its check (B4)

A version-2 answer has `guard`: either a `path::name` reference that
resolves (the file exists and contains the name), or `none: <reason, 20+
characters>`. The hook needs only the field, since the test may not exist
yet. The commit and CI require it to resolve.

### R4 — a recurrence under an answered question names the answer that failed (B4)

A finding added on a branch, when its class has a question that branch
answered, carries:

```json
"answer_failed": { "qid": "C-06.1", "why": "why the answer and its guard did not prevent it" }
```

- The `qid` must belong to the finding's class and be in this branch's
  answers.
- pre-commit checks findings new against HEAD; CI checks findings new
  against the base.
- `npm run findings-report` counts them. This is the loop's real miss rate,
  which no indicator measured before.

### R5 — stop-the-line is a gate (B5)

A class is **stopped** when its two latest escapes both have
`mechanism_upgrade: none`. Escapes are findings with a `mechanism_gap`. A
stopped class refuses every change whose questions include it, in the hook,
at commit and in CI. It is released only by a `stopline` record in
`findings/classes.json` whose `after` names the later of the two escapes.
The record carries one of:

- `detector`: a reference that is also in the class's `detectors` and
  resolves. The class now has a check that runs.
- `waiver: { by, on, record }`: the owner accepts the risk. It is
  self-declared and visible in the pull request.
- `debt: { plan, until }`: the detector is planned, by a date. After
  `until` the class is stopped again.

A new pair of escapes re-stops the class, because `after` no longer matches.
The review document is still written. It no longer releases anything.

## Adversary table

The adversary is the author agent under time pressure, not a malicious
outsider.

| #   | Move                                                                            | Must-hold outcome                                                                                         | Test (test/self-evolution.test.mjs)                                  |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Hook blocks an edit; agent writes the file with `cat > f <<EOF` instead         | the shell command is refused with the same missing questions                                              | a shell command that may write is refused until the branch answers … |
| 2   | Agent writes with `python - <<EOF … open(p,'w')` (target unreadable)            | opaque writer: refused unless the watch list and changed files are answered                               | an opaque writer must answer the watch list                          |
| 3   | Agent chains a write after a read: `git status && sed -i … f`                   | the chain is judged by its writing segment                                                                | the shell classifier: every read-only form passes …                  |
| 4   | Shell write lands (hook not loaded); agent keeps going                          | next writing command refused: working-tree changes need answers                                           | a shell command that may write is refused …                          |
| 5   | After review, agent rewrites C-06.1 to match the fix                            | pre-commit and CI refuse; only a revision naming a finding is accepted                                    | an answer, once committed, is never rewritten …                      |
| 6   | Agent rewrites the answer in a middle commit, restores it later                 | the range check compares every commit to its predecessor                                                  | an answer, once committed, is never rewritten …                      |
| 7   | Agent deletes the answers file or the `version` field to fall back to old rules | a file new on the branch must be version 2; absence refuses                                               | absent inputs refuse …                                               |
| 8   | Agent writes `guard: "test/x.test.mjs::anything"` that does not exist           | commit and CI refuse: the reference must resolve                                                          | every answer names a guard that resolves …                           |
| 9   | A finding lands in an answered class with no `answer_failed`                    | pre-commit and CI refuse                                                                                  | a finding added under an answered class names the answer that failed |
| 10  | Agent cites a `qid` from another class in `answer_failed`                       | refused: the qid must belong to the finding's class and be answered                                       | a finding added under an answered class …                            |
| 11  | Agent writes a review document to release a stopped class                       | the class stays stopped: only a `stopline` record with the right `after` releases it                      | a class whose last two escapes upgraded nothing stops changes …      |
| 12  | Agent records `debt` with a far `until`                                         | allowed, and visible in the PR. The date is self-chosen (ceiling 3). The owner reviews it before merging. | —                                                                    |
| 13  | Agent sends a 1 MB command to wedge the classifier                              | refused as unclassifiable at 64 KiB; no parse                                                             | a command longer than the bound is refused …                         |

## Input-space table

| Input         | Classes covered                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Hook payload  | Edit, Write, MultiEdit, NotebookEdit, Bash, other tools, non-JSON, missing `tool_input`, cwd outside the repo, relative and absolute paths |
| Shell command | Empty; one segment; `&&`, `\|\|`, `;`, `\|` and newline chains; quotes containing `>`; `2>&1`, `>/dev/null`; heredoc; `$(…)`; over 64 KiB  |
| Answers file  | Absent; v1; v2; malformed JSON; answer changed; answer removed; revisions appended; a revision naming an unknown finding                   |
| Ledger change | No new finding; a new finding in an unanswered class; one in an answered class with or without `answer_failed`; a wrong qid                |
| Registry      | Class not stopped; stopped with no record; record with a stale `after`; detector not in the list; waiver; debt before and after `until`    |

## Evidence-source declaration

| Claim                             | Source                                                           | Strength                                                                                     |
| --------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The question was answered         | the committed answers file                                       | Self-declared. Truth is for review.                                                          |
| The answer predates later changes | git history of the answers file (R2)                             | As strong as the commits. Work done before the first commit cannot be ordered (ceiling 1).   |
| The answer names a check          | `guard` resolves in the tree                                     | Shows the test exists, not that it would fail on the bug (ceiling 2).                        |
| The answer failed                 | `answer_failed` on a finding                                     | Self-declared, and required whenever the class was answered.                                 |
| A stopped class was released      | `stopline` record. A detector resolves; a waiver or debt is text | Detector: machine-checked. Waiver and debt: self-declared and visible in the PR (ceiling 3). |

## Ceilings (stated, not hidden)

1. Answers written after the code but before the first commit look the same
   as answers written first. Only the edit hook observes the order, and only
   for the routes it sees.
2. A guard that resolves can still be too weak to catch the bug. Proving
   that it fails on the bug is mutation work (`npm run drill`), not this
   check.
3. Waivers and debt dates are self-declared. The owner merges, so the owner
   sees them.
4. The shell classifier is conservative. Some read-only commands it does
   not know are treated as writes, and need answers. It never treats a
   writing command as read-only.

## Build order

R1, then R2 and R3 (same file), then R4, then R5. Each lands with its tests
before the next starts.
