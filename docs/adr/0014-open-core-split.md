---
status: accepted
date: 2026-11-01
decision-makers: the maintainer
---

# Open core: the guard, spend gate and evidence stay public; regulated packs go to an enterprise edition

## Context and Problem Statement

Sakk has two kinds of content. The guard, spend gate, console and tests are
useful to anyone. The regulated case packs and strict policy for financial
regulators need legal review before outside use (F-127) and are the planned
basis of an enterprise edition. What goes in the public repository?

## Decision Drivers

- Everything a single developer needs is open.
- Anything that implies legal or regulatory advice is not published until it
  has been reviewed.
- The evidence that the gates work stays public, so users can check the
  claims.

## Considered Options

- Everything public.
- Everything private, with a binary release.
- Open core: product and gates public; regulated content private.

## Decision Outcome

Chosen option: "Open core".

- **Public:** `src/`, the Claude Code plugin, the policies except the
  regulated strict policy, `integrations/`, the tests, the gold eval set and
  the docs. The evidence bundle and auditor replay (docs/AUDITOR_REPLAY.md)
  stay public as gate infrastructure.
- **Enterprise edition, not in open source:** the regulated eval packs
  (CBUAE, DIFC, DORA), the case packs, the regulated strict policy and the
  compliance review.
- docs/V2-BACKLOG.md becomes the public docs/ROADMAP.md.

### Consequences

- Good, because the open release is complete for a developer or a small
  team.
- Good, because regulated content is not published before it is reviewed.
- Bad, because two repositories and two scopes must be kept apart.
- Bad, because enterprise items on the roadmap carry no date or price until
  they exist.

### Confirmation

`test/release.test.mjs::P-ACC-005 enterprise / login / regulatory features are an honest stub, never claimed shipped`.

## More Information

Planned for the 0.3.0 release. Related: ADR-0011, ADR-0012.
