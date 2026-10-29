# Spend from local logs, with a daily cap (open-source v1, M2) — spec + three tables

Blueprint: open-source v1, headline 2 ("a spend cap"). Target design: the
v10 console, Overview ("today's spend / daily cap, read from local logs")
and Model prices. It is a money area: three tables, a contract before code,
and independent adversarial review before merge (CONSTITUTION #3, #4).

## What it is

Sakk reads what Claude Code already writes on the machine and prices it.
The guard hook then stops the agent once today's spend reaches the cap:
"ccusage tells you; Sakk stops you".

| Command                                  | What it does                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `sakk spend [--day YYYY-MM-DD] [--json]` | Today's (or that day's) spend by model, session and project, with the count of unpriced calls       |
| `sakk cap set <usd>` / `sakk cap off`    | Sets the daily cap in `$SAKK_HOME/config.json`                                                      |
| `sakk prices` / `sakk prices update`     | Shows the price table in use; updating it fetches the current upstream list (the only network call) |

## Source: Claude Code's logs

- **Where.** `$CLAUDE_CONFIG_DIR/projects/**/*.jsonl`, or
  `~/.claude/projects/**/*.jsonl` when that variable is unset. This
  includes subagent transcripts.
- **What counts.** Lines with `type: "assistant"` that carry
  `message.usage`, `message.model`, `message.id`, `requestId` and
  `timestamp`.
- **One call, many lines.** A streamed response is written several times
  with growing usage. Lines are grouped by `(message.id, requestId)`, and
  each field takes the maximum. A line with neither id is counted alone and
  flagged `UNKEYED`.
- **Volume.** Measured on 2026-10-21: 1.6 GB of history on the owner's
  machine. Reading is therefore incremental. The index under
  `$SAKK_HOME/spend/` keeps, per file:
  - the byte offset read so far;
  - size, mtime and inode;
  - a hash of the first 4 KiB, which detects a rewritten file.
- **Hook budget.** A hook check reads only files changed since the last
  check, and only those touched today.
- **Lag.** A response is written after it completes, so the call in flight
  is not yet in the log. The cap therefore applies at the **next** tool
  call (decision 5, 2026-10-21). The overshoot is bounded by one response
  per running agent (ceiling 1).

Cursor keeps no local token log, so it has no spend in v1. Codex writes
token counts under `~/.codex/sessions/`; reading them is v1.1, behind the
same index (spec addendum then).

## Price

`cost = Σ tokens(kind) × price(model, kind) × multipliers`. The token
kinds are:

- input;
- output;
- cache write, 5-minute and 1-hour (`usage.cache_creation.ephemeral_5m/1h_input_tokens`;
  without the breakdown, all cache writes count at the 5-minute price). The
  breakdown refines the price of the aggregate `cache_creation_input_tokens`,
  never lowers it: the 1-hour part is billed at its price and the larger of
  the 5-minute part and the aggregate minus the 1-hour part at the 5-minute
  price, and those tokens are what count toward long context (F-168, F-179);
- cache read.

Request-priced server tools (`usage.server_tool_use`, e.g. web search) are
not priced in v1 and the cap does not count them; docs/SPEND.md says so
(F-180, open).

| Rule                                                                                                                             | Source                                                    |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Each kind has its own per-model price; cache read is not a fixed fraction                                                        | LiteLLM `model_prices_and_context_window.json` (MIT)      |
| A 1-hour cache write costs 2× the input price; a 5-minute one 1.25×                                                              | Anthropic pricing page, 2026-10-21                        |
| Long context: past a model's threshold, the **whole request** bills at the higher rate (e.g. Haiku 5.5 above 100k prompt tokens) | Anthropic pricing page; LiteLLM `*_above_*_tokens` fields |
| Fast mode and US-only inference carry multipliers, read from `usage.service_tier` / `speed` / `inference_geo` when present       | Anthropic pricing page                                    |

**Snapshot.** The package ships `prices/snapshot.json`: LiteLLM's list
trimmed to the providers coding agents use. It records:

- `source` (URL and commit);
- `fetchedAt`;
- the sha-256 of the upstream file;
- the licence notice.

