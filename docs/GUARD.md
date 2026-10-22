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
and nothing changes; `sakk guard uninstall <agent>` removes only what it added.

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
| `ask-agent-config`         | writing `.claude/`, `.cursor/`, `.codex/`                                                 | ask you |
| `high-risk-deploy`         | deploys and publishing                                                                    | ask you |
| `ask-constructed-commands` | commands built at run time (`eval`, `curl … \| sh`, `bash -c "$X"`)                       | ask you |
| `ask-write-outside`        | writing outside the project — your home folder and elsewhere (temporary folders excepted) | ask you |
| `allow-in-repo`            | everything else                                                                           | allow   |

Codex runs a call when a hook asks, so for Codex "ask you" is a deny.

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

If a ledger is configured (`~/.sakk/config.json`: `{"ledgerPath": "…"}`)
and someone runs `sakk halt`, every tool call is denied except reading the
repository, until a person runs `sakk resume`.

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
- Cursor and Codex payloads are taken from their documentation; they have
  not yet been recorded from a running copy (test/fixtures/hooks/).
