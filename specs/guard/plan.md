# Plan — agent guard (M1)

The tasks run in order. Each task lands with its tests before the next one
starts.

0. **Pay the C-04 stopline debt** (due 2026-10-28). Add a class detector
   that feeds attacker-shaped inputs to every exported matcher and ledger
   operation and asserts a bound on work done, using a counter, never a
   clock. Record it as the stopline detector in `findings/classes.json`.
   The classifier comes after it, because it is the next matcher.
1. **Watch each agent fire once.** Install a probe hook that only logs the
   payload, in Claude Code, Cursor and Codex. Record each real payload
   under `test/fixtures/hooks/<agent>/`, and confirm assumptions A1–A5 in
   `spec.md` or correct them. Nothing else starts before this (lesson
   F-132: a configured hook is not a running hook).
2. **`src/classify.mjs`.** Move the shell tokenizer from
   `scripts/findings-lib.mjs` into it; the loop imports it from there. Add
   unwrapping, the action table and canonical scopes with `~outside/`.
   Register the file as core in `test/core-specs.test.mjs` with this spec.
3. **`src/hook.mjs`.**
   - Normalize each agent's payload, run the four checks, and answer per
     agent.
   - Log the decision.
   - Keep a 2 s deadline and a catch-all deny.
   - `bin/sakk.mjs hook`.
4. **`policies/guard-default.json`** as in the spec. It must load clean
   (no vacuous allow, no shadowed rule).
5. **`sakk try`**: classify, decide each action and print the result,
   using the same code path as the hook.
6. **`sakk guard install|uninstall`**: merge, back up, print the diff, be
   idempotent, and write `onFailure: "block"` when the Claude Code version
   supports it.
7. **`sakk doctor`**: the seven checks, including the start-folder check
   and the fire test.
8. **Mutation drill anchors** for the halt check, the strictest-answer
   merge, the catch-all deny and the scope canonicalizer.
9. **Independent adversarial review**, rounds until it converges. Each
   finding goes to the ledger with `answer_failed` where it applies.
10. **One pull request** against the open-source stack. The owner merges.

Files: `src/classify.mjs`, `src/hook.mjs`, `policies/guard-default.json`,
`bin/sakk.mjs` (hook, try, guard, doctor), `test/guard.test.mjs`,
`test/fixtures/hooks/`, `docs/GUARD.md`, README quick start.
