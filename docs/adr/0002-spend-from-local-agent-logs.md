---
status: accepted
date: 2026-10-21
decision-makers: the maintainer
---

# Spend is read from the agent's local logs, with a daily cap

Amended 2026-10-29 (DECISIONS D12).

## Context and Problem Statement

A coding agent spends money on model calls. The operator wants a daily cap
that stops the agent, not a bill that arrives later. Where does Sakk get the
spend figure from, given that v1 sits beside the agent and not in its network
path?

## Decision Drivers

- No new infrastructure for a first install.
- The figure must be honest about its source.
- The cap must fail closed when the figure cannot be read.

## Considered Options

- Read the usage the agent already writes to its local logs, price it from a
  shipped table, and enforce the cap in the hook.
- Stand a local proxy in the API path and meter at egress.
- Ask the caller to report its own cost.

## Decision Outcome

Chosen option: "Read the agent's local logs", because it needs nothing
beyond the hook and gives a usable cap on day one. The figure is labelled
"from local logs" everywhere it appears. A model the price table does not
know fails closed (ADR-0005).

On 2026-10-29 the maintainer added a booking rule (F-210): a log line first
seen after the baseline that claims an earlier day is booked to the day it
was observed and flagged `backdated`. The baseline is set by the first whole
scan. File mtime is no longer trusted as a scan boundary (F-211).

### Consequences

- Good, because the cap works with no proxy, key or account.
- Good, because money first seen today cannot hide in a closed day.
- Bad, because the agent writes the logs it is judged by. The C-07 family
  (F-191, F-205, F-210, F-211) comes from that. D12 sends the local proxy and
  key custody to v2 to close it at the architecture level.
- Bad, because a caller that reports its own cost over MCP is believed
  (F-125, open).

### Confirmation

- `test/spend.test.mjs::a forged old-dated line appearing after the baseline lands in today, flagged, and hits the cap`
- `test/spend.test.mjs::a file planted with a faked old mtime is still read — mtime is not a trust boundary`

## More Information

docs/SPEND.md states the limits. The LiteLLM gateway (ADR-0007) meters at
egress for apps that are not coding agents.
