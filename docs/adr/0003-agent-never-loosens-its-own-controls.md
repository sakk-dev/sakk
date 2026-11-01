---
status: accepted
date: 2026-10-27
decision-makers: the maintainer
---

# The agent never loosens its own controls

Extended 2026-10-29 (DECISIONS D11).

## Context and Problem Statement

The P0 acceptance run found that an agent allowed to run the `sakk` binary
could lift its own daily cap and remove its own kill switch (F-171). Later
findings showed it could also lift another agent's halt, clear the books or
break the ledger lock (F-177), and rewrite its own hook configuration
(F-188). Which control changes may an agent make?

## Decision Drivers

- A limit the limited party can lift is not a limit.
- Tightening must stay easy: engaging the brake is never blocked.
- A person must stay able to change settings without friction.

## Considered Options

- Let the agent run every command; rely on logging.
- Ask the person for each loosening command.
- Deny loosening commands from the agent; require a person at a terminal.

## Decision Outcome

Chosen option: "Deny from the agent, require a person at a terminal",
because a person at a terminal is a check the agent cannot satisfy by
itself.

- `cap off`, a raised cap and `sakk guard uninstall` need a person at a
  terminal (D4, F-171).
- `sakk resume`, `sakk reconcile` and `sakk unlock` are denied from the
  agent, and the default ledger moves under `~/.sakk` (D11, F-177).
- Writes and deletes to the agent's own hook config, at project or user
  level, are denied outright (D11, F-188).

### Consequences

- Good, because one agent can no longer lift its own or another agent's halt.
- Good, because the loosening path is the same for every agent.
- Bad, because `sakk guard install` run by the agent itself now fails; a
  person runs it.
- Bad, because a constructed terminal is denied rather than asked; the
  review notes in docs/V2-BACKLOG.md list it as a product choice to revisit.

### Confirmation

- `test/kill-switch.test.mjs::J-UAT-016 cap off, a raised cap and guard uninstall refuse without a person at a terminal`
- `test/kill-switch.test.mjs::F-177 the hook denies the commands that lift a halt or clear the books`
- `test/guard.test.mjs::writes and deletes to agent hook configs are denied, project or user level (F-188)`

## More Information

Commit fe936ca (D4). The CLI's own launchers (`npx`, a direct script path)
are not yet resolved before this gate (F-185, open).
