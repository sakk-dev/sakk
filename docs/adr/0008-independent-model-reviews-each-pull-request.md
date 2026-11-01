---
status: accepted
date: 2026-10-15
decision-makers: the maintainer
---

# A model from a different provider reviews each pull request

## Context and Problem Statement

Most of Sakk's code is written with a coding agent. A reviewer from the same
model family tends to share the author's blind spots. Each pull request
needs an adversarial review that is independent of the author, cheap enough
to run on every push, and safe to run in CI.

## Decision Drivers

- Independence from the authoring model.
- Low cost per review.
- CI must never run code from the pull request while a secret is present.
- A review that could not run must never show as passed.

## Considered Options

- Same-provider model as the author.
- A different provider through an OpenAI-compatible API.
- Human review only.

## Decision Outcome

Chosen option: "A different provider", recorded in the workflow as a
maintainer decision of 2026-10-15. The review uses DeepSeek: the reasoning
model for diffs touching `src/`, `bin/` or the eval code, and the chat model
otherwise.

The job checks out the base ref and reads the pull request only as a diff.
Without the key it shows as skipped, never as passed (F-142). A newer push
cancels the older review (F-218). The review informs the human merge
decision and does not replace it.

### Consequences

- Good, because a second model family looks for what the first one missed.
- Good, because PR code never runs next to the review key.
- Bad, because review is static only; executable probing stays local.
- Bad, because a provider outage would block merges if the review were
  required, so it is not a required check (ADR-0009).

### Confirmation

- `test/ci-honesty.test.mjs::the review that needs a key is gated at the job, so a missing key shows as skipped`
- `test/ci-cost.test.mjs::every workflow runs once per commit: a push only on main, a pull request on its own event`

## More Information

Workflow file `pr-review.yml` under `.github/workflows/`.
