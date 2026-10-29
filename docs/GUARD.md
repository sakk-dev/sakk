# The agent guard

Sakk checks every tool call your coding agent makes — Claude Code, Cursor or
Codex — before it runs. Destructive commands are denied, risky ones ask you
first, and everything else runs as before. Each decision is written to a log
you can read and export.

## Start

```bash
npm install -g sakk
sakk guard install claude-code   # or: cursor, codex
sakk doctor                      # checks the hook really fires
```

`install` adds Sakk's hook to the agent's own config in this project
(`.claude/settings.json`, `.cursor/hooks.json`, `.codex/hooks.json`). It keeps
whatever is already there and leaves a backup beside the file. Run it again
and nothing changes; `sakk guard uninstall <agent>` removes only what it added,
after you retype the agent's name to confirm.

Claude Code reads project hooks only for sessions **started in this
folder**. If you start sessions somewhere else, add `--user` to install it in
your home folder instead. `sakk doctor` tells you which applies.

## What it stops by default

The shipped policy (`policies/guard-default.json`):

| Rule                       | What                                                                                      | Answer  |
| -------------------------- | ----------------------------------------------------------------------------------------- | ------- |
| `protect-secret-files`     | reading `.env`, keys and credential files; dumping the environment                        | deny    |
| `shell-destructive`        | `git push --force`, `reset --hard`, deleting `main`, history rewrites                     | deny    |
| `deny-prod-delete`         | `kubectl delete`, `terraform destroy`, dropping tables or databases                       | deny    |
| `deny-rm-outside-repo`     | deleting anything outside the repository (temporary folders excepted)                     | deny    |
| `protect-guard-state`      | writing Sakk's own policy and state                                                       | deny    |
| `protect-ci-files`         | writing `.github/workflows/`                                                              | deny    |
| `protect-migrations`       | deleting database migrations                                                              | deny    |
| `deny-agent-config`        | writing or deleting `.claude/`, `.cursor/`, `.codex/`, project or user level (F-188)      | deny    |
| `high-risk-deploy`         | deploys and publishing                                                                    | ask you |
| `ask-constructed-commands` | commands built at run time (`eval`, `curl … \| sh`, `bash -c "$X"`)                       | ask you |
| `ask-write-outside`        | writing outside the project — your home folder and elsewhere (temporary folders excepted) | ask you |
| `allow-in-repo`            | everything else                                                                           | allow   |

Codex runs a call when a hook asks, so for Codex "ask you" is a deny.

Sakk's own commands are judged by the write they make. From the agent,
`sakk cap …` writes Sakk's state, so it is denied; `sakk guard install` or
`uninstall` writes the agent's config, so it is denied too; and `script`, `expect`
or `unbuffer`, which run a command at a pseudo-terminal and can type into it,
ask you. At the terminal, lifting or raising the cap, moving its day and
removing the guard ask you to retype a word; with no terminal they refuse with
`HUMAN_CONFIRMATION_REQUIRED` (exit 2) and change nothing. Tightening never
asks.

## Try a command

```bash
sakk try "git push --force origin main"
sakk try --read .env
```

`try` runs the same checks as the hook and prints each action, the rule
that decided it and the answer. Nothing runs and nothing is logged.

## Your own rules

Put a policy at `.sakk/policy.json` in the repository; it replaces the
shipped one. The format is `sakk-policy.v1` (docs/ARCHITECTURE.md). The
first rule that matches decides. Actions the guard names:

`file.read`, `file.write`, `file.delete`, `secret.read`, `git.destructive`,
`prod.delete`, `deploy`, `package.install`, `net.download`,
`shell.constructed`, `shell.run`, and `mcp.<server>.<tool>`.

Scopes are paths relative to the repository. Sakk's own state is
`~sakk/…`, your home folder is `~home/…`, and anything else outside the
repository is `~outside/<absolute path>`. A delete that would take the
repository, your home folder or Sakk's state with it (`rm -rf ~`,
`rm -rf .`, `cd .. && rm -rf <project>`) is `~protected/repo`,
`~protected/home` or `~protected/sakk`, and the shipped policy denies it
before any other rule.

## The decision log

Every decision is one line in `~/.sakk/decisions.jsonl` (`SAKK_HOME`
moves it): the time, the agent, the action, the scope, the answer, the rule
and the policy's sha-256. Commands and file contents are not logged; paths
are. The agent name is what the installed config passes — self-declared.

