# Stop-line review — 2026-10-17 (making the loop enforced)

Asked: is checking the ledger before development enforced, and is the
self-evolution loop running and fixed in place? Measured answer: only the
ledger's completeness was enforced; the brief, logging every problem and
de-duplicating problems were rule text (F-117, F-118). This round made them
code. Findings F-116 … F-120.

## What is enforced now, and where

| Rule                                              | Edit (Claude Code)              | Commit (git hooks)                                                              | CI (branch)                         |
| ------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------- |
| answer the questions for the files you change     | PreToolUse hook blocks the edit | pre-commit refuses without staged answers                                       | range check over every changed file |
| every problem is logged                           | —                               | refused while `findings/inbox/` holds an item; a red audit step adds one itself | —                                   |
| a fix names its finding                           | —                               | commit-msg hook                                                                 | every commit since the rule existed |
| a known problem is an occurrence, not a new entry | —                               | ledger gate (in pre-commit)                                                     | ledger gate (npm test)              |

The hooks install with `npm install` (prepare), so every clone gets them;
Codex and people meet the git hooks and CI, Claude Code also the edit hook.

## §15.4 — RC-04: F-119, F-120

Both are rules that list cases instead of stating the rule: a placeholder
word list that refused real answers, and an edit hook that lists tool names
instead of "every write to a tracked file". Neither has a class detector:

- F-119's benign corpus is every branch's real answers; the range check runs
  on them in CI, so a too-strict rule now fails a real branch, as it did
  here.
- F-120 is covered at commit and in CI whatever tool wrote the file; the
  open question is whether a heuristic shell-write hook is worth its
  misfires. Recorded as open, not claimed.

## §15.4 — RC-01: F-114, F-121

F-121 (a test that overflowed only on Node 20/22) was caught by the CI
matrix the same hour it was written, but nothing local could have caught
it: the gate and the audit run one Node version. With F-114 (ledger edges
left open) RC-01 has two escapes in a row without a class upgrade. Next
upgrade: the commit gate runs the unit suite on the oldest supported Node
(`npx node@20`) before a push, so the CI matrix stops being the first
place a version difference shows.

## What the loop still cannot do

- **Merge past a red CI** — main has no branch protection (F-116); until
  it does, CI is advisory for whoever merges.
- **Judge an answer's truth.** The checker refuses missing, short,
  placeholder and copied answers; whether an answer is honest is for review.
- **Deduplicate by meaning.** Text similarity was measured useless (76 of
  115 nearest neighbours in another class), so de-duplication is
  structural: registered classes, an approval for any new class, and a
  same-problem declaration beside open findings. A model judge for the
  class choice is possible once a CI model key exists.
