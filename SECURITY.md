# Security Policy

Sakk is a financial change-control layer: a vulnerability here can mean real
money spent without authorization. Reports are taken seriously and handled
with priority.

## Supported versions

Fixes land on the latest minor release only.

| Version | Supported |
| ------- | --------- |
| 0.3.x   | ✅        |
| < 0.3   | ❌        |

## Reporting a vulnerability

**Do not open a public issue.** Instead, use
[GitHub private vulnerability reporting](https://github.com/sakk-dev/sakk/security/advisories/new)
on this repository (Security → Advisories → Report a vulnerability). The
report stays private between you and the maintainers until a fix ships.

Please include:

- the affected ledger/runner path and a minimal reproduction,
- the impact in money terms where applicable (e.g. "allows spend past the
  cap", "fakes a settled cost"),
- the version or commit you tested against.

## What to expect

- Acknowledgement within **48 hours**.
- An assessment (accepted / not a vulnerability / needs info) within **7 days**.
- A fix or documented mitigation before public disclosure; coordinated
  disclosure timing is agreed with the reporter, and the advisory credits
  you unless you ask otherwise.

Anything that lets an agent spend without a successful reservation, settle a
fabricated cost, or clear reconciliation without a named human is in scope —
including test-infrastructure false greens that would hide such a failure.
