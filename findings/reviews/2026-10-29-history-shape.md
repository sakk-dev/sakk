# Stop-line review — 2026-10-29 (the range check assumed one history shape)

Asked: why did PR #27 fail the range check with 301 problems, when every
commit in it had passed its own pull request? Measured answer: the check
read the branch as one straight line of commits with one answers file.
PR #27 is a stack (#19 … #26) with four lines developed in parallel and
merged. This is the fourth escape of the same assumption, so the class is
reviewed as a whole. Findings F-212, F-213.

## The four escapes

| Finding | History shape the check did not expect                | What broke                                                    |
| ------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| F-72    | a merge commit                                        | the commit hook did not run on it                             |
| F-128   | a stacked branch pushed without a pull request base   | it was charged with its unmerged parents' files               |
| F-134   | a branch renamed                                      | a fresh answers file unfroze the committed answers            |
| F-212   | a stack whose parents were merged into it in parallel | parents' own answers files were read as renames; 301 refusals |

Each fix covered the one shape that had failed. None stated what the check
does with the history it is given.

## The class-level fix

The range check now states its rule once and applies it to every shape:

- a file is changed when it differs from the base at the tip and since the
  fork point;
- every commit is compared with every parent, so merges are covered;
- an answers file added in the range is either another live branch's own
  file (inherited: kept intact, guards resolve at the tip) or this branch's
  file under an earlier name (renamed: carried forward);
- an answers file already on the base is append-only.

`test/range-topology.test.mjs` builds each shape as a real git history —
straight, parallel lines merged, a stacked parent kept live, a parent whose
branch is gone, a parent kept only on the remote, the merge commit CI checks
out, and a base file — and runs the real checker on it. A new shape that is
not in that file is a new finding.

## The process slip (F-213)

The same day a branch was pushed after only the tests the change touched
had run, and CI found what the full suite would have. The rule "run the
full suite before pushing" was text. `scripts/hooks/pre-push` now runs the
range check against the pull request's base and the full suite once per
tree; it has no switch to skip either.

## What is not covered

- `--no-verify` skips the pre-push hook as it skips the others; the edit
  hook refuses it from Claude Code, and CI still runs the range check.
- Inheritance needs the parent branch on the remote. Deleting a stacked
  parent's branch before its child merges turns its file into a rename,
  and the refusal says so.
