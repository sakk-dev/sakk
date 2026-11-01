---
status: accepted
date: 2026-10-30
decision-makers: the maintainer
---

# main is protected by a ruleset, and auto-merge is on

## Context and Problem Statement

A red CI run did not block a merge (F-116). Merges waited on a person
watching checks. How should main be protected without making every merge
wait?

## Decision Drivers

- A red check must block a merge.
- No bypass, including for the maintainer.
- A third-party outage must not freeze all merges.
- Cost $0.

## Considered Options

- Paid branch protection on the private repository.
- A repository ruleset with required checks and auto-merge.
- Keep merging by hand.

## Decision Outcome

Chosen option: "A ruleset with auto-merge" (DECISIONS D13). main requires
every check a pull request runs except the adversarial review, with no
bypass actors. The rule is not strict (a branch need not be up to date);
main's own CI catches combined breaks.

The adversarial review (ADR-0008) is not required, because a provider outage
would block every merge. A change to the core is set to auto-merge only
after its review has been read.

### Consequences

- Good, because a red check blocks the merge with no exceptions.
- Good, because green pull requests merge without someone watching.
- Bad, because two green branches can break main together; main's CI is the
  catch.
- Bad, because waiting for the review on core changes is a process rule, not
  a check.

### Confirmation

- `test/merge-rule.test.mjs::main's ruleset requires every check a pull request runs, except the declared review (F-116)`

## More Information

Answers F-116. Cost $0.
