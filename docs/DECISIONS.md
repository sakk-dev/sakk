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

## D10 — V1 close-out (2026-10-28)

The black-box acceptance run of 2026-10-28
(`findings/reviews/2026-10-28-p0-uat-blackbox.md`) failed 37 of the 151 P0
cases. 17 were features already deferred on 2026-10-27; 20 had been counted
as passed or covered by a test name rather than by their expected result
(F-182).

| Question                                   | Decision                                                                                | Landed in                                                                                     | Left open                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------- |
| Fix the 37 failures in v1, or defer them   | Defer every one to v2. No code changes in v1                                            | findings F-182…F-201; stop-line review `findings/reviews/2026-10-28-v1-closeout-deferrals.md` | The fixes, in docs/V2-BACKLOG.md |
| The security gaps the run found            | Documented as known limits, not fixed                                                   | README "Limits", docs/GUARD.md "Known open in v1", docs/SPEND.md                              | Same                             |
| The class detectors the stop line asks for | Waived for C-02, C-05, C-07, C-08; C-13 corpus and C-15 debt moved to v2 with new dates | `findings/classes.json`; the stop-line review names each v2 detector                          | Same                             |
| What else is in v2                         | Everything still open, in one plan                                                      | docs/V2-BACKLOG.md                                                                            | Order and dates, on the owner    |

The owner's words: "全部放到 V2 吧，全部这一切的全部收尾。其他的都放到 V2
的开发计划里". D8 (v2 scope not set until v1 is complete) is answered by
this: v1 is closed as it stands and docs/V2-BACKLOG.md is the v2 plan.

## Waiting on the owner

The open owner questions — F-175, F-176, F-177, F-180, F-188, F-195 and the
D1 merge caveat — now sit in docs/V2-BACKLOG.md, "Decisions for the owner",
each with what it changes and what either answer costs. The release itself
(push, merge, tag, npm publish) stays the owner's call.

## Acceptance

The author runs the full UAT first and fixes what it finds; the owner then
accepts. The formal open-source release follows, on the owner's call.
