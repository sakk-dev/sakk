---
status: accepted
date: 2026-10-27
decision-makers: the maintainer
---

# Prices come from a LiteLLM snapshot; an unknown model fails closed

## Context and Problem Statement

The shipped price table carried only a few older models, so out of the box
Sakk could not price a current model (F-169). Where should prices come from,
and what happens to a model the table does not list?

## Decision Drivers

- Out of the box, every current model the agent uses must be priced.
- No network call at run time.
- A cap must never read $0 because a model is unknown.

## Considered Options

- Hand-maintain a short table.
- Fetch prices at run time.
- Regenerate a shipped snapshot from LiteLLM's public price map, and fail
  closed on a model it does not list.

## Decision Outcome

Chosen option: "Regenerate a shipped snapshot from LiteLLM", because it
covers current models with no run-time network call. A model missing from
the snapshot fails closed instead of costing nothing.

A `prices` updater command was later retracted rather than built (D11,
F-175); operators update the snapshot by hand, as docs/SPEND.md describes.

### Consequences

- Good, because a fresh install prices every current Claude model.
- Good, because an unknown model stops the agent instead of hiding spend.
- Bad, because a model released after the snapshot is blocked until the
  table is updated.
- Bad, because the package ships MIT-derived price data, so it carries a
  NOTICE (F-199).

### Confirmation

- `test/spend.test.mjs::S-FN-020 the shipped snapshot prices every current Claude model, and an unknown model still fails closed`
- The F-175 release test in `test/release.test.mjs` checks that every
  multi-word command named in docs, specs and runtime strings is real.

## More Information

Commit 1868d79 (D2). Per-request server-tool charges are not priced yet
(F-180, open).
