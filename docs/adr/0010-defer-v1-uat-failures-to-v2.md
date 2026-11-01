---
status: accepted
date: 2026-10-28
decision-makers: the maintainer
---

# v1 closes as it stands; its acceptance failures move to v2

## Context and Problem Statement

The black-box acceptance run of v1 failed 37 of 151 P0 cases. Fixing them
in v1 would keep the release open with no end date; shipping without saying
so would be dishonest. What happens to v1?

## Decision Drivers

- Users must know what does not work.
- No release loop that never ends.
- Every failure stays traceable to a finding and a fix plan.

## Considered Options

- Fix all 37 in v1 before closing.
- Close v1 unchanged, document the gaps as known limits, and move all 37 to
  a v2 list.

## Decision Outcome

Chosen option: "Close v1 unchanged and move the 37 to v2" (DECISIONS D10).
No code changed in v1. The security gaps were written up as known limits.
The failures became findings F-182 to F-201, and the v2 plan is
docs/V2-BACKLOG.md. The next day the maintainer answered the open questions
and v2 work started detector-first: each fix lands with a test shown red
before it (D11).

### Consequences

- Good, because the gaps are public and each has an owner and a test plan.
- Good, because the v2 list became the public roadmap (see
  docs/ROADMAP.md).
- Bad, because v1 shipped with known guard gaps an agent can use.

### Confirmation

Each v2 item counts as done only when its P0 case's expected result is
observed in a run of the case's own steps. A test with a matching name is
not a pass (F-182).

## More Information

Review notes: the closeout and deferral reviews under `findings/reviews/`.
