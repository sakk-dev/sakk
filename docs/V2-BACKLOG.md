# V2 backlog

On 2026-10-28 the owner closed v1 as it stands and moved everything still
open to v2 (docs/DECISIONS.md D10). This file is the v2 work list: every
open finding, every P0 case that did not pass, the class detectors the stop
line asks for, and the questions only the owner can answer.

Sources: `findings/ledger.json` (the findings),
`findings/reviews/2026-10-28-p0-uat-blackbox.md` (the cases),
`findings/reviews/2026-10-28-v1-closeout-deferrals.md` (the detectors).

**Status 2026-10-29 (`oss/v2-fixes`, owner decision D11):** the owner
answered the open questions and this batch landed the fixes — F-176
(always ask), F-177 (deny + ledger under `~/.sakk`), F-188 (deny), F-195
(Origin on every route), F-175 (retracted), F-111 (0.1.0 cut), F-199
(NOTICE), plus the review findings F-204…F-209. The tables below are kept
as written for traceability; `findings/ledger.json` is current for each
finding's state, and docs/DECISIONS.md D11 records the answers. F-210 is
open on the owner.

## When an item is done

- Its P0 case's **expected result is observed** in a run of the case's own
  steps, recorded with the command, exit code and output. A test with a
  matching name is not a pass (F-182).
- Its sweep is done: every sibling the finding names is checked the same
  way.
- The class detector named for it in the stop-line review lands in the same
  change, so the next instance turns a test red.
- The limit text it adds to README, docs/GUARD.md or docs/SPEND.md in v1 is
  removed or corrected in the same change.

## Before any release

These two block an npm publish. Nothing else here does.

| Finding | What is wrong                                                                                                | Fix                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| F-199   | The package ships code derived from MIT projects (gitleaks rules, LiteLLM prices) without notices            | Add `NOTICE` with both MIT texts and the cc-safety-net attribution, list it in `files`, and a release test that every ported source has one |
| F-111   | Version, CHANGELOG and tag do not describe the artifact that would be published (cases A-ACC-014, P-ACC-015) | The owner picks the version and tag; then CHANGELOG is cut from [Unreleased] and a release test checks the three agree                      |

## Decisions for the owner

| Item        | Question                                                                                          | Options and what each costs                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-188       | Writes to the agent's own hook config: deny or ask?                                               | Deny matches the requirement and stops an agent rewriting its guard, but `sakk guard install` run by the agent then fails too. Ask keeps that working and leaves a person in the loop |
| F-195       | Should the console check Origin on GET as well as on Stop?                                        | Yes adds a second check to every read beside the token, at the cost of a rule for requests that carry no Origin (a typed URL, curl). No keeps reads guarded by the token alone        |
| F-175       | `sakk prices update`: build it or retract it?                                                     | Build: one network call, a fetched table validated like the snapshot. Retract: edit two runtime hints, three spec files and CHANGELOG; operators keep the hand-copy route             |
| F-176       | A target or flag held in a shell variable                                                         | Ask on every unresolved variable or brace (fails closed; more asks on ordinary commands such as `rm -rf $TMPDIR/x`), or keep it a documented limit like D5                            |
| F-177       | `resume`, `reconcile`, `unlock` from an agent, and where the default ledger lives                 | Deny them from the agent (as `cap` is) and move the ledger under `~/.sakk`, or give the ledger its own guard-state scope. Either way one agent can no longer lift another's halt      |
| F-180       | Server tools (web search, web fetch) priced per request                                           | Add a request-price field to the table and snapshot, or keep the declared limit                                                                                                       |
| F-124       | A new project's empty ledger requires no answers                                                  | Fall back to a starter set of classes below a threshold of own findings, or leave day one unguarded                                                                                   |
| F-116       | A red CI does not block a merge                                                                   | GitHub Pro for branch protection on the private repository, or protection once it is public                                                                                           |
| F-76, F-90  | Gold v2 changes the frozen scorer                                                                 | Approve the scorer change (baseline sha and file snapshot at case prep; REAL-mode cases that refuse a forged log), or keep the disclosed limits                                       |
| F-106       | Allow-default policies over MCP                                                                   | Require declared fields when a policy is loaded, or refuse allow-default policies over MCP                                                                                            |
| F-125       | The ledger books the cost the caller states                                                       | The proposed design: a versioned price table, reserve from model and max tokens, settle from provider usage                                                                           |
| D1 at merge | main's checker lacks the F-178 rule, so the base-checker fails this branch until the stack merges | Rebuild history, or land the documented one-time base-checker exception. PR #19's across-names failure is not a pure false positive (the RC-09 answers file is in its range)          |
| Order       | Which group goes first and by when                                                                | A suggested order is at the end of this file                                                                                                                                          |

