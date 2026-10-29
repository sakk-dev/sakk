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

## The hook's own environment (F-214)

The first real push through the new hook, from a linked worktree, ran the
full suite with the `GIT_DIR` git exports to a hook there. Fixtures in
`test/secret-scan.test.mjs` and the evidence-bundle tests run git in a
throwaway repository; with `GIT_DIR` set, their git acted on the real one: it
set the shared repository to bare, rewrote its hooks path, user and diff
settings, added a replace ref and two commits, and a second push, with no hook
left to run, sent one of them to the remote. The user restored the repository
by hand.

The hook's tests had replaced the suite with a stub and pushed only from the
main checkout, where git does not export `GIT_DIR`; the environment the real
suite would get was never tried. The fix is in two layers: the hook removes
every `GIT_` variable before it starts the range check or the suite, and every
`node --test` launch loads `test/clean-git-env.mjs`, which removes them before
any test file runs, so a hook-started run of any present or future test cannot
reach the repository. The hook test now pushes from a linked worktree with a
suite that records its `GIT_` variables and runs a fixture's git; a meta-test
refuses a `node --test` launch without the preload. Both were checked by
undoing each fix: the worktree test fails without the hook's filter, and the
preload probe fails without the preload.

## What is not covered

- `--no-verify` skips the pre-push hook as it skips the others; the edit
  hook refuses it from Claude Code, and CI still runs the range check.
- Inheritance needs the parent branch on the remote. Deleting a stacked
  parent's branch before its child merges turns its file into a rename,
  and the refusal says so.
