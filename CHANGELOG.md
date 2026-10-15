# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed (stranger-test findings, 2026-10-15)

- README failure-path sample now shows the real recovery sequence: settle the
  open entry with a human-decided figure, then `clearReconciliation` — the
  previous snippet refused as written (`RECONCILIATION_ENTRIES_OPEN`).
- Eval runner: execution modes from a ZIP/tarball download (no `.git`) now
  refuse once with `HARNESS_GIT_REQUIRED` (exit 2) instead of eight scattered
  crashes; `--validate` / `--dry-run` keep working without `.git`.
- `sakk reconcile` on a ledger with no halt says `nothing to clear` instead
  of claiming a clear that never happened.
- `sakk status` human output formats money to ≤ 6 decimals (the `1e-6`
  reserve guard no longer prints a float tail); `--json` keeps raw numbers.
- Eval runner main-module detection now compares realpaths: invoked through a
  symlinked path (macOS `/var` → `/private/var`) the CLI previously became a
  silent exit-0 no-op — a false green. Regression proves a refusal fires.

### Added (release line)

- docs/AUDITOR_REPLAY.md: the one-page auditor manual — gold-set integrity,
  deterministic verdict reproduction, judging the judge, and the honest
  boundary of what is not yet replayable.

### Added

- Gold eval harness: 12 cases, deterministic scorer, fixture/gold isolation
  with a SHA-256 manifest, reviewer label gate, fail-closed real-run
  authorization chain, recorder-tested real adapter.
- Mutation drill (`npm run drill`): four named mutants, each killed by its
  named guardian test, with a pristine control run.
- CLI: `sakk init / status / reconcile` (`npx sakk …`), JSON output, exit 3
  while reconciliation is required — CI-gateable.
- Community files: contributing guide, security policy, code of conduct,
  issue/PR templates, architecture notes.

### Added (v3 quality pipeline)

- CONSTITUTION.md, AGENTS.md (+ eval/AGENTS.md), docs/RULES.md (R-01…R-13
  with sources and the first attribution round), specs/ convention,
  session stop-gate, `npm run fuzz` ledger invariant fuzzing, and an
  automated per-PR adversarial review workflow (depth scales with the diff).

### Fixed

- Adversarial-review round 2 (the fix batch reviewed author-blind before
  merge): lock takeover rebuilt on a breaker mutex (judgement+removal in one
  critical section; crashed breakers fail closed to `sakk unlock`); release
  authority is a process-local registry; real-mode machine logs relocated
  out of the evidence store and the gate module copied local (log
  forgeability by the same-uid adversary is now a DOCUMENTED trade-off,
  cross-checked by runner verification); fuzz oracle corrected; work-root
  gate moved first with a real refusal test; --out guard catches crashed
  runs; CI review workflow is static and base-context only (never executes
  PR code with a secret).
- Review batch D/E/F (16 findings, each with an attack-shaped regression
  test): atomic single-winner stale-lock takeover + release ownership check;
  runner-owned evidence paths no longer transit to the real-mode child;
  real-mode test evidence now reads the machine test log (honest real passes
  no longer structurally fail); non-object JSON stdout is a structured parse
  failure; settle overrun records + alerts + halts; flags is schema-required
  with a dual-source halt and entry-resolving signed clearance; retry limits
  count tool machine logs; canary scan covers all run artifacts; strict case
  selector (empty/unknown refuse); corrupt log heads fail closed; --out reuse
  refuses; flag parsing rejects flag-shaped values; tmp-boundary separator.
- Durability: ledger writes fsync before the atomic rename (and best-effort
  directory fsync) — the gate's decision survives power loss.
- Cap comparison carries a conservative epsilon so float drift can never
  fill the cap exactly.
- Stale locks from crashed holders on the same host are detected via owner
  metadata and broken automatically; `forceUnlock`/`sakk unlock --by <name>`
  cover what automation refuses to judge.
- Re-settling a callId with a different amount (or a late unknown-cost flag)
  is refused with `SETTLE_MISMATCH` instead of being silently ignored.
- The real-run authorization gate requires `SAKK_BUDGET_LEDGER_PATH`
  explicitly and never falls back to `SAKK_LEDGER_PATH`.
- CI toolchain pinned (prettier exact version, actions by commit SHA);
  platform support declared (macOS/Linux).

## [0.1.0] - 2026-10-13

### Added

- Fail-closed spend ledger (`src/ledger.mjs`): `initLedger`, `reserve`,
  `settle`, `markReconciliationRequired`, `clearReconciliation`, `readLedger`,
  `totalsOf`, `LedgerError` — reserve-before-spend, hard caps where reaching
  the cap refuses, duplicate `callId` refusal, reconciliation-required state
  that halts all paid calls, atomic lock + temp-rename writes, alert JSONL.
- 23-test ledger suite including a real two-process race.

[Unreleased]: https://github.com/sakk-dev/sakk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sakk-dev/sakk/releases/tag/v0.1.0
