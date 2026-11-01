# Retrospectives

Blameless write-ups of things that went wrong while building Sakk, and what
changed because of them. Facts come from `findings/ledger.json` and the git
history. Each retro says what happened, the impact, the root cause, what
changed (with the test that now guards it) and what we would do differently.

- 2026-10-21 — [Twelve ways around the self-evolution gate](2026-10-21-self-evolution-bypasses.md)
  (F-129 to F-140)
- 2026-10-22 — [The gate locked out its own repair](2026-10-22-f141-gate-lockout.md)
  (F-141)
- 2026-10-30 — [Pinning LiteLLM after its compromised releases](2026-10-30-litellm-version-pinning.md)
  (near miss, no finding; DECISIONS D14)
- 2026-10-31 — [The console was not built to its frozen design](2026-10-31-console-not-built-to-frozen-design.md)
  (F-223, and the earlier F-201)
- 2026-11-01 — [The doctor's self-test was counted as an agent's blocked action](2026-11-01-f229-doctor-self-test-counted.md)
  (F-229)

How findings are recorded and classed: docs/SELF_EVOLUTION.md. Decisions:
[architecture decision records](../adr/README.md).