## Work by component

### Guard — how names are read

All in `src/classify.mjs`, `src/match.mjs`, `src/policy.mjs`.

| Finding | Cases                             | Fix                                                                                                                    | Sweep                                                              |
| ------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| F-183   | G-SEC-003, 004, 006, 007, 008     | On a case-insensitive volume, fold case (or ask on a case variant) for program names and every scope rule              | Drive each protected-name rule with a case variant                 |
| F-184   | G-SEC-005, J-UAT-015              | Parse git options as git does (short clusters, unique long prefixes); ask on any inline alias definition               | Every flag-keyed git and shell rule, same forms                    |
| F-185   | J-UAT-016                         | Resolve launchers (`npx`, `npm exec`, `node` with a script path, a direct path to `bin/sakk.mjs`) before the R-24 gate | Each R-24 subcommand through each launcher                         |
| F-186   | K-SEC-044                         | Resolve the final path component before every secret and scope rule (read, write, delete)                              | Each rule with a link to a protected target                        |
| F-176   | G-SEC-001, 002, 029 (known open)  | After the owner's answer above                                                                                         | Every target-keyed rule for the same variable and brace blind spot |
| D5      | K-SEC-043, 045 (documented limit) | Stays a limit unless the F-176 answer is "ask"; run-time interception belongs to the layer that sees it                | —                                                                  |

Class detector (C-08): a spelling-variant table test that feeds each rule
its name in every form the OS or the program accepts, and a type-fuzz of
the hook's fields.

### Guard — install and reach

| Finding | Cases                | Fix                                                                                                                       | Sweep                                                      |
| ------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| F-189   | G-INS-008, G-SEC-012 | Match every file-reading tool (Grep, Glob) and classify its path and glob inputs; write the REQ-G04 deny rules at install | Test the matcher against Claude Code's tool list           |
| F-187   | J-UAT-017            | Record the installed package root at install and protect it like guard state, or refuse a project-local install           | Run the install tests in a project-local layout            |
| F-188   | G-SEC-011            | After the owner's answer; add the user-level agent config to the rule                                                     | Map each REQ-G line to the rule and the test that keep it  |
| F-190   | R-REL-001            | Scan the serialised form of non-string content, or deny it with a code                                                    | Every field the hook scans, same type test                 |
| F-196   | P-INS-001            | `init` runs `guard install`, or says it did not and prints the next command                                               | Check every "done" message against the state it claims     |
| F-177   | —                    | After the owner's answer                                                                                                  | Every path that writes the ledger (CLI, MCP gate, console) |

Class detectors: an inventory test of tools and fields (C-02); for F-187, a
tamper test that edits the installed package and expects a deny.

### Spend and ledger

