# Spend and the daily cap

Sakk reads what Claude Code already writes on your machine, prices it, and —
once today's spend reaches your cap — stops the agent at its next tool call.

```bash
sakk cap set 40          # dollars per day, in your time zone
sakk spend               # today's spend by model, from local logs
sakk prices              # the price table in use
sakk prices update       # fetch the current list (the only network call)
```

## Where the numbers come from

- **Calls:** Claude Code's transcripts, `~/.claude/projects/**/*.jsonl`
  (or `$CLAUDE_CONFIG_DIR/projects`). The folder is fixed when you run
  `sakk cap set`, so an agent's environment cannot point it elsewhere.
- **Prices:** a snapshot of LiteLLM's model list ships with Sakk
  (`prices/snapshot.json`, MIT). `sakk prices update` writes a newer one to
  `~/.sakk/prices.json`; the package itself is never edited.
- Each call is counted once, at its largest recorded usage. Cache writes are
  priced per their duration, and past a model's long-context threshold the
  whole request is priced at the higher rate.

The figures are an estimate from local logs, not your provider's invoice.
Your provider's own spend limits remain the backstop.

## When the cap is reached

Every tool call is denied with `SPEND_CAP_REACHED` until midnight in your
time zone, or until a person raises the cap with `sakk cap set`. A command
that names a file in `~/.sakk/` is denied by the guard, so the agent cannot
change the cap that way. A path held in a shell variable
(`f=~/.sakk/config.json; rm $f`) is not caught yet.

The cap applies at the **next** tool call. A response already in progress
completes, so a running agent can go over by one response.

Spend never goes down: deleting or rewriting a log keeps what was already
counted.

## When Sakk denies because it cannot be sure

- `PRICE_UNKNOWN`: a call today used a model the table does not list. Run
  `sakk prices update`, or add the model to `~/.sakk/prices.json`.
- `SPEND_UNREADABLE`: a log line today could not be read.

Both deny only when a cap is set: spend that cannot be priced cannot be
shown to be under it.

## Not covered

Cursor keeps no local token log. Codex logs are read in a later release.
