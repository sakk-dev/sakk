---
status: accepted
date: 2026-10-22
decision-makers: the maintainer
---

# The guard hook fails closed

## Context and Problem Statement

Sakk's guard runs as a pre-tool hook inside the coding agent. If the hook
cannot run (the binary is missing, Node hangs, the process exits non-zero),
the agent host has to do something with the tool call it was about to make.
Claude Code lets a hook declare what happens on failure. What should Sakk
declare?

## Decision Drivers

- A guard that lets calls through when it breaks protects nothing on the day
  it matters.
- An agent can break its own guard (for example by renaming its binary), so
  failure is an attack path, not only an accident.
- Operators need to see a broken guard, not discover it later.

## Considered Options

- Fail open: on hook failure, let the call run.
- Fail closed: on hook failure, block the call.

## Decision Outcome

Chosen option: "Fail closed", because a broken guard must not be
indistinguishable from an allowed call. The plugin hook declares
`onFailure: 'block'` on matcher `*`, and runs the installed binary as
`node ${CLAUDE_PLUGIN_ROOT}/bin/sakk.mjs hook --agent claude-code`.

### Consequences

- Good, because a missing binary, a hang or a crash blocks the call with a
  hook-failure message instead of passing it.
- Good, because `sakk doctor` can treat a fail-open install as a fault.
- Bad, because a bug in Sakk stops the agent's work until it is repaired. The
  same rule locked a session out of its own repair once (see
  [the F-141 retro](../retros/2026-10-22-f141-gate-lockout.md)); the repair
  path now lives inside the checker.
- Bad, because older Claude Code versions without the failure setting run
  the hook fail-open; Sakk warns rather than refuses there (DECISIONS D6).

### Confirmation

- `test/release.test.mjs::the Claude Code plugin manifest is valid and its hook runs the installed sakk`
  asserts `onFailure` is `block`.
- `test/guard.test.mjs::G-INS-006 install on an old Claude Code warns the operator it is fail-open, and doctor flags it`.
- The three ways to break the hook (rename the binary, a 15 s sleep, exit 1)
  are a manual owner run, P-INS-010, listed in docs/V2-BACKLOG.md.

## More Information

Introduced with the open-source v1 guard and plugin (commits 294f391,
b0280cf). See docs/GUARD.md.
