# Line C (spend / ledger) — three tables for the V2 money-semantics changes

Written before touching `src/spend.mjs` / `bin/sakk.mjs` (CONSTITUTION #3/#4:
money semantics change only behind a written spec the integration side can
adversarially review). Covers F-177 (both cuts), F-204 and F-205. Decided by
D11 (docs/DECISIONS.md, 2026-10-29): "F-177 — The agent never lifts a halt,
reconciles, or unlocks; the default ledger moves under `~/.sakk`", and the
unfiled UAT escapes S-REL-002 (follow-on) and S-REL-005 "filed as F-202…
under this decision".

## Table 1 — current behavior

| # | Surface | Current behavior |
| - | --- | --- |
| 1 | hook judging `sakk resume/reconcile/unlock` | `shell.run` → **allow** (pinned as GAP F-177 in test/kill-switch.test.mjs R-24) |
| 2 | CLI `resume/reconcile/unlock` | any process with a `--by` string succeeds; no person at a terminal needed |
| 3 | default ledger path | CLI fallback is `./sakk-ledger.json` in the agent-writable project cwd (`bin/sakk.mjs ledgerPath()`) |
| 4 | spend: unlistable log directory | `listLogs` swallows `readdirSync` errors (`catch { return; }`), `updateIndex` swallows `statSync` errors → spend reads as absent/$0, `capCheck` **allows** an over-cap agent (UAT S-REL-002: chmod 000 subfolder, cap 0.01, true spend $0.03, hook allowed) |
| 5 | spend: a log line with a future timestamp | booked to `dayOf(line.ts)` — a future day — so it leaves today's cap window entirely (UAT S-REL-005: today $0/0 calls, the spend sits on tomorrow) |

## Table 2 — target behavior

| # | Surface | Target behavior |
| - | --- | --- |
| 1 | hook | `classify` maps `sakk resume|reconcile|unlock` to the guard-state write they make — `file.write` on `SAKK_HOME/sakk-ledger.json` — so `protect-guard-state` **denies** (not ask). `sakk halt` stays allowed (it tightens). |
| 2 | CLI | the loosening path goes through `confirmByPerson` (the F-171/D4 fe936ca pattern): no TTY → `HUMAN_CONFIRMATION_REQUIRED`, exit 2, nothing changed; at a terminal a person retypes the subcommand word. No-op paths do not ask (reconcile "nothing to clear", unlock "no lock present", resume when nothing is halted) — checked by reading first, writing only after the confirmation. |
| 3 | default ledger | CLI fallback becomes `SAKK_HOME/sakk-ledger.json` (via the same D3 single resolution function `resolveLedgerPath`; only the caller-supplied fallback changes). **Migration:** when the fallback would apply and a legacy `./sakk-ledger.json` exists in the cwd, the CLI refuses with typed `LEDGER_PATH_LEGACY` (exit 2) naming both paths — it never silently picks either; the operator passes `--ledger ./sakk-ledger.json` or moves the file. Flag > config > env precedence is unchanged; the hook and console still have no fallback. |
| 4 | spend | `listLogs`/`updateIndex` collect every unlistable directory / unstatable file as `{ path, code }`; `updateIndex` returns `{ rewritten, unreadable, unlistable }`; `capCheck` **denies** with typed `SPEND_LOGS_UNLISTABLE` when `unlistable` is non-empty; `sakk spend` names the paths on stderr and exits 1. An absent `logDir` root stays "no logs, $0" (unchanged spec row); *present but unreadable* is now an error, never $0. |
| 5 | spend | a call whose `ts` is in the future relative to the observing clock is **booked to the observation day** and flagged `future: true`; `daySpend` reports a `future` count; `sakk spend` prints it ("counted today"). The row therefore counts toward today's cap. Re-reading after midnight may re-book a still-future row to the new observation day — conservative double-count, allowed by the "spend never goes down" invariant; spend is never moved out of the current cap window. |

## Table 3 — per-difference justification

| # | Why / decided where |
| - | --- |
| 1 | D11 F-177: "The agent never lifts a halt, reconciles, or unlocks". Deny not ask: an agent must not be able to clear its own constraint by clicking a session approval (same ruling as F-188 "deny outright, not ask"). Mechanism follows F-171/D4 (fe936ca): the hook judges a sakk subcommand as the write it makes. |
| 2 | Same D11 row; CLI side mirrors fe936ca's two layers: the hook stops the guarded agent, `confirmByPerson` stops any other unattended process. No-op-doesn't-ask follows the fe936ca precedent ("guard uninstall checks the plan first"). |
| 3 | D11 F-177: "the default ledger moves under `~/.sakk`". A ledger in the project cwd is a file the agent may write (README limit, F-177 evidence). Under `SAKK_HOME` it falls inside `protect-guard-state`'s deny scope. Refusing on a legacy file instead of guessing: fail closed — silently switching defaults would either strand existing books (halts unread) or keep the agent-writable file authoritative. |
| 4 | specs/spend/spec.md "Fail closed: if the cap cannot be checked … the call is denied". S-REL-002 showed "cannot list" was read as "absent". D11 filed the escape; the fix makes absence-by-error a typed refusal, consistent with `SPEND_UNREADABLE`/`SPEND_INDEX_UNREADABLE`. |
| 5 | specs/spend/spec.md input-space row Time: "a line timestamp in the future (counted today, flagged)" — the spec already ruled it; the code booked by the line's own claim. S-REL-005 showed the agent-authored timestamp (untrusted input) moving spend out of the cap window. D11 filed the escape. |