## When Sakk is stopped

`sakk init` records the ledger's absolute path in `~/.sakk/config.json`
(`{"ledgerPath": "…"}`); the hook reads it, then `SAKK_LEDGER_PATH`. Once
someone runs `sakk halt`, every tool call is denied except reading the
repository, until a person runs `sakk resume`. The CLI resolves the ledger
by the same rule, so the halt lands where the hook looks. The guard denies
the agent `sakk init`: run by an agent, it could point the hook at a ledger
the agent writes, and a halt held elsewhere would stop applying.

## When a rule file is broken

A typo in `.sakk/policy.json` does not stop your agent.

- Sakk keeps the last version of your policy that loaded and goes on judging
  with it.
- Every refusal then says your new policy is not in effect, and why.
- `~/.sakk/alerts.jsonl` records it.

If there is no good version to fall back to, or Sakk cannot read its own
config or ledger, the agent can still read the project, and every other call
is refused with the file to fix. Fix the file and the next call is judged
normally.

## What the guard cannot do

- If the agent's own hook timeout fires or the hook process is killed, the
  call runs. Claude Code 2.1.295 and later close this: `install` then adds
  `onFailure: "block"`.
- Calls that never reach a hook are not seen: files you @-mention in Claude
  Code, an agent without the hook installed, you at the terminal.
- The guard reads what a command **says**. A script that deletes your home
  folder runs as `shell.run`. Only isolation (a container) answers what a
  script **does**.
- A name the shell fills in at run time is judged as written. A glob that
  reaches a secret inside the project (`cat .e*`) is allowed; a target or flag
  held in a variable or brace expansion (`f=…; rm $f`, `o=…; git push $o`)
  makes the command constructed, so it is asked, never allowed (F-176). A
  spelled-out secret name is judged wherever it appears in the command — an
  upload reference, a git version-path, a mount or remote-copy spec — and a
  command whose whole purpose is printing a credential, or a read of the
  process-environment file, is a secret read (F-203). A glob that reaches
  outside the project is still refused or asked.
- The confirmation checks for a terminal, not a person: an agent whose shell
  runs in a pseudo-terminal, or a script it writes that opens one, can type
  the word. The guard knows Sakk only by the name `sakk`, so `npx sakk` or
  `node bin/sakk.mjs` meets the confirmation but not the deny.
- `sakk resume`, `reconcile` and `unlock` from the agent are allowed, and the
  default ledger (`./sakk-ledger.json`) is a project file the agent may write,
  so one agent can lift a halt on another. A global halt holds.
- Cursor and Codex payloads are taken from their documentation; they have
  not yet been recorded from a running copy (test/fixtures/hooks/).

## Known open in v1

Found by the 2026-10-28 acceptance run and deferred to v2 by the owner
(docs/DECISIONS.md D10). Each has a finding in `findings/ledger.json` and a
planned fix in [V2-BACKLOG.md](V2-BACKLOG.md).

- **One spelling only (F-183, F-184).** On a case-insensitive disk (the
  macOS default) a command or a protected folder — guard state, agent
  config, CI workflows — written in another case is allowed. git's force flag
  is recognised in its separate short and full long spellings; the other
  spellings git accepts for it are allowed.
- **Symlinks are judged by their own name (F-186).** A read through a link
  with an ordinary name that points at a secret file is allowed.
- **Sakk by its name only (F-185).** The deny for commands that loosen a
  control matches the command name `sakk`; a launcher or the script path
  meets only the CLI's own terminal check.
- **Project-local install (F-187).** Installed into the project's
  `node_modules`, the hook's code and default policy are project files the
  agent may change or delete. Install globally.
- **Agent settings ask (F-188).** The requirement says deny; v1 asks a person
  for a write to the project's agent config, and asks through the generic
  outside-the-project rule for the user-level settings file.
- **Search tools and deny-read rules (F-189).** `install` writes a matcher
  without Grep and Glob, and no permissions deny rules for secret files, so a
  search can read them. The plugin's hook (`matcher: "*"`) is not affected.
- **Non-text Write content (F-190).** Content that is not a string is not
  scanned; the decision rests on the path alone.
- **Secrets in paths (F-194).** The decision log, the console and its exports
  mask a secret only in the command text, not in a path or scope. A secret
  deny records the rule but no fingerprint.
- **`init` (F-196).** `sakk init` prints "hook wired" but installs no guard;
  run `sakk guard install` after it.
