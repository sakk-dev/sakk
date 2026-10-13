# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Gold eval harness: 12 cases, deterministic scorer, fixture/gold isolation
  with a SHA-256 manifest, reviewer label gate, fail-closed real-run
  authorization chain, recorder-tested real adapter.
- Mutation drill (`npm run drill`): four named mutants, each killed by its
  named guardian test, with a pristine control run.
- Community files: contributing guide, security policy, code of conduct,
  issue/PR templates, architecture notes.

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