It stays under 256 KiB, the plugin-directory file limit.
`sakk prices update` writes `$SAKK_HOME/prices.json`. It validates the
schema, shows the diff and never edits the package. Owner decision 4,
2026-10-21: a bundled snapshot plus a manual update, never a silent fetch.

**Unknown model** (not in the table): the call is counted as **unpriced**.
With a cap set, any unpriced call today makes the cap check **deny**
(`PRICE_UNKNOWN <model>`), because spend that cannot be priced cannot be
shown to be under the cap. The reason names the two ways out:
`sakk prices update`, or a `sakk prices add` row. This matches v10:
"calls to an unlisted model are refused, not guessed".

## Cap

- **Day.** The day runs in the time zone in `config.json`, or the system
  zone if none is set. The first and last minute of the day are both
  tested.
- **Check.** The guard hook's step 2 compares today's spend with the cap.
  At or over the cap, every tool call is denied:
  `SPEND_CAP_REACHED $41.20 ≥ $40.00 (day 2026-10-21, Asia/Dubai)`. The
  reason names `sakk cap set` and the reset time.
- **Edits.** A cap edit by the agent is a `file.write` to `$SAKK_HOME`,
  which the classifier scopes as `~sakk/`. The shipped guard policy denies
  it (`protect-guard-state`). A person changes the cap with `sakk cap set`.
- **Fail closed.** If the cap cannot be checked (index unreadable, a log
  file rewritten mid-read, the 2 s deadline), the answer is deny with the
  code.

## Spend never goes down

A log that shrinks, or whose first 4 KiB changes, is **rewritten**:
`LOG_REWRITTEN`, recorded in the decision log and shown in the console.

- Spend already counted from that file stays counted.
- The file is re-read from the start, and any call not seen before is
  added.

Deleting a log therefore cannot lower today's spend (ceiling 2).

## Adversary table

The adversary is the agent, or a prompt-injected agent, that wants to keep
spending.

| #   | Move                                                    | Must-hold outcome                                                                                                                                                           | Guard test                                                                         |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Delete or truncate today's transcript                   | counted spend stays; `LOG_REWRITTEN` logged                                                                                                                                 | `test/spend.test.mjs::a deleted or truncated log never lowers spend`               |
| 2   | Rewrite usage numbers in place to smaller values        | the head-hash or size check marks it rewritten; the counted maximum stays                                                                                                   | `test/spend.test.mjs::usage rewritten in place keeps the counted maximum`          |
| 3   | Duplicate lines to confuse dedupe, or vary `requestId`  | grouping by `(message.id, requestId)` takes the maximum per field; a new pair is a new call, so spend can only go up                                                        | `test/spend.test.mjs::streamed and duplicated lines count once, at their maximum`  |
| 4   | Use a model missing from the table                      | unpriced, so the cap check denies `PRICE_UNKNOWN`                                                                                                                           | `test/spend.test.mjs::an unpriced call with a cap set is a deny`                   |
| 5   | Raise the cap by editing `config.json`                  | `file.write` under `$SAKK_HOME` is denied by the shipped policy                                                                                                             | `test/spend.test.mjs::the agent cannot write the cap`                              |
| 6   | Edit `prices.json` to make a model free                 | same rule; and `sakk prices` prints the table's hash against the snapshot's                                                                                                 | `test/spend.test.mjs::the agent cannot write the price table`                      |
| 7   | Point `CLAUDE_CONFIG_DIR` at an empty folder            | the hook reads the folder Sakk was configured with at `cap set`, not the agent's environment                                                                                | `test/spend.test.mjs::the log folder is fixed at cap set, not read from the agent` |
| 8   | Run past midnight to reset                              | intended: the day resets; the time zone is fixed in config                                                                                                                  | `test/spend.test.mjs::the day boundary follows the configured zone`                |
| 9   | Huge or hostile log lines (100 MB line, deep JSON, NaN) | lines over 1 MiB are skipped and counted as `UNREADABLE`; numbers must be finite and non-negative or the line is unreadable; unreadable lines today make the cap check deny | `test/spend.test.mjs::hostile lines are bounded and fail closed`                   |
| 10  | Many agents in parallel                                 | each check reads the shared index under the ledger's lock discipline; spend is the sum of all sessions                                                                      | `test/spend.test.mjs::parallel sessions are summed`                                |

