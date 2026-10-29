# P0 black-box UAT — 2026-10-28 at 8edbc8e

The owner asked for acceptance by each case's expected result, run by me
before it reaches them. The 2026-10-27 report did not do that: it counted
a case as passed when a test with a matching name existed (F-182). This
run re-checked all 151 P0 cases against their written expectations.

## Method

- Code under test: commit 8edbc8e (branch oss/p0-uat-backfill), the
  packed tarball and the repo tree.
- Every `sakk` run went through a sandbox wrapper with a throwaway HOME,
  CLAUDE_CONFIG_DIR and project folder. No run touched the real home
  folder, real agent logs or real keys.
- Each case: set up its preconditions, run its steps, compare what was
  observed with its expected result. A case passes only on a match.
  "A test exists" is not a pass.
- Cases that need a newer Claude Code than this machine has, the network,
  or an owner action are marked MANUAL with the exact owner steps.
- Guard-bypass cases are recorded at category level here; the exact
  inputs are in the private UAT working folder, not in the repo.

## Totals

| Verdict                                       | Count   |
| --------------------------------------------- | ------- |
| PASS                                          | 102     |
| FAIL                                          | 37      |
| KNOWN-OPEN (an open finding already names it) | 5       |
| MANUAL (owner run needed)                     | 5       |
| LIMIT (documented limit, D5)                  | 2       |
| **Total**                                     | **151** |

Of the 37 failures, 17 were features the owner deferred to V2 on
2026-10-27 ("not built" in the 10-27 report), so their failure was
expected. The other 20 were reported on 10-27 as passed or covered and do
not meet their expected result; that gap is F-182.

On 2026-10-28 the owner deferred every failure to V2 (docs/DECISIONS.md
D10). Findings F-183…F-201 record them; the stop-line review is
`findings/reviews/2026-10-28-v1-closeout-deferrals.md`; the work list is
docs/V2-BACKLOG.md.

## Every case that did not pass

"10-27" is what the 2026-10-27 report said. "covered" means the 10-27
report counted it as covered without a runnable check.

| Case      | What it checks                                           | 10-27     | 10-28      | Goes to    |
| --------- | -------------------------------------------------------- | --------- | ---------- | ---------- |
| A-ACC-006 | every deny reason code has an attack test                | pass      | FAIL       | F-200      |
| A-ACC-010 | console rejects bad Host/Origin/token on every route     | pass      | FAIL       | F-195      |
| A-ACC-014 | no open finding blocks the release                       | pass      | FAIL       | F-111      |
| A-ACC-023 | secrets stored only as fingerprints, never shown         | pass      | FAIL       | F-194      |
| G-INS-008 | install adds deny-read rules for secret files            | not built | FAIL       | F-189      |
| G-SEC-003 | home-folder delete with the command name in another case | not built | FAIL       | F-183      |
| G-SEC-004 | force push with the program name in another case         | not built | FAIL       | F-183      |
| G-SEC-005 | force push hidden behind an inline git alias             | not built | FAIL       | F-184      |
| G-SEC-006 | guard policy edited through a case variant of its folder | not built | FAIL       | F-183      |
| G-SEC-007 | agent hook config edited through a case variant          | not built | FAIL       | F-183      |
| G-SEC-008 | CI workflow written through a case variant               | not built | FAIL       | F-183      |
| G-SEC-011 | a write to the agent's own settings is denied            | pass      | FAIL       | F-188      |
| G-SEC-012 | the search tool cannot read .env past the hook           | not built | FAIL       | F-189      |
| J-UAT-015 | force push or rewrite of main is stopped                 | pass      | FAIL       | F-184      |
| J-UAT-016 | the agent cannot switch Sakk off                         | covered   | FAIL       | F-185      |
| J-UAT-017 | the agent cannot change Sakk's own policy                | pass      | FAIL       | F-187      |
| K-ACC-068 | secret-rule counts agree across docs and code            | covered   | FAIL       | F-198      |
| K-SEC-044 | a read through a symlink to .env is stopped              | not built | FAIL       | F-186      |
| L-REL-013 | a damaged summary never frees cap room                   | covered   | FAIL       | F-193      |
| P-ACC-001 | README top: install line, delete GIF, console shot       | not built | FAIL       | V2 feature |
| P-ACC-002 | README numbers carry sources that match                  | not built | FAIL       | V2 feature |
| P-ACC-004 | README ends with "Enterprise: coming soon"               | not built | FAIL       | V2 feature |
| P-ACC-005 | package has no enterprise code; README claims none       | covered   | FAIL       | F-198      |
| P-ACC-008 | third-party licence notices are complete                 | covered   | FAIL       | F-199      |
| P-ACC-012 | stray files in src/ or bin/ are stopped at pack time     | not built | FAIL       | V2 feature |
| P-ACC-015 | version, CHANGELOG, tag and npm agree                    | pass      | FAIL       | F-111      |
| P-INS-001 | `npx sakk init` sets up ledger and guard                 | covered   | FAIL       | F-196      |
| P-INS-004 | Node 18 is refused with a clear message                  | not built | FAIL       | V2 feature |
| P-INS-009 | the README plugin install command works                  | covered   | FAIL       | F-197      |
| R-REL-001 | malformed hook input is denied with a code               | pass      | FAIL       | F-190      |
| S-REL-001 | an unreadable log does not crash spend                   | not built | FAIL       | F-192      |
| S-SEC-010 | a moved log folder cannot zero today's spend             | not built | FAIL       | F-191      |
| U-FN-011  | the console Stop button halts                            | not built | FAIL       | F-201      |
| U-SEC-016 | secrets in logs are masked before display                | covered   | FAIL       | F-194      |
| U-SEC-017 | exports mask secrets too                                 | covered   | FAIL       | F-194      |
| U-SEC-021 | a GET request writes no file                             | covered   | FAIL       | F-195      |
| U-SEC-022 | security response headers are present                    | pass      | FAIL       | F-195      |
| A-ACC-013 | each past problem class has coverage                     | covered   | KNOWN-OPEN | F-175      |
| G-SEC-001 | home-folder delete through a shell variable              | not built | KNOWN-OPEN | F-176      |
| G-SEC-002 | the same, braced variable form                           | not built | KNOWN-OPEN | F-176      |
| G-SEC-029 | disguised deletes (F-153/154 family)                     | pass      | KNOWN-OPEN | F-176      |
| P-ACC-006 | every command named in docs exists                       | pass      | KNOWN-OPEN | F-175      |
| K-SEC-043 | secret read through a glob                               | covered   | LIMIT      | D5         |
| K-SEC-045 | secret read through a variable or brace                  | covered   | LIMIT      | D5         |
| K-ACC-069 | C-13 corpus debt (due 10-28)                             | covered   | MANUAL     | owner      |
| P-ACC-009 | no dcg code or rules in package or repo                  | covered   | MANUAL     | owner      |
| P-INS-008 | `/plugin install` and uninstall                          | covered   | MANUAL     | owner      |
| P-INS-010 | plugin hook onFailure block fails closed                 | covered   | MANUAL     | owner      |
| P-INS-011 | plugin command+args form runs under Claude Code          | covered   | MANUAL     | owner      |

The 102 passing cases: 66 passed on both days, 28 that 10-27 counted as
covered now pass a real run, 3 that 10-27 listed as not built already
behave as expected, and 5 marked pass (approx.) or manual on 10-27 pass now.
