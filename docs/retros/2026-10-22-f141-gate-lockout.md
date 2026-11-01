# Retro: the gate locked out its own repair (F-141, 2026-10-22)

Blameless. Finding F-141 in `findings/ledger.json`; class RC-09.

## What happened

During a refactor, the shell tokenizer was moved into `src/classify.mjs`
before that file existed. The findings library then failed to import, so
the findings checker crashed before its own repair exemption could run. The
parent folder's dispatcher fails closed on a crash (ADR-0001), so it denied
every edit and every shell command in the repository for the rest of the
session, including the edits that would have repaired it.

## Impact

- The session could not change any file in the repository.
- Work continued only as drafts outside the repository until the maintainer
  restored one file by hand.
- The fail-closed rule held, but it stopped all work, not just the bad
  change.

## Root cause

The repair exemption sat behind a static import that could fail, so one
module's failure took down its own repair path. The exemption had been
written for errors inside the check, not for the check failing to load. The
dispatcher was made fail-closed without a repair path that did not depend on
the component that failed.

## What changed

- The library loads lazily. While it cannot load, edits to the findings
  scripts, `src/classify.mjs` and `findings/` still pass, and so does a
  `git restore` of exactly those files. Everything else is denied with a
  message that says how to repair.
- RC-09 stop-line review (commit cd3b7d5): the dispatcher runs the gate
  from a last known good copy taken from HEAD and kept outside the working
  tree. A new copy is adopted only after it passes the self-test of the copy
  it replaces.
- Pre-commit and CI still fail while the checker cannot load.

Guard test:
`test/self-evolution-cli.test.mjs::F-141: while the checker cannot load, its code is restored from git, never rewritten`.

## What we'd do differently

- When a component fails closed, design its repair path first and test it
  by breaking the component on purpose.
- Keep the repair path out of the code that can fail.
- Move a shared helper by adding the new file before changing imports.
