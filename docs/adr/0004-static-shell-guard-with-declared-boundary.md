---
status: accepted
date: 2026-10-27
decision-makers: the maintainer
---

# The shell guard is static, with a declared boundary

Extended 2026-10-29 (DECISIONS D11, F-176).

## Context and Problem Statement

The guard judges a shell command before it runs, from its text. Some targets
are only known at run time: a secret name built from parts, a path held in a
variable. The acceptance run found such reads slipping past the secret guard
(F-173). Should the guard try to evaluate the shell, or stay static and say
where it stops?

## Decision Drivers

- The guard runs on every tool call, so it must be fast and predictable.
- An unresolvable command must not pass silently.
- Run-time interception belongs to a layer that sees run time.

## Considered Options

- Evaluate or emulate the shell before deciding.
- Stay static; deny what is spelled out, ask on what is constructed, and
  document the rest.
- Stay static and treat unresolved expansions as allowed.

## Decision Outcome

Chosen option: "Stay static with a declared boundary" (D5). Spelled-out
secret reads are denied, constructed ones are asked, and names chosen at run
time are a documented limit. On 2026-10-29 the maintainer tightened one part
(F-176): an unresolved variable or brace expansion anywhere in a command now
always gets "ask".

### Consequences

- Good, because the decision is a pure function of the command text and
  stays cheap.
- Good, because the limit is written in docs/GUARD.md and the README, not
  discovered.
- Bad, because ordinary commands with variables now prompt more often.
- Bad, because a name picked at run time is not caught here (K-SEC-043,
  K-SEC-045 stay a limit).

### Confirmation

- `test/secret-guard.test.mjs::K-SEC-043/K-SEC-045 spelled-out secret reads are denied, constructed ones asked, run-time-picked names allowed`
- `test/guard.test.mjs::an unresolved variable or brace expansion anywhere in a command is constructed (F-176)`

## More Information

Commit 4febbf3 (D5). Open spelling gaps in the same area: case variants
(F-183), git option forms (F-184), symlinked targets (F-186).
