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
| Every problem seen is logged                                 | —                                                       | refused while `findings/inbox/` holds an item                 | —                                                |
| A fix names the finding it fixes                             | —                                                       | commit-msg hook: `F-nn` in the ledger, or `No-finding: <why>` | every commit made since the rule existed         |
| A known problem is an occurrence of its class, not a new one | —                                                       | the ledger gate runs in pre-commit                            | the ledger gate runs in `npm test`               |

`npm install` installs the git hooks (`prepare` sets `core.hooksPath` to
`scripts/hooks`), so every clone has them. Codex and people meet the git
hooks and CI; Claude Code sessions also meet the edit hook
(`.claude/settings.json`). `--no-verify` skips the local hooks, not CI.

## The answers

`npm run brief -- <paths>` lists, for the files a change touches, the
problem classes they have hit and the questions to answer — every question
of those classes plus those of the three most frequent classes (the watch
list). Answers go in `findings/acks/<branch>.json`:

```json
{ "branch": "feat/x", "answers": { "C-01.1": { "answer": "how this change avoids it" } } }
```

An answer is at least 40 characters, not a placeholder (todo, tbd, same,
see above) and not a copy of another answer. Whether it is true is for
review; the file is committed, so the review sees it.

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
- Shell edits: the edit hook sees Claude Code's edit tools, not files
  written by a shell command; the commit hooks and CI catch those (F-120).
- Truth of answers and correctness of a class choice stay with review; a
  model judge for the class choice needs a CI model key.