## Input-space table

| Input       | Classes covered                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Log folder  | Absent (spend 0, stated "no logs found at <path>"); empty; unreadable file; unlistable directory (typed `SPEND_LOGS_UNLISTABLE`, the cap fails closed — F-204); symlinks (not followed out of the folder); subagent folders; 10,000 files                                                                                                                                |
| Log line    | Assistant with usage; without usage; user/system/summary lines; partial last line (not read until complete); over 1 MiB; non-JSON; missing ids; unknown fields                                                                                                                                                                                                           |
| Usage       | All kinds present; cache breakdown absent, empty, partial or larger than the aggregate; zeros; in every count and both breakdown fields, negative / fractional / Infinity / strings / booleans / objects (→ unreadable), null (→ absent); a breakdown that is not an object (→ unreadable); huge but finite — enumerated by `test/spend.test.mjs::the usage input space` |
| Model       | Priced; unpriced; an alias (resolved through LiteLLM's names only, never guessed); a date-suffixed id                                                                                                                                                                                                                                                                    |
| Price table | Shipped snapshot; user override; malformed override (→ refuse, never fall back silently); override missing a model                                                                                                                                                                                                                                                       |
| Time        | Day boundaries in UTC, Dubai and a DST zone; a line timestamp in the future (counted today, flagged); a clock change mid-day                                                                                                                                                                                                                                             |
| Cap         | Unset (no check, and the console says so); 0; fractional; the exact boundary (at the cap = reached)                                                                                                                                                                                                                                                                      |

## Evidence-source declaration

| Claim                  | Source                                                      | Strength                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Today's spend is $X"  | Claude Code's local transcripts, priced by the table in use | The agent's own tool wrote them, and an agent with shell access can edit them. Sakk keeps the maximum ever counted. The console labels it "from local logs", never "billed". |
| "The price of model M" | snapshot or user table, with its hash                       | Upstream list as of `fetchedAt`; not the invoice                                                                                                                             |
| "The cap stopped it"   | the guard hook's deny line in the decision log              | Strong for calls that reached the hook                                                                                                                                       |

## Ceilings (stated, not hidden)

1. **Overshoot.** The cap applies at the next tool call. One response per
   running agent can land after the cap was reached, and an agent that
   stops calling tools is not stopped mid-response.
2. **Logs as evidence.** Logs are evidence, not an invoice. A determined
   agent can keep spend from being recorded by disabling transcripts.
   Sakk shows the spend it saw. Provider-side spend limits remain the
   backstop, and the docs say so.
3. **Coverage.** v1 counts Claude Code only.

## History pitfalls (findings/classes.json)

| Class                                   | Where it bites here                     | How this design avoids it                                                                               |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| C-01 Absence read as success            | missing logs, prices, usage fields, cap | each absent row states its answer; unpriced and unreadable deny under a cap                             |
| C-04 Unbounded or clock-judged cost     | 1.6 GB of history inside a 2 s hook     | incremental index, today-only files, a line size bound; tests bound inputs, never assert a stopwatch    |
| C-05 A statement the code does not keep | "the cap stops spending"                | the console and docs say "at the next tool call" and show the overshoot ceiling                         |
| C-06 Weak evidence presented as strong  | logs shown as billing                   | the "from local logs" label; maximum-ever counting                                                      |
| C-07 Untrusted input trusted            | log lines written by the agent's tool   | bounded, typed, finite numbers only; nothing from a line is executed or used as a path                  |
| C-08 One thing, two names               | model aliases, date-suffixed ids        | names resolved only through the price table's own aliases                                               |
| C-11 A value outliving its scope        | the day boundary, a cached total        | totals are recomputed per day from the index; the zone is fixed in config                               |
| C-14 Failure not isolated               | one bad file                            | per-file errors are counted and shown; under a cap they deny, otherwise they never stop the other files |
