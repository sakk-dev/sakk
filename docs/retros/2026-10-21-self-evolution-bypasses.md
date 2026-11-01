# Retro: twelve ways around the self-evolution gate (2026-10-21)

Blameless. Findings F-129 to F-140 in `findings/ledger.json`.

## What happened

Sakk's self-evolution gate asks a change to answer each prevention question
for the classes of bugs it touches, and to name a test that guards the
answer. On 2026-10-21 the maintainer and an adversarial review tested the gate in
practice, in this repository and in a second project that uses it, and
found twelve ways to pass it without doing what it asks.

## Impact

- In the second project, about 70 committed answers were rewritten after
  review (F-129).
- Any 40 characters of prose counted as an answer; 73 of 80 answers upgraded
  no check (F-130).
- A project's pre-edit hook fired 0 times across 228 edit-tool writes,
  because sessions started in its parent folder (F-132).
- The replay found an earlier commit had silently rewritten a past finding's
  symptom (F-137).

## Root cause

The gate checked that answers existed, not that they were true or stayed
put. Each check trusted something the change under review could edit: the
answers file, the gate's own data, the checker code CI ran, the git hooks.
And the hook was tested by running it with a payload, never by watching it
fire in a real session.

| Finding | Gap                                                       | What changed                                                          | Guard test                                                                             |
| ------- | --------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| F-129   | Committed answers could be rewritten                      | Answers are frozen once committed; corrections are revisions          | `F-129: a committed answer cannot be rewritten at commit time`                         |
| F-130   | Any prose passed                                          | Each answer names a guard; a failed answer is recorded                | `F-130: an answer that names no guard is not an answer`                                |
| F-131   | A document released stop-the-line                         | A stopped class blocks changes until its stop-line review is recorded | `F-131: a class whose last two escapes upgraded nothing stops the change`              |
| F-132   | Hooks don't load from a parent folder                     | The parent folder routes to each repository's hooks                   | `F-132: a shell write routed from a parent folder still meets the gate`                |
| F-133   | Git commands that rewrite files were read-only            | Git is classified by its effect on the working tree                   | `F-133: git commands that rewrite tracked files are writes`                            |
| F-134   | Renaming the branch started fresh                         | Freezing carries across the range                                     | `F-134: renaming the branch does not unfreeze committed answers`                       |
| F-135   | Any upgrade text released a stopped class                 | Only a test path and name that resolve count                          | `F-135: a later escape with a prose upgrade does not release a stopped class`          |
| F-136   | A guard could be a document                               | A guard must be a test                                                | `F-136: a guard must be a test, not a document`                                        |
| F-137   | The gate's data could be loosened in the change it judges | Ledger and registry only move forward                                 | `F-137: a prevention question cannot be loosened in the change it judges`              |
| F-138   | CI ran the pull request's own checker                     | The base branch's checker runs too                                    | `F-138: CI runs the base branch's checker over every pull request`                     |
| F-139   | No guard was shown to fail before its fix                 | A guard that already passes before the fix is refused                 | `F-139: a guard that already passes before the fix is refused`                         |
| F-140   | Turning hooks off passed, with no dispute path            | Refused outright; a dispute goes to the inbox                         | `F-140: commands that turn the git hooks off are refused even with every answer given` |

All twelve guard tests are in `test/self-evolution-cli.test.mjs`.

## What changed

Fixes landed in commits 7237bcb, e3eec09, d2aeaf7 and 7a20a52 (PRs #16 and
#18). The common rule: nothing the change controls may decide whether the
change passes.

## What we'd do differently

- Attack a gate before trusting it: these gaps showed up once someone
  tried to get past it on purpose.
- Prove a hook fires in a real session, not only when called directly.
- Treat a review document as information, never as a release mechanism.
