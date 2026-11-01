---
status: accepted
date: 2026-11-01
decision-makers: the maintainer
---

# The public repository is a new repository built from filtered history

## Context and Problem Statement

The private repository's history holds material that cannot be public:
personal names and local paths in commit text and findings, and the
regulated case packs that move to the enterprise edition (ADR-0014). The findings ledger and decision log cite commit ids,
so history is part of the product's evidence. How is the public repository
created?

## Decision Drivers

- Nothing private reaches the public repository, in any commit.
- Authorship and the finding-to-commit trail survive.
- The private repository keeps working unchanged.

## Considered Options

- Make the existing repository public.
- Publish a single squashed commit.
- Create a new public repository from filtered history, keeping authorship.

## Decision Outcome

Chosen option: "A new repository from filtered history". The history is
rewritten to drop or de-identify private paths and text, authorship is kept,
and the private repository stays private.

### Consequences

- Good, because the public history carries no private material and still
  shows how each fix happened.
- Good, because the private repository and its pull requests are untouched.
- Bad, because rewritten commits get new ids, so ids cited in the ledger and
  the decision log need a map from old to new.
- Bad, because two repositories must be kept in step until the private one
  is retired or reduced to the enterprise edition.

### Confirmation

A de-identification scan over the filtered history must come back clean
before the first push.

## More Information

Related: ADR-0011 (license), ADR-0014 (open-core split).
