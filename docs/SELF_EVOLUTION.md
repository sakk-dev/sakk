# Self-evolution loop

The findings ledger (`findings/ledger.json`) records every problem with its
root cause. This loop makes the ledger act **before** the next problem, not
only after it: check the ledger → avoid what it knows → log what is new →
upgrade the check that missed it → check the ledger again. It implements
section 15 of the internal AI-agent testing standard (v1.2).

## The four steps

| Step     | When                   | What                                                                                                                                                                                                                                                          | Enforced by                                                                  |
| -------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1 Check  | before a change        | `npm run brief -- <paths>`: past findings whose `areas` cover those paths (open first), the questions from `findings/prevention.json` for their classes, the known blind spots of the checks that will run, and those checks                                  | `npm run gate` prints the brief on every commit; the PR template asks for it |
| 2 Avoid  | while building         | answer each question in the plan; the class detectors run in `npm test`                                                                                                                                                                                       | the test suite                                                               |
| 3 Log    | the moment it is found | a finding with `areas`, root cause and guard. If its class already had a detector when it was found, it is an **escape**: also `mechanism_gap` (why the check missed it) and `mechanism_upgrade` (the check that now catches this shape, or `none: <reason>`) | the ledger gate (`test/findings-ledger.test.mjs`, "self-evolution gate")     |
| 4 Evolve | every escape           | upgrade the detector — from one textual shape to generated or exhaustive input; add the lesson to `findings/prevention.json` (each question cites the findings it came from)                                                                                  | the ledger gate and the two indicators below                                 |

## What the gate checks

- every finding names `areas` that exist in the repository;
- every class-mechanism reference carries `since` — the last finding id
  that existed when it landed — so "was there already a detector?" is
  computed, not remembered;
- every escape has `mechanism_gap` and a `mechanism_upgrade` that resolves
  to a check, or `none:` with a reason;
- every root-cause class and pattern in the ledger has at least one
  prevention question, learned from findings of that class;
- a class whose last two escapes could only say `none:` needs a stop-line
  review naming both — the detector design is not keeping up (standard
  §15.4);
- a control proves the escape rule is not vacuous (F-65 is an escape,
  F-11 is not).

## Indicators (`npm run findings-report`)

- **past-detector escapes ↓** — findings whose class already had a
  detector that missed them.
- **detector upgrade rate ↑** — of those, the escapes that upgraded a check
  rather than only fixing the instance.

When the loop started (findings F-51 … F-79), 27 of 29 findings were
escapes past an existing detector, and 14 of the 27 upgraded a check.

## What it does not do

- It cannot make anyone read the brief. It makes the brief impossible to
  miss (the gate prints it) and its use reviewable (the PR template).
- Prevention questions are written by people and reviewed like code; the
  gate checks that they exist and cite real findings, not that they are
  good questions.
- `areas` route lessons by path. A change in a new file that repeats an old
  mistake is caught by the class detectors and the watch list (the three
  most frequent classes are always shown), not by area.