| Finding | Cases                             | Fix                                                                                                                                                                                                                                  | Sweep                                                                |
| ------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| F-191   | S-SEC-010                         | Record the absolute log folder at `cap set` and read only that; ask or refuse when the environment points elsewhere                                                                                                                  | Correct docs/SPEND.md in the same change                             |
| —       | D12 (2026-10-29)                  | Local proxy + key custody: stand inside the API call path instead of reading the agent's own logs, closing the C-07 family (F-191/205/210/211) at the architecture level — spend observed at egress, keys never in the agent's hands | Owner ruling D12 sent the proxy direction to v2; design before build |
| F-192   | S-REL-001                         | Isolate each log read: skip and report an unreadable file with a code, the cap fails closed under it; a distinct hook code per failing step                                                                                          | Every step of the hook that can fail                                 |
| F-193   | L-REL-013                         | Bind the summary to the chain head and refuse `reserve` on a mismatch                                                                                                                                                                | Every cached total the cap reads                                     |
| F-175   | A-ACC-013, P-ACC-006 (known open) | After the owner's answer; the two runtime hints in `src/spend.mjs` and `src/console.mjs` still name the command                                                                                                                      | Specs and CHANGELOG                                                  |
| F-180   | —                                 | After the owner's answer                                                                                                                                                                                                             | The enumeration test names the two unpriced fields                   |
| F-125   | —                                 | After the owner's answer                                                                                                                                                                                                             | MCP gate and CLI                                                     |
| F-49    | —                                 | `unlock` refuses a live holder unless forced twice                                                                                                                                                                                   | —                                                                    |
| F-104   | —                                 | Owner encoded in the lock directory name, release by rename-then-remove (a lock-protocol change for review)                                                                                                                          | —                                                                    |
| F-114   | —                                 | Ledger and release nits listed in the finding                                                                                                                                                                                        | —                                                                    |

