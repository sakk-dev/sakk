# Architecture decision records

Each file records one decision in [MADR 4](https://adr.github.io/madr/)
format: status, date, context, options, outcome and consequences. The full
decision log with commit references is docs/DECISIONS.md; findings are in
`findings/ledger.json`.

A new decision gets the next number. A changed decision gets a new record
that says which one it supersedes; old records are not rewritten.

- [0001](0001-guard-hook-fails-closed.md) The guard hook fails closed —
  accepted, 2026-10-22
- [0002](0002-spend-from-local-agent-logs.md) Spend is read from the agent's
  local logs, with a daily cap — accepted, 2026-10-21
- [0003](0003-agent-never-loosens-its-own-controls.md) The agent never
  loosens its own controls — accepted, 2026-10-27
- [0004](0004-static-shell-guard-with-declared-boundary.md) The shell guard
  is static, with a declared boundary — accepted, 2026-10-27
- [0005](0005-price-snapshot-unknown-model-fails-closed.md) Prices come from
  a LiteLLM snapshot; an unknown model fails closed — accepted, 2026-10-27
- [0006](0006-read-only-localhost-console.md) The console is read-only and
  bound to localhost — accepted, 2026-10-21
- [0007](0007-litellm-gateway-plugin.md) Apps outside coding agents reach
  Sakk through a LiteLLM gateway plugin — accepted, 2026-10-30
- [0008](0008-independent-model-reviews-each-pull-request.md) A model from a
  different provider reviews each pull request — accepted, 2026-10-15
- [0009](0009-auto-merge-under-a-ruleset.md) main is protected by a ruleset,
  and auto-merge is on — accepted, 2026-10-30
- [0010](0010-defer-v1-uat-failures-to-v2.md) v1 closes as it stands; its
  acceptance failures move to v2 — accepted, 2026-10-28
- [0011](0011-apache-2-license-and-dco.md) License under Apache-2.0;
  contributions under the DCO — accepted, 2026-11-01
- [0012](0012-public-repo-from-filtered-history.md) The public repository is
  built from filtered history — accepted, 2026-11-01
- [0013](0013-basic-password-login-sso-later.md) Basic password login now;
  SSO later — accepted, implementation in progress, 2026-11-01
- [0014](0014-open-core-split.md) Open core: regulated packs go to an
  enterprise edition — accepted, 2026-11-01

Related: [retrospectives](../retros/README.md), [roadmap](../ROADMAP.md).
