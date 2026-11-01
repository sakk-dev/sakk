---
status: accepted
date: 2026-10-30
decision-makers: the maintainer
---

# Apps outside coding agents reach Sakk through a LiteLLM gateway plugin

## Context and Problem Statement

Sakk's hooks, MCP server and Node library reach coding agents only. A
Python, Java or PHP app that calls a model had no way to use the spend gate
(DECISIONS D14). How should any language reach it?

## Decision Drivers

- Any language, with no Sakk SDK per language.
- Reserve before the provider call, settle after, like the coding-agent path.
- Low cost and low upkeep for a small project.

## Considered Options

- LiteLLM proxy plus one Sakk callback.
- Portkey OSS gateway (budgets sit in paid tiers).
- Bifrost gateway (needs Go plugins).
- Write a Sakk proxy from scratch.

## Decision Outcome

Chosen option: "LiteLLM proxy plus one Sakk callback", because apps reach it
over the OpenAI chat completions API by changing only the base URL and key.

The callback works out the worst case from prompt bytes and `max_tokens`
(added when the request has none) and reserves it over MCP. A refusal
returns 402 and the provider is never called. After the call it settles the
provider's reported usage; zero on a provider error; the worst case on a
timeout or broken stream. An unpriced or wildcard model, a non-text part and
any route other than chat completions are refused with 403. An unreachable
ledger returns 503, and the gateway will not start without ledger settings.

LiteLLM is pinned to 1.106.2 from a hash-locked install, because the PyPI
releases 1.82.7, 1.82.8 and 1.107.0 were compromised (see
[the pinning retro](../retros/2026-10-30-litellm-version-pinning.md)).

### Consequences

- Good, because one callback serves every language. Cost: $0, about 472 MB
  installed.
- Bad, because a client holding a real provider key bypasses the gateway.
- Bad, because only chat completions are metered in v1.
- Bad, because upkeep includes reading LiteLLM's advisories before any
  version move.
- Bad, because the gateway's Python tests do not run in CI yet.

### Confirmation

The callback's tests live in `integrations/litellm/test_sakk_gateway.py`
and run by hand. Adding them to CI is a v2 item.

## More Information

Commit 90c02ab, merged in PR #38. Follow-ups in docs/V2-BACKLOG.md: CI job,
Anthropic `/v1/messages`, paid search, cached-input prices.
