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

## D11 — V2 fixes go-ahead (2026-10-29)

The owner lifted the D10 code freeze for this batch ("好了，那个全部开工按推荐",
2026-10-29 10:11 +0400) and took every recommended answer on the open
decisions. Work lands on `oss/v2-fixes`, detector-first: each class that
re-triggers its stop line gets its detector (red first, then green) before
the fix.

| Question | Decision | Lands in |
| --- | --- | --- |
| F-176 — unresolved expansion in a command | Always "ask": an expansion the guard cannot resolve is never judged safe | line A (canonicalization) |
| F-177 — what the agent may never do | The agent never lifts a halt, reconciles, or unlocks; the default ledger moves under `~/.sakk` | line C (spend/ledger) |
| F-188 — agent edits its own hook config | Deny outright, not ask | line B (hook entry + protected zone) |
| F-195 — console checks Origin | On GET as well as Stop | line D (console) |
| F-175 — `sakk prices update` | Retract the command and remove it from docs | line D (docs) |
| F-111 — version and CHANGELOG | Version is 0.1.0; cut CHANGELOG from [Unreleased]; a release test ties version, CHANGELOG and tag together | line D (release) |
| README features not built (P-ACC-001/002/004/012, P-INS-004) | Build what fits the window; mark the rest 未发布 in the README | line D (docs) |

The seven unfiled UAT escapes (K-INS-026, K-SEC-049/050/051, S-REL-005,
S-REL-002 follow-on, R-REL-015) are filed as F-202… under this decision.
The release itself (push to main, tag, npm publish) stays the owner's call.

## Waiting on the owner

F-175, F-176, F-177, F-188 and F-195 were answered by D11 above. Still
open: F-180, the D1 merge caveat, and the release itself (push, merge,
tag, npm publish), which stays the owner's call.

## Acceptance

The author runs the full UAT first and fixes what it finds; the owner then
accepts. The formal open-source release follows, on the owner's call.