Class detector (C-07): a tamper test per trusted input (the environment, the
summary, the caller's cost) that changes it and expects the figure to hold.
For F-192 (C-14): an EACCES fixture in the spend tests.

### Console (`sakk ui`)

| Finding | Cases                           | Fix                                                                                                                                  | Sweep                                                       |
| ------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| F-194   | A-ACC-023, U-SEC-016, U-SEC-017 | Redact every string field before a decision is written (log, API, page, export); record the fingerprint; print the dispute line once | Drive each field with a secret                              |
| F-195   | A-ACC-010, U-SEC-021, U-SEC-022 | A spend read without index writes; `no-store` and a real CSP on every response; Origin on GET after the owner's answer               | A test that snapshots the state tree around every GET route |
| F-201   | U-FN-011                        | Send the token the page already holds; handle non-200 replies                                                                        | A browser run of the Stop button (gold v2)                  |

### Secret scanning

| Item        | Cases     | Fix                                                                                                                                                                                            |
| ----------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-13 corpus | K-ACC-069 | The per-rule recall corpus: 125 of the 192 enabled rules have precision only. Reimplement or hand-curate gitleaks' Go-generated samples, one true and one false per rule, each with its source |
| F-75        | —         | A benign corpus (i18n JSON, Ansible, `.env.example`) as a precision row; tune `password_assignment` against both lists                                                                         |
| F-122       | —         | Drop an overlapping hit with the same fingerprint, so one secret under two rules is one finding                                                                                                |

Class detector (C-13): one run of every detection rule set (secret patterns,
answer rules, the shell classifier) over a benign corpus and a planted
corpus, asserting both rates.

### Package and README

| Finding   | Cases                | Fix                                                                                                                                                              |
| --------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-198     | K-ACC-068, P-ACC-005 | Generate or test every count in README and spec from the rules file; label each roadmap item by where it ships (the v1 text was corrected by hand on 2026-10-28) |
| F-197     | P-INS-009            | Ship a marketplace file so `/plugin install` works; put every README shell line on the manual release check (the v1 line was corrected to `--plugin-dir`)        |
| F-200     | A-ACC-006            | Collect refusal codes from every source form (or a code registry); write the four missing tests                                                                  |
| Not built | P-ACC-001            | README top: one install line, a GIF of a home-folder delete denied, a console screenshot                                                                         |
| Not built | P-ACC-002            | README numbers, each with a reachable source and a dated archive                                                                                                 |
| Not built | P-ACC-004            | README ends with an "Enterprise: coming soon" section, no feature promise or price                                                                               |
| Not built | P-ACC-012            | Pack-time check: a stray file in `src/` or `bin/` fails the release, and a secret scan of the packed files                                                       |
| Not built | P-INS-004            | Node below 20 is refused at start with a clear message and nothing written                                                                                       |

Class detector (C-05): a docs-claims test that runs each claim's command and
compares the output, with acceptance by expected result only; for F-199
(C-10), a pack-time NOTICE test; for F-200 (C-03), parse the source instead
of matching a regex.

### Eval harness and gold v2

Due 2026-11-30 (the C-15 stop-line debt).

| Finding | Fix                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------- |
| F-90    | REAL-mode cases that can pass honestly and refuse a forged test log; G09 refuses a hand-made artifact      |
| F-76    | The scorer reads a baseline sha and a file snapshot taken at case prep, not the agent-writable `.git`      |
| F-112   | The gold harness nits listed in the finding                                                                |
| F-50    | Bundle `eval/packs/<id>.json` from the harness commit and recompute meaning, clause status and not-covered |
| F-113   | A ten-line reference `decide()` as the policy fuzz's oracle, plus generated absent and present fields      |
| F-201   | The browser run of the Stop button above lands here                                                        |

### Self-evolution kit and process

| Finding | Fix                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-182   | The acceptance template requires an observed run per case; done once for all 151 P0 cases on 2026-10-28                                                          |
| F-123   | Split the hooks into the portable gate and project steps read from `package.json`; an init command that lays the kit into a project; trial in a fresh repository |
| F-124   | After the owner's answer                                                                                                                                         |

### Case packs

| Finding | Fix                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-127   | Re-anchor the CBUAE pack on the binding regulations, with the guidance note as supervisory expectation; check the DIFC and DORA packs the same way; a local law firm signs off before any external use |

## Owner runs

These need a newer Claude Code, the network or a real old Node, none of
which the acceptance machine had. Each is a few minutes.

| Case      | Steps                                                                                                                                                                                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-INS-008 | On Claude Code 2.1.295 or later with a throwaway `CLAUDE_CONFIG_DIR`: add a marketplace that lists sakk, `/plugin install sakk`, check `/plugin` shows sakk 0.1.0, ask the agent to delete the home folder (expect a deny and a decision line with agent `claude-code`), `/plugin uninstall sakk`, run `ls`, expect no new line |
| P-INS-010 | Same setup, plugin installed. Break the hook three ways — rename `bin/sakk.mjs` in the plugin cache; make `node` sleep 15 s; make it exit 1 — and each time run `echo hi`: it must be blocked with a hook-failure message                                                                                                       |
| P-INS-011 | Same setup: run `ls`, confirm a new decision line with agent `claude-code`, then confirm a home-folder delete is denied                                                                                                                                                                                                         |
| P-ACC-009 | Fetch dcg's rule list and diff its patterns against `policies/` and the guard rules; only the exclusion note in `specs/guard/decide.md` may mention it. The text check already passes                                                                                                                                           |
| P-INS-004 | With a real Node 18 (simulated so far): `sakk init` must exit non-zero, say Node 20 or later is needed, and write nothing                                                                                                                                                                                                       |

## 2026-10-29 review notes (non-blocking)

From the independent adversarial review of the money diff (CONSTITUTION
#4). Its three blockers became F-208 and F-209 (fixed) and F-210 (open,
owner ruling — see docs/DECISIONS.md). These notes stayed non-blocking:

| Note                                                                                                                                                                                                                    | Why it can wait                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A resume/reconcile/unlock run inside a constructed PTY classifies as shell.constructed and is denied outright; the second layer (the command's own TTY confirmation) already holds, so "ask" may fit better than "deny" | Fail-closed today; loosening is a product choice                                                                 |
| `LEDGER_PATH_LEGACY` refuses `sakk halt` and `sakk init` too, which sits oddly beside "engaging the brake is never blocked"                                                                                             | The refusal is loud and typed; the operator can re-point the path                                                |
| `SPEND_INDEX_UNREADABLE` reports and exits 0 while `SPEND_LOGS_UNLISTABLE` exits 1 — two failed-reading shapes, two severities                                                                                          | Both deny the cap check (fail closed); only the CLI exit codes differ, and exit codes are public API (CHANGELOG) |

## Suggested order

The owner sets the order and dates (D10). A suggestion:

1. **Release blockers and decisions.** F-199, F-111, and the owner's answers
   above, since five fixes wait on them.
2. **Guard reach.** F-183, F-184, F-185, F-186, F-187, F-189: the gaps an
   agent can use today.
3. **Spend, ledger, console.** F-191, F-192, F-193, F-194, F-195, F-201.
4. **Gold v2 and the C-13 corpus,** by 2026-11-30.
5. **README and package features.** P-ACC-001, 002, 004, 012, P-INS-004.
