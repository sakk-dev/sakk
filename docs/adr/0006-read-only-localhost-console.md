---
status: accepted
date: 2026-10-21
decision-makers: the maintainer
---

# The console is read-only and bound to localhost

Extended 2026-10-29 (DECISIONS D11, F-195).

## Context and Problem Statement

`sakk ui` shows spend, blocked actions and agents in a browser. A local web
server is reachable by any page the operator visits, and by the agent
itself. What may the console do, and who may reach it?

## Decision Drivers

- A dashboard must not become a second way to loosen controls.
- A malicious page in another tab must not read or write it.
- One emergency write is useful: stopping an agent.

## Considered Options

- A full admin console with settings and edits.
- A read-only console with one opt-in write (halt).
- No console; CLI only.

## Decision Outcome

Chosen option: "Read-only with one opt-in write", because it gives operators
a view without adding a control surface.

- The server binds 127.0.0.1 and requires a 128-bit token, kept in an
  HttpOnly, SameSite=Strict cookie after the first visit.
- It checks Host on every request, and Origin on every route, GET included
  (F-195).
- A GET never writes, not even the spend index (F-195).
- The one write is halt. It needs `--allow-halt` at start, a matching Origin
  and the token header.

### Consequences

- Good, because a cross-site page can neither read nor halt.
- Good, because the console cannot raise a cap or resume an agent
  (ADR-0003).
- Bad, because a request with no Origin (a typed URL, curl) needs its own
  rule.
- Bad, because the operator must start the console with `--allow-halt` to
  use the stop button.

### Confirmation

- `test/console.test.mjs::a foreign Host header is refused`
- `test/console.test.mjs::F-195 a cross-site Origin is refused on every route, not just the write`
- `test/console.test.mjs::writes need the flag, the origin and the token`
- `test/console.test.mjs::the page sends the halt token from its address, not the HttpOnly cookie (F-223)`

## More Information

Basic password login is added on top of the token (ADR-0013).
