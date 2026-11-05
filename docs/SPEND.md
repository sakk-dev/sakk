# Spend and the daily cap

Sakk reads what Claude Code already writes on your machine, prices it, and —
once today's spend reaches your cap — stops the agent at its next tool call.

```bash
sakk cap set 40          # dollars per day, in your time zone
sakk spend               # today's spend by model, from local logs
sakk prices              # the price table in use
```

There is no fetching updater: an advertised update subcommand was never
built and is retracted (F-175). To price a model the table lacks, copy the
shipped `prices/snapshot.json` to `~/.sakk/prices.json` and add the model
there.

## Where the numbers come from

- **Calls:** Claude Code's transcripts, `~/.claude/projects/**/*.jsonl`
  (or `$CLAUDE_CONFIG_DIR/projects`). In v1 the folder is found from the
  environment each time, not recorded by `sakk cap set`, so an agent run with
  `CLAUDE_CONFIG_DIR` or `HOME` pointed at an empty folder reads $0 and the
  cap never trips (F-191, planned for v2).
- **Prices:** a snapshot of LiteLLM's model list ships with Sakk
  (`prices/snapshot.json`, MIT). When `~/.sakk/prices.json` exists it is
  used instead of the snapshot (a malformed one is refused, never skipped);
  the package itself is never edited.
- Each call is counted once, at its largest recorded usage. Cache writes are
  priced per their duration (writes the log does not break down count at the
  5-minute price), and past a model's long-context threshold the whole
  request is priced at the higher rate.

The figures are an estimate from local logs, not your provider's invoice.
Your provider's own spend limits remain the backstop.

## When the cap is reached

Every tool call the guard sees (see [GUARD.md](GUARD.md) for which tools
each install routes) is denied with `SPEND_CAP_REACHED` until midnight in your
time zone, or until a person raises the cap with `sakk cap set`, which asks
them to retype the new cap at the terminal. The guard denies the agent a
`sakk cap` command and any command that names a file in `~/.sakk/`, so the
agent cannot change the cap either way. A path held in a shell variable
(`f=~/.sakk/config.json; rm $f`) is not caught yet.

The cap applies at the **next** tool call. A response already in progress
completes, so a running agent can go over by one response.

Spend never goes down: deleting or rewriting a log keeps what was already
counted. A call stamped with a future date is counted on the day it is
observed and flagged (`sakk spend` says how many), so a forged timestamp
cannot move spend out of today's cap window (F-205).

The past direction is pinned the same way (F-210). The first whole scan
seals a baseline: history already on disk keeps its claimed day, so a
fresh install never dumps old spend into its first day's cap. After that,
a line first seen today claiming an earlier day is counted today and
flagged `backdated` (`sakk spend` says how many, and a cap deny says so in
its reason) — unless the claimed day's bucket already covers that call's
usage, which is what a legitimately rewritten log looks like. mtime is
never trusted either: a planted file faking an old modification time is
still read (F-211).

## When Sakk denies because it cannot be sure

- `PRICE_UNKNOWN`: a call today used a model the table does not list. Add
  the model to your own table, as above.
- `SPEND_UNREADABLE`: a log line today could not be read.
- `SPEND_LOGS_UNLISTABLE`: a log directory could not be listed (permissions),
  so today's spend cannot be counted. The cap fails closed, and `sakk spend`
  names the directory, until a person fixes the permissions (F-204). The log
  ROOT itself is held to the same rule: an unreadable parent, a dangling
  symlink or a symlink loop at the root is this deny, never an
  honest-looking $0 — only a root that truly does not exist is $0 (F-208).

A single log FILE that cannot be opened (permissions) is the same
`SPEND_LOGS_UNLISTABLE`: `sakk spend` names the file and its error and
exits 1, the other files are still indexed, and the cap stays closed until
a person fixes the file's permissions (F-192). When any other step of the
guard fails, the deny names that step (the spend cap, the kill switch, the
secret scan or the rules) instead of always blaming the rules.

Both deny only when a cap is set: spend that cannot be priced cannot be
shown to be under it.

## Not covered

Cursor keeps no local token log. Codex logs are read in a later release.

The cap counts tokens only. Server-side tools your provider charges per
request, such as web search, are not in the figure, so on a day with many
searches your provider charges more than `sakk spend` shows.
