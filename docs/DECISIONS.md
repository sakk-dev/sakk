# Owner decisions

Decisions the owner made that shape v1: the question, the option chosen,
where it landed and what it leaves open. Findings are in
`findings/ledger.json`; rules in docs/RULES.md.

## D1–D9 — P0 UAT backfill (2026-10-27/28)

| #   | Question                                                                                                 | Decision                                                                                                          | Landed in                                                                                                       | Left open                                                    |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| D1  | The gate's across-names rule read a merged sibling branch's answers as this branch's (inbox item da2423) | C — change the rule, with a documented one-time base-checker exception                                            | Not yet: it lands with the stack merge on main, because the base-checker runs main's copy of the checker        | At merge: rebuild history or land the exception (see below)  |
| D2  | F-169: the shipped price snapshot priced no current Claude model                                         | C — regenerate it from LiteLLM, and a model it does not list still fails closed                                   | 1868d79                                                                                                         | F-175                                                        |
| D3  | F-172: a halt never reached the installed hook                                                           | A — `sakk init` records the absolute ledger path; the CLI and the hook resolve it with one function               | b0144c6                                                                                                         | F-181 (fixed in 3da04ec)                                     |
| D4  | F-171: the agent could lift its own cap and remove its own guard                                         | A — the open core keeps a floor: loosening a control needs a person at a terminal                                 | fe936ca                                                                                                         | F-177                                                        |
| D5  | F-173: a shell expansion reached a secret past the read guard                                            | A — keep the static guard, document and pin the boundary; run-time interception belongs to the layer that sees it | 4febbf3                                                                                                         | F-176                                                        |
| D6  | Defaults for F-168, F-170, F-174                                                                         | Accepted: an empty split is not 0; a fractional count rejects its row; an old Claude Code warns, not refuses      | 92735ea, eebb3f9                                                                                                | —                                                            |
| D7  | The limits the original requirements (REQ-P04) say the README must state                                 | Pin the five REQ-P04 limits in the README                                                                         | 4febbf3 (P-ACC-003)                                                                                             | Whether the full MIT texts ship with the package (P-ACC-008) |
| D8  | The requirements v1 does not implement                                                                   | V2 scope is not set until v1 is complete                                                                          | —                                                                                                               | V2 scope                                                     |
| D9  | Five design principles drawn from these findings, read against the rules                                 | Two new rules (R-23, R-24); two extend R-10/R-17 and R-12/R-22; one is a detector upgrade under R-03/R-18         | docs/RULES.md (this change); the detector upgrade found F-179 (aa4c524) and the R-24 gate found F-181 (3da04ec) | —                                                            |

## Waiting on the owner

- **F-175** — a prices update command is named in the docs, the specs and two
  CLI hints but was never built: retract the references, or build it.
- **F-176** — a target or flag held in a shell variable is judged by its bare
  name: ask on every variable-held target, or keep it a documented limit.
- **F-177** — `resume`, `reconcile` and `unlock` from the agent are allowed,
  and the default ledger is a project file the agent may write: where the
  ledger lives and which policy scope names it.
- **F-180** — per-request server tools (web search, web fetch) are not in the
  spend figure: price them, or keep the declared limit.
- **D1 at merge** — main's checker does not have the F-178 rule (a guard a
  revision supersedes may stop resolving), so the base-checker will fail this
  branch's superseded C-11.1 guard until the stack merges; and PR #19's
  across-names failure is not a pure false positive, because the RC-09
  answers file is in its range.

## Acceptance

The author runs the full UAT first and fixes what it finds; the owner then
accepts. The formal open-source release follows, on the owner's call.
