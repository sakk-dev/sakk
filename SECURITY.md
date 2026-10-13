# Security Policy

Sakk is a financial change-control layer: a vulnerability here can mean real
money spent without authorization. Reports are taken seriously and handled
with priority.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting a vulnerability

**Do not open a public issue.** Instead, use
[GitHub private vulnerability reporting](https://github.com/sakk-dev/sakk/security/advisories/new)
on this repository.

Please include:

- the affected ledger/runner path and a minimal reproduction,
- the impact in money terms where applicable (e.g. "allows spend past the
  cap", "fakes a settled cost"),
- the version or commit you tested against.

## What to expect

- Acknowledgement within **48 hours**.
- An assessment (accepted / not a vulnerability / needs info) within **7 days**.
- A fix or documented mitigation before public disclosure; coordinated
  disclosure timing is agreed with the reporter.

Anything that lets an agent spend without a successful reservation, settle a
fabricated cost, or clear reconciliation without a named human is in scope —
including test-infrastructure false greens that would hide such a failure.
