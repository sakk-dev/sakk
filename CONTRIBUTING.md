# Contributing to Sakk

Thanks for your interest! Two ground rules keep this project sustainable:

1. **CLA required.** Sakk is dual-licensed (AGPL-3.0 + commercial). To keep
   that possible, all contributions must be covered by a Contributor License
   Agreement. The CLA bot will prompt you on your first pull request; PRs
   cannot merge without it.
2. **Tests carry the contract.** Every behavioral change needs a test, and
   every guard needs a negative test. If you weaken a fail-closed path, the
   mutation drills must catch you — that is by design.

Run `npm test` (plain Node ≥20, no dependencies). Keep the zero-dependency rule.
