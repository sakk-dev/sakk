# Kill switch (single machine) — spec + three tables

Blueprint P1: "全局/单 agent kill switch (停后状态可证明)". Original-plan
step 3, L1. Touches reserve() refusal logic → core area: three tables +
independent adversarial review before merge (CONSTITUTION #4, R-05).

## What it is

`sakk halt --by <name> [--reason <text>] [--agent <id>]` stops spending:
every subsequent `reserve()` on that ledger refuses (globally, or for one
agent id). `sakk resume --by <name> [--agent <id>]` lifts it. The halt is a
signed record inside the ledger itself, so "was it stopped, by whom, when,
and did anything get through afterwards" is answerable from the books and
the alerts log alone.

## Design decisions

1. **Top-level `halt` key, not inside `flags`.** Four existing code paths
   rewrite `flags` wholesale (settle overrun, unknown-cost settle,
   markReconciliationRequired, clearReconciliation). A halt stored there
   would be silently LIFTED by an ordinary settle. Shape:
   `halt: { global: null | {by, at, reason}, agents: { [id]: {by, at, reason} }, lifts: [{by, at, scope, agentId, haltedBy, haltedAt}] }`.
   **Schema bump (review B2):** the closed-schema rule (C-1) says new
   fields mean a new version, so the first halt rewrites the file as
   `sakk-ledger.v2`, where `halt` is REQUIRED; v1 forbids it. Genesis
   ledgers stay v1 and readable by every release; older releases refuse v2
   by schema name — the safe downgrade direction: an old binary can never
   ignore a halt it does not understand. Resume keeps v2: the halt leaves
   `global`/`agents` and is appended to `lifts`, so who lifted which stop,
   and when, is in the books — not only in the best-effort alert log
   (review S2). Halt and resume keep the ledger's `updatedAt`: they confirm
   nothing about the books, so a stop never makes a stale ledger fresh
   (review S1).
2. **Agent ids are data, not property names (review B1).** Lookups use
   own keys only and writes define own properties, so `__proto__`,
   `constructor`, `toString` behave like any id. reserve, halt and resume
   share one id rule: absent = no agent (for reserve, anonymous; for halt
   and resume, the global scope), otherwise a non-empty string
   (`AGENT_ID_INVALID`). `null` is anonymous for reserve only — halt and
   resume refuse it (row 15). Matching is exact and case-sensitive.
3. **Halting can never be blocked by the conditions it exists for.** The
   halt path reads with infinite staleness (stale books can be stopped),
   works during reconciliation, and the CLI retries lock acquisition (a
   runaway agent storm is exactly when the lock is contended).
4. **Settle stays open during a halt.** In-flight calls must still record
   their real cost; refusing settles would turn a stop into lost books.
5. **First halt wins.** Halting an already-halted scope keeps the original
   record (who stopped it first, when) and reports `alreadyHalted`.
6. **No MCP tools for halt/resume.** An agent must never be able to lift
   its own stop. Status (read-only) exposes the halt over MCP.
7. **Per-agent halt is identity-scoped and identity is self-declared**
   (agentId passed by the caller). The GLOBAL halt is the hard stop;
   per-agent halts stop cooperative or mis-behaving-but-honest agents.
   Stated in docs, not hidden.

## Adversary table

| #   | Move                                                       | Must-hold outcome                                                             |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Runaway agent keeps calling reserve after a global halt    | every call refuses `LEDGER_HALTED`; zero new entries; each refusal alerted    |
| 2   | Halted agent retries under its own id                      | `AGENT_HALTED`; other agents unaffected                                       |
| 3   | An ordinary settle / reconciliation after the halt         | halt survives (top-level key never rewritten by those paths)                  |
| 4   | Operator halts a ledger that is stale or in reconciliation | halt succeeds                                                                 |
| 5   | Lock storm while halting (6 workers hammering)             | CLI halt succeeds within its retry budget                                     |
| 6   | Someone hand-edits `halt` into garbage                     | `LEDGER_SCHEMA_INVALID` — a malformed halt record never reads as "not halted" |
| 7   | Agent tries to resume itself over MCP                      | no such tool exists                                                           |
| 8   | Halt then immediate reserve from a process mid-flight      | after halt returns, no reserve can succeed (both under the same lock)         |
| 9   | Resume with no name / resume when not halted               | `RESUME_BY_REQUIRED` / honest "nothing halted"                                |
| 10  | Halt an agent named `__proto__` / `constructor`            | record written to disk as an own key; refuses that id; never a false "halted" |
| 11  | Agent reserves with a numeric id to dodge a string halt    | `AGENT_ID_INVALID` before the lock                                            |
| 12  | Delete the `halt` key from a v2 file                       | `LEDGER_SCHEMA_INVALID` — never reads as "not halted"                         |
| 13  | Lock held by a live process longer than one acquire budget | CLI halt keeps retrying and lands once the holder lets go                     |
| 14  | `resume --agent=bot` / misspelled or repeated `--agent`    | exit 2 — never widens to a global resume                                      |
| 15  | `halt`/`resume` with `agentId: null` (failed id lookup)    | `AGENT_ID_INVALID` — null never means "everyone" for a stop or a resume       |
| 16  | Overrun settle while halted; money paths after a resume    | halts survive the flags rewrite; a resumed ledger stays v2                    |
| 17  | A scoped resume while a global halt is set, or the reverse | each lifts exactly its own scope (drill MUT-W)                                |
| 18  | Halt or resume a STALE ledger                              | it stays stale — a stop never reopens spending                                |
| 19  | Reserve while halted AND in reconciliation                 | `LEDGER_HALTED`, alerted — the stop outranks every other check                |
| 20  | Resume, then lose the alert log                            | who lifted which halt is in the ledger's `halt.lifts`                         |

## Input space

- halt scope {global, agent} × prior state {clean, halted same scope,
  halted other scope, reconciliation, stale} × caller {CLI, library}
- reserve agentId {absent, halted id, other id}
- halt record fields {missing, wrong type, empty strings, extra keys}

## Evidence sources (R-02)

The ledger file's `halt` record, `sakk-alerts.jsonl` (HALT_SET,
HALT_CLEARED, HALT_REFUSED lines), and `sakk status` (exit 4 while globally
halted). Never process output alone.

## Contract (done = converged)

- [x] every adversary row has a named test (rows 1-6, 8-20 unit; 7 MCP)
- [x] invariant fuzz gains halt/resume ops: no reservation is granted
      while a global halt is active, nor to a halted agent; the agent pool
      includes `__proto__`/`constructor`/`toString`, every agent halt must
      be on disk as an own key, and a v2 ledger never drops back to v1
- [x] new public codes in CHANGELOG: `LEDGER_HALTED`, `AGENT_HALTED`,
      `HALT_BY_REQUIRED`, `RESUME_BY_REQUIRED`, `AGENT_ID_INVALID`; status
      exit 4; schema `sakk-ledger.v2`
- [x] genesis-ledger compat (absent `halt`) tested
- [ ] independent adversarial review before merge
