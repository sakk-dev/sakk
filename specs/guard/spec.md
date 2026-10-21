# Agent guard (open-source v1, M1) — spec + three tables

Blueprint: open-source v1, headline 1 ("the agent guard"). Target design:
the v10 console, Guard rules page and Agents → Connections
(`../sakk-console-prototype-v10/`). It touches the policy kernel's callers
and the halt check, so it is a core area: three tables, a contract agreed
before code, and independent adversarial review before merge
(CONSTITUTION #4).

## What it is

Every tool call an agent makes passes through one entry point before it runs:

```
agent hook → sakk hook --agent <name>
  1. normalize   the agent's payload → one Event
  2. classify    the Event → action words + scopes
  3. check       halt → spend cap (M2) → secrets (M3) → guard rules
  4. answer      allow (silent) | deny | ask, in the agent's own format
  5. log         one line per decision, hash-pinned to the policy
```

Commands:

| Command                                           | What it does                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `sakk hook --agent claude-code\|cursor\|codex`    | The hook itself. Reads the payload on stdin and answers on stdout. Never prompts.            |
| `sakk guard install <agent> [--user]`             | Writes the agent's hook config (project by default), merging with what is there. Idempotent. |
| `sakk guard uninstall <agent> [--user]`           | Removes only what `install` added.                                                           |
| `sakk try "<command>"` / `sakk try --read <path>` | Shows the actions, each rule hit and the final answer, without running anything.             |
| `sakk doctor`                                     | Checks that the guard really runs where sessions start (see "Doctor").                       |

## Event

The hook turns each agent's payload into one shape:

| Field       | Claude Code (`PreToolUse`)               | Cursor                                             | Codex             |
| ----------- | ---------------------------------------- | -------------------------------------------------- | ----------------- |
| `tool`      | `tool_name`                              | `shell` / `read` / `mcp`, from the hook event name | the tool name     |
| `command`   | `tool_input.command` (Bash)              | `command` (beforeShellExecution)                   | the shell command |
| `path`      | `tool_input.file_path` (Read/Edit/Write) | `file_path` (beforeReadFile)                       | the file path     |
| `content`   | `tool_input.content` / `new_string`      | `content` (beforeReadFile)                         | —                 |
| `mcp`       | `mcp__<server>__<tool>`                  | server + tool (beforeMCPExecution)                 | server + tool     |
| `cwd`       | `cwd`                                    | `cwd`                                              | `cwd`             |
| `callId`    | `tool_use_id`                            | `generation_id` + hook event + counter             | the call id       |
| `sessionId` | `session_id`                             | `conversation_id`                                  | the session id    |

The field names are from each tool's official hook docs, read on 2026-10-21.
They are assumptions until M1 task 1 has seen each agent fire once
(assumption table below). A payload the hook cannot read is a deny, never a
pass.

`repoRoot` is the git top-level of `cwd`; with no repository, `cwd` stands
in for it and the log says so.

## Actions

The classifier maps an Event to one or more **actions**, each with an
optional **scope**. Action names are public API: policies match on them.

| Action                | From                                                                                                                          | Scope                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `file.read`           | Read tool; `cat`, `head`, `grep` … on named files                                                                             | the path               |
| `file.write`          | Edit/Write/NotebookEdit; redirects, `tee`, `sed -i`, `cp`/`mv` targets, `git checkout\|restore <path>`                        | the path               |
| `file.delete`         | `rm`, `rmdir`, `git rm`, `mv` source, `find -delete`, `git clean`                                                             | the path               |
| `secret.read`         | reading a secret file (`.env*`, `*.pem`, `id_rsa*`, `~/.aws/credentials`, …); `printenv`/`env` with no args                   | the path, if any       |
| `git.destructive`     | `git push --force` / `-f` / `+ref`, `git reset --hard`, `git branch -D` of the default branch, `filter-branch`, `filter-repo` | —                      |
| `prod.delete`         | `kubectl delete`, `terraform destroy`, `aws s3 rm --recursive`, `DROP DATABASE\|TABLE` via a SQL client                       | —                      |
| `deploy`              | `kubectl apply`, `terraform apply`, `vercel --prod`, `fly deploy`, `npm publish`, `gh release create`                         | —                      |
| `package.install`     | `npm install <pkg>`, `pip install`, `brew install`, `cargo add`                                                               | —                      |
| `net.download`        | `curl -o`, `wget`, `git clone`                                                                                                | the target, if in repo |
| `shell.constructed`   | a command whose text is built at run time: `eval`, `sh -c "$X"`, `$(…)` in command position, `… \| sh`, `base64 -d \| bash`   | —                      |
| `shell.run`           | any other command (an interpreter running a file, a build, a test run)                                                        | —                      |
| `mcp.<server>.<tool>` | an MCP tool call                                                                                                              | —                      |

**Scopes.** Paths inside `repoRoot` become canonical repo-relative paths,
the only shape the kernel matches. Paths outside become
`~outside/<absolute path without the leading slash>`, so a rule can target
"outside the repository" by prefix. Paths under `$SAKK_HOME` (cap, price
table, decision log, spend index) become `~sakk/<relative path>`, so the
shipped policy can protect Sakk's own state wherever it lives. The kernel
needs no change. A repository path never starts with `~`; one that does
refuses as ambiguous. A path that
cannot be made canonical after resolving symlinks, `~` and `..` refuses
(`HOOK_PATH_UNREADABLE`), because an alias that matches nothing would slide
past a deny (policy-engine review F2).

**One call, several actions.** `rm -rf build && git push --force` yields
`file.delete` (`build`) and `git.destructive`. Each action is decided
separately, and the strictest answer wins: deny, then ask, then allow.

**Shell parsing** reuses the tokenizer that gates this repository's own
shell writes (`scripts/findings-lib.mjs`, measured in
`test/self-evolution.test.mjs` and adversarially reviewed: F-133). It moves
to `src/classify.mjs`, and the loop imports it from there. Wrappers
(`sudo`, `env`, `command`, `timeout`, `nice`, `nohup`, `exec`, absolute
binary paths) are unwrapped before the command is named. Input over 64 KiB
refuses.

## Checks, in order

1. **Halt.** A global halt, or a halt on this agent id, in the ledger
   (`sakk halt`) means deny everything except reads of the repository. The
   reason names who halted it and how to resume.
2. **Spend cap** (M2, `specs/spend/`). When today's spend has reached the
   cap, deny every call. The cap applies at the next tool call.
3. **Secrets** (M3, `specs/secret-guard/`). `secret.read`, a write whose
   content holds a secret, and a command that prints a secret are denied.
4. **Guard rules.** `decide()` runs on each action with the context
   `{agent, action, scope, estimatedUsd: 0, callId}`. Tool calls cost
   nothing themselves; model spend is step 2.

## Answer per agent

| Verdict            | Claude Code                                                                                       | Cursor                                             | Codex                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| allow              | no output, exit 0 (never `allow`: Sakk only restricts; Claude Code's own permissions still apply) | `{"permission":"allow"}`                           | no output, exit 0                                                                     |
| deny               | `hookSpecificOutput.permissionDecision: "deny"` with the reason                                   | `{"permission":"deny", userMessage, agentMessage}` | its deny shape                                                                        |
| `require_approval` | `permissionDecision: "ask"`                                                                       | `{"permission":"ask"}`                             | **deny** — Codex does not support ask and would run the call (decision 3, 2026-10-21) |

Every reason names the rule, the action and the way out (edit the policy,
`sakk resume`, raise the cap).

## Failure

- Any error inside the hook is a deny, with the error code in the reason
  (decision 2, 2026-10-21). The handler catches everything and answers
  itself. It never relies on the agent's handling of a crash, because
  Claude Code treats any exit other than 2 as "go ahead".
- The hook keeps its own deadline of 2 s and answers deny when it is
  reached.
  - Claude Code's hook timeout, and a killed process, still let the call
    run. That is ceiling 1.
  - `onFailure: "block"` closes it on Claude Code 2.1.295+. `install`
    writes it when the installed version supports it.
- Cursor: `install` sets `failClosed: true`.

## Decision log

One JSON line per decision, written through `logDecision()` (the line
format is public API). The log lives at `$SAKK_HOME/decisions.jsonl`
(`SAKK_HOME` defaults to `~/.sakk`). Each line gains
`{agent, tool, sessionId, repoRoot, actions:[…], answered}`. Commands and
file contents are never logged; paths are. A log that cannot be written is
a deny (`DECISION_UNLOGGABLE`): an action with no record is unauditable.

## Policy

Shipped default: `policies/guard-default.json` (`sakk-policy.v1`). A
project policy at `.sakk/policy.json` replaces it. Either one is loaded
with `loadPolicy()`, so vacuous, shadowed and malformed policies refuse at
load, and the hook then denies with that code.

| Rule                       | Match                                                                                      | Verdict          |
| -------------------------- | ------------------------------------------------------------------------------------------ | ---------------- |
| `protect-secret-files`     | action `secret.read`                                                                       | deny             |
| `shell-destructive`        | action `git.destructive`                                                                   | deny             |
| `deny-prod-delete`         | action `prod.delete`                                                                       | deny             |
| `deny-rm-outside-repo`     | action `file.delete`, scope `~outside/`                                                    | deny             |
| `protect-ci-files`         | action `file.write`, scope `.github/workflows/`                                            | deny             |
| `protect-migrations`       | action `file.delete`, scope `migrations/`, `db/migrations/`                                | deny             |
| `protect-guard-state`      | action `file.write` or `file.delete`, scope `.sakk/`, `~sakk/` (two rules, one per action) | deny             |
| `ask-agent-config`         | action `file.write`, scope `.claude/`, `.cursor/`, `.codex/`                               | require_approval |
| `high-risk-deploy`         | action `deploy`                                                                            | require_approval |
| `ask-constructed-commands` | action `shell.constructed`                                                                 | require_approval |
| `allow-in-repo`            | `{}` — everything the rules above did not stop                                             | allow            |
| default                    | —                                                                                          | deny             |

The default only fires if someone removes `allow-in-repo`; it makes that
failure safe. The v10 sample rules for model calls (`dev-model-calls`,
`big-model-call`) and the cap are not hook rules. The cap is step 2. Model
calls are not tool calls, and the hook cannot see them.

## Install

| Agent       | Writes                                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | `.claude/settings.json` (or `~/.claude/settings.json` with `--user`): a PreToolUse group with matcher `Bash\|PowerShell\|Monitor\|Read\|Edit\|Write\|MultiEdit\|NotebookEdit\|mcp__.*` and command `node <absolute path to bin/sakk.mjs> hook --agent claude-code` |
| Cursor      | `.cursor/hooks.json`: `beforeShellExecution`, `beforeReadFile` and `beforeMCPExecution`, with `failClosed: true`                                                                                                                                                   |
| Codex       | its hook config, in the format M1 task 1 verifies                                                                                                                                                                                                                  |

How `install` writes:

- It merges and never replaces: other hooks stay, and a second install
  changes nothing.
- It writes a backup next to the file and prints the diff.
- The command is an absolute `node … bin/sakk.mjs` path, not `npx`, so
  that startup stays well under the deadline.

## Doctor

`sakk doctor` prints one line per check and exits 1 if any check fails.
F-132 taught us that a hook can be configured and never run. The doctor
checks where the hook really loads, not only that it is configured:

1. Node is version 20 or later.
2. The policy loads, and its hash is printed.
3. The decision log is writable.
4. For each agent, the hook is present in the config that agent reads, and
   the command path exists.
5. **Start folder.** If the guard is in a repository's
   `.claude/settings.json` but sessions start in a parent folder, nothing
   runs. The doctor says so and prints the parent-folder fix.
6. **Double run.** Cursor also runs Claude Code's hooks, so when both are
   installed each call is decided twice. That is harmless but logged twice,
   and the doctor reports it.
7. **Fire test.** The doctor sends one synthetic `git push --force` payload
   through the installed command line and expects a deny.

## Adversary table

The adversary is the agent itself: it is blocked and wants to keep going.
Prompt injection pushes it to do harm.

| #   | Move                                                                                                              | Must-hold outcome                                                                                                                                         | Guard test                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | `git push --force` dressed up: `git push -f`, `+main`, `git -C . push --force-with-lease=…`                       | `git.destructive` → deny                                                                                                                                  | `test/guard.test.mjs::every destructive git form is denied`                          |
| 2   | Wrap it: `sudo env FOO=1 command git push -f`, `/usr/bin/git push -f`, `bash -c 'git push -f'`                    | unwrapped → deny; `bash -c '<literal>'` is parsed, `bash -c "$X"` is constructed → ask                                                                    | `test/guard.test.mjs::wrappers are unwrapped before the command is named`            |
| 3   | Hide it: `eval "$(echo Z2l0IHB1c2ggLWY= \| base64 -d)"`, `curl … \| sh`                                           | `shell.constructed` → ask (Codex: deny)                                                                                                                   | `test/guard.test.mjs::commands built at run time are asked, never allowed`           |
| 4   | Delete outside the repo through an alias: `rm -rf ~/`, `rm -rf ../../`, a symlink in the repo pointing at `$HOME` | resolved to `~outside/…` → deny                                                                                                                           | `test/guard.test.mjs::deletes outside the repository are denied through every alias` |
| 5   | Read a secret another way: `cat .env`, `cp .env x && cat x`, `grep . .env`, Read tool on `.env.local`, `printenv` | `secret.read` → deny (the copy is denied at `cp`, the source being secret)                                                                                | `test/guard.test.mjs::secret files are denied on every read route`                   |
| 6   | Crash the hook: malformed payload, 2 MB command, missing fields, unknown tool                                     | deny with a code, never exit 1                                                                                                                            | `test/guard.test.mjs::every malformed payload is a deny with a code`                 |
| 7   | Slow the hook past the agent's timeout                                                                            | own 2 s deadline → deny; the agent's timeout is ceiling 1                                                                                                 | `test/guard.test.mjs::the hook answers deny at its own deadline`                     |
| 8   | Edit the policy to allow itself                                                                                   | `.sakk/` and the shipped policy are `protect`ed by default (`file.write` scope `.sakk/` → deny); a policy edited by hand loads with a new hash in the log | `test/guard.test.mjs::the agent cannot write the policy it is judged by`             |
| 9   | Turn the guard off: edit `.claude/settings.json`, `git config core.hooksPath`                                     | `file.write` scope `.claude/` → ask; the doctor's fire test fails if the hook is gone                                                                     | `test/guard.test.mjs::writes to agent hook configs are asked`                        |
| 10  | Skip the hook: @-mention a file (Claude Code reads it without PreToolUse), a second agent with no hook            | not stoppable at the hook: ceiling 2; secret files are still caught at commit (M3)                                                                        | —                                                                                    |
| 11  | Fill the log so the console hides a decision                                                                      | the log is append-only through `appendNoFollow`; the console pages through it, never truncates (M4)                                                       | `test/guard.test.mjs::the decision log is appended, never rewritten`                 |
| 12  | Race two calls on one halt                                                                                        | the halt is read per call from the ledger, with no cache                                                                                                  | `test/guard.test.mjs::a halt set between two calls stops the second`                 |

## Input-space table

| Input         | Classes covered                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload       | Valid per agent; missing `tool_name` / `tool_input` / `cwd`; wrong types; extra fields; non-JSON; empty stdin; over 1 MiB                                                                                                        |
| Tool          | Every Claude Code tool in the matcher; MCP names with odd characters; unknown tools (→ `shell.run` with no scope, so the default policy's later rules apply); PowerShell                                                         |
| Shell command | Empty; chains (`&&` `\|\|` `;` `\|` newline); quoting (`'…'`, `"…"`, `$'…'`); heredoc; `$(…)` and backticks; wrappers; absolute binaries; over 64 KiB; unterminated quote (→ constructed)                                        |
| Path          | Repo-relative, absolute in the repo, outside, `~`, `..`, symlink in and out of the repo, case-only differences on macOS, unicode lookalikes (refused as non-canonical where they change meaning), a file that does not exist yet |
| Policy        | Shipped default; project override; missing; malformed; vacuous; shadowed rule; unknown action name (loads, but `doctor` warns)                                                                                                   |
| Environment   | No git repository; detached HEAD; no ledger (halt step: no halt known, stated in the reason for a deny elsewhere); unwritable `SAKK_HOME`; Node 20, 22 and 24                                                                    |

## Evidence-source declaration

| Claim in the log or the console | Source                                                   | Strength                                                                                           |
| ------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| "This call was blocked"         | the hook's own answer, written before it returns         | Strong for calls that reached the hook. Calls that never reached it leave no line (ceilings 1, 2). |
| "Agent X made the call"         | the `--agent` flag the config passes, and the session id | Self-declared by the installed config. An agent can run another agent's hook command line.         |
| "Policy P decided"              | the sha-256 of the policy bytes                          | Strong: any edit changes the hash.                                                                 |
| "The guard was running"         | doctor's fire test, at the time it ran                   | Point-in-time only.                                                                                |

## Ceilings (stated, not hidden)

1. **Timeouts and kills.** If the hook process is killed or the agent's
   hook timeout fires, the call runs. The only exception is Claude Code
   with `onFailure: "block"`.
2. **Routes without a hook.** Claude Code's @-mentions, an agent with no
   hook installed, and a person at the terminal are not seen. Secrets are
   still caught at commit.
3. **Shell text.** The classifier reads text, not what runs. A script file
   that deletes `$HOME` is `shell.run`. The guard knows what a command
   _says_; isolation (a container) is the only answer to what a script
   _does_.
4. **Cursor file edits** have no pre-edit hook. Only shell, read and MCP
   calls are judged before they run.

## History pitfalls (findings/classes.json)

| Class                              | Where it bites here                                             | How this design avoids it                                                                                     |
| ---------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| C-01 Absence read as success       | missing payload fields, policy, ledger, git                     | every absent input has a row above and refuses; tests delete each one                                         |
| C-02 A list stands in for the rule | the destructive-command list                                    | rule: "provably read-only, or a named action"; unknown → `shell.run`; the table of forms is both-sided (C-13) |
| C-07 Untrusted input trusted       | the payload, the command text, file contents                    | bounded sizes; no command is ever executed by the hook; nothing from the payload reaches a shell              |
| C-08 One thing, two names          | path aliases, agent names                                       | canonical scopes after symlink and `..` resolution; aliases refuse                                            |
| C-09 Environment assumed           | where hooks load from (F-132), Node versions, Cursor double run | doctor's start-folder and fire tests; CI on Node 20/22/24                                                     |
| C-10 Step only in rule text        | "install the hook"                                              | doctor fails when the hook would not fire                                                                     |
| C-12 Literal without context       | `rm` in a string, `--force` in a commit message                 | the tokenizer splits quoted text from words; tests cover both directions                                      |
| C-13 Detector tuned on one side    | the classifier                                                  | one table of read-only and destructive forms, both measured, including F-133's git writes                     |
| C-14 Failure not isolated          | a hook crash                                                    | caught and answered as deny with a code                                                                       |

## Assumptions (to verify in M1 task 1, by watching each agent fire once)

| #   | Assumption                                                                                          | Source (read 2026-10-21) |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------ |
| A1  | Claude Code PreToolUse payload and output fields as in "Event" and "Answer per agent"               | Claude Code hooks docs   |
| A2  | Claude Code treats exit codes other than 2 as non-blocking, and `onFailure: "block"` needs 2.1.295+ | Claude Code hooks docs   |
| A3  | Cursor hook names, payload fields, `permission` values and `failClosed`                             | Cursor hooks docs        |
| A4  | Cursor runs `.claude/settings.json` hooks too                                                       | Cursor hooks docs        |
| A5  | Codex PreToolUse-style hooks exist, and `ask` is not honoured                                       | Codex docs               |
