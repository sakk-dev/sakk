---
status: accepted
date: 2026-11-01
decision-makers: the maintainer
---

# License under Apache-2.0; contributions under the DCO

Supersedes the earlier AGPL-3.0-only license.

## Context and Problem Statement

Sakk is going public. The license decides who can adopt it at work, and the
contribution terms decide how much friction a first pull request has. The
project also plans an enterprise edition (ADR-0014).

## Decision Drivers

- Easy adoption inside companies, where AGPL often needs legal review.
- An explicit patent grant.
- Light contribution terms that still record where code came from.
- Room for a separately licensed enterprise edition.

## Considered Options

- Keep AGPL-3.0-only.
- MIT.
- Apache-2.0 with the Developer Certificate of Origin (DCO).
- Apache-2.0 with a contributor license agreement (CLA).

## Decision Outcome

Chosen option: "Apache-2.0 with the DCO". Apache-2.0 is permissive and
includes a patent grant. The DCO asks each contributor to add the sign-off
trailer that `git commit -s` writes, with no separate agreement to sign
first.

### Consequences

- Good, because companies can adopt and embed Sakk without copyleft review.
- Good, because a first contribution needs one flag, not paperwork.
- Bad, because others may build closed products on the code.
- Bad, because the DCO is a statement by the contributor, not a transfer of
  rights; without a CLA, changing the license later is harder.

### Confirmation

The license file, the package's license field and CONTRIBUTING change
together in the release preparation for 0.3.0.

## More Information

Third-party notices for MIT-derived material stay in NOTICE (F-199).
