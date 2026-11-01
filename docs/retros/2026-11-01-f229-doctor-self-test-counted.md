# Retro: the doctor's self-test was counted as an agent's blocked action (F-229, 2026-11-01)

Blameless. Finding F-229 in `findings/ledger.json`; class C-11.

## What happened

`sakk doctor` checks the guard end to end by firing a real probe (a forced
push) through the installed hook. During the full acceptance run on a test
home, the console then showed that probe as a blocked action by Claude Code,
in the blocked counts, on the agents page and in the feed, although no agent
had sent it.

## Impact

- The console overstated blocked actions and showed agent activity that did
  not happen.
- An operator reading the console could not tell a health check from an
  attempted forced push.

## Root cause

The `by` field meant two things. In the hook it meant "who sent this"; in the
console it meant "an agent did this". The doctor reused the agent payload so
the test would be end to end, and gave it no label of its own. The hook could
not tell the probe from an agent, and the console counted every deny by its
`by` field.

## What changed

(commit cf705ba, PR #43)

- The hook logs the decision as `sakk-doctor` only when the doctor's
  environment flag is set and every probe field matches the one command the
  doctor sends. Anything else keeps the agent's name, and the verdict is
  still deny.
- The console leaves those rows out of counts, blocks, agents and the feed,
  and keeps them in records and export as "Doctor self-test".
- The decisions reader counts a line that parses but is not a record as
  unreadable.
- Eight mutations (each probe field, the flag, the label) and the console
  filters each turn a test red.

Mechanism test:
`test/guard.test.mjs::the doctor probe is logged as sakk-doctor only when every field matches (F-229)`.
Guard test:
`test/console.test.mjs::the doctor's self-test is not counted as a blocked action (F-229)`.

## What we'd do differently

- Give every synthetic event its own label from day one.
- When one field is read by two components, write down what it means once
  and test both readers against that meaning.
- Make sure a narrow match cannot be faked: the label applies only when the
  whole probe matches, so an agent cannot hide a real forced push as a
  self-test.
