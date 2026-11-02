# Sakk tutorial: install, cap, block, console, halt, uninstall

**English** | [简体中文](zh-CN.md)

This walks through Sakk from a local checkout to a clean uninstall, in about
15 minutes. Every command below was run on macOS with Sakk 0.4.0 in a
throwaway home folder, and the output is copied from that run. Paths are
shortened to `~`, the console token is replaced by `<tok>`, and your dates,
time zone and figures will differ.

> This run installs from a checkout of the repository (step 2), so the output
> matches the exact code you are reading. Once `sakk` is on npm,
> `npm install -g sakk` can replace step 2.

## 0. What you need

- Node 20 or later, on macOS or Linux (Windows is not supported yet).
- git, and a checkout of the Sakk repository.
- Claude Code, if you want the guard to protect real sessions. The tutorial
  itself does not start Claude Code; it feeds the hook the same input Claude
  Code would.

## 1. Use a throwaway home folder (recommended)

Sakk keeps its state in `~/.sakk` and reads Claude Code's logs in
`~/.claude/projects`. To try it without touching either, point `HOME` at an
empty folder for this shell only:

```bash
unset CLAUDE_CONFIG_DIR SAKK_HOME SAKK_LEDGER_PATH   # so nothing points back at your real files
export HOME="$(mktemp -d)"
export PATH="$HOME/.npm-global/bin:$PATH"
mkdir -p ~/work/demo && cd ~/work/demo && git init -q .
```

Close the shell when you are done and the experiment is gone.

## 2. Build and install from a checkout

In your checkout of the repository:

```bash
mkdir -p ~/pack
npm pack --ignore-scripts --pack-destination ~/pack
npm install -g --prefix ~/.npm-global ~/pack/sakk-*.tgz
sakk --version
```

```text
sakk-0.4.0.tgz

added 1 package in 159ms
0.4.0
```

- `mkdir -p ~/pack` comes first because npm 11 does not create the
  `--pack-destination` folder; without it `npm pack` stops with `ENOENT`.
- `--ignore-scripts` matters in a git checkout: without it, `npm pack` runs
  the project's `prepare` script, which points that checkout's git hooks at
  the contributor checks (`core.hooksPath`). You do not need them to try Sakk.
- `--prefix ~/.npm-global` keeps the install inside the throwaway home. Drop
  it (and the `PATH` line in step 1) for a normal global install.
- `npm install -g <path to the checkout>` also works, but npm links the
  folder instead of copying it, so the guard would run code from a folder an
  agent may be editing. The packed file is a copy; prefer it.

## 3. Add the guard to your project

```bash
cd ~/work/demo
sakk guard install claude-code
sakk doctor
```

```text
claude-code: guard added to ~/work/demo/.claude/settings.json
! claude-code: this Claude Code is too old for onFailure (needs 2.1.295+), so the guard is installed FAIL-OPEN — if the hook ever fails to start, the tool call proceeds UNGUARDED. Upgrade Claude Code and reinstall for a fail-closed guard; sakk doctor flags this.
next: sakk doctor — it checks the hook really fires
```

```text
✓ node — Node 25.8.2 (20 or later required)
✓ policy — ~/.npm-global/lib/node_modules/sakk/policies/guard-default.json — 17 rules, sha256 77d0fc7022df…
✓ decision log — ~/.sakk/decisions.jsonl is writable
✓ claude-code (project) — ~/work/demo/.claude/settings.json: a forced push is denied
! claude-code start folder — Claude Code loads ~/work/demo/.claude/settings.json only for sessions started in ~/work/demo; a session started in a parent folder skips it — add --user, or managed settings, if you start sessions elsewhere
! cursor — not installed (sakk guard install cursor to add it)
! codex — not installed (sakk guard install codex to add it)
! claude-code fail-open — the installed Claude Code hook has no onFailure: block — it was installed on a Claude Code older than 2.1.295, so if the hook ever fails to start the tool call proceeds UNGUARDED; upgrade Claude Code and run sakk guard install claude-code again for a fail-closed guard
```

Both commands exited 0. The machine in this run had a Claude Code older than
2.1.295, so the guard was written without `onFailure: block` and both
commands said so. On a newer Claude Code the guard is written fail-closed and
that warning goes away. `sakk guard install cursor` and
`sakk guard install codex` add the same guard for those agents.

## 4. Ask the guard before an agent does

`sakk try` shows how the guard would judge a command. Nothing runs.

```bash
sakk try 'git push --force origin main'
```

```text
deny             git.destructive  (rule shell-destructive)
→ deny
Sakk: git.destructive is denied by rule shell-destructive (~/.npm-global/lib/node_modules/sakk/policies/guard-default.json). A person changes the policy; If this is wrong, tell the person you work for and stop; do not route around it.
policy ~/.npm-global/lib/node_modules/sakk/policies/guard-default.json (sha256 77d0fc7022df…)
```

## 5. Set a daily cap

```bash
sakk cap set 5
sakk spend
```

```text
cap set: $5/day in ~/.sakk/config.json — the hook denies paid calls once today's spend from local logs reaches it
spend 2026-11-02 (Asia/Dubai, from local logs): $0 of $5 cap
```

The day follows your machine's time zone; `--zone` picks another, for
example `sakk cap set 5 --zone Europe/Berlin`. Setting a cap or lowering it
needs no confirmation. Raising it, lifting it or moving its day does (step 7).

## 6. See a block happen

Spend is read from Claude Code's own log files. To see the cap bite without
paying for tokens, write a sample log with two large calls into the throwaway
home. **Do not do this in your real home**: spend that Sakk has counted stays
counted for the day, even if you delete the log afterwards.

```bash
mkdir -p ~/.claude/projects/-work-demo
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
cat > ~/.claude/projects/-work-demo/session.jsonl <<EOF
{"type":"assistant","timestamp":"$NOW","requestId":"req_a","message":{"id":"msg_req_a","model":"claude-sonnet-4-5","usage":{"input_tokens":900000,"output_tokens":120000}}}
{"type":"assistant","timestamp":"$NOW","requestId":"req_b","message":{"id":"msg_req_b","model":"claude-opus-4-5","usage":{"input_tokens":200000,"output_tokens":40000}}}
EOF
sakk spend
```

```text
spend 2026-11-02 (Asia/Dubai, from local logs): $6.5 of $5 cap
  claude-sonnet-4-5  $4.5
  claude-opus-4-5  $2
```

Now send the hook the JSON Claude Code sends before a tool call:

```bash
echo '{"hook_event_name":"PreToolUse","cwd":"'"$PWD"'","session_id":"s1","tool_use_id":"t1","tool_name":"Bash","tool_input":{"command":"npm test"}}' \
  | sakk hook --agent claude-code
```

```text
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Sakk: shell.run refused — SPEND_CAP_REACHED: $6.50 ≥ $5.00 today (2026-11-02, Asia/Dubai, from local logs) — a person raises it with sakk cap set <usd>; it resets at midnight. If this is wrong, tell the person you work for and stop; do not route around it."}}
```

In a real session Claude Code reads this answer, does not run `npm test`, and
shows the agent the reason. Every guarded call is refused the same way until
midnight or until a person raises the cap.

If a log names a model the price table does not list, Sakk does not guess
its price. The cap then refuses with `PRICE_UNKNOWN` for the day, because it
cannot show that spend is under the cap. The FAQ explains how to add a price.

## 7. Raising or lifting the cap needs a person

```bash
sakk cap set 10
```

At a terminal Sakk asks you to retype a word:

```text
This raises the daily cap from $5 to $10.
An agent must not make this change, so a person confirms it here. Type 10 to go ahead:
```

Anything other than `10` changes nothing:

```text
HUMAN_CONFIRMATION_REQUIRED: the answer was not 10; nothing changed
```

With no terminal (an agent's tool call, a script), it refuses outright and
exits 2:

```text
HUMAN_CONFIRMATION_REQUIRED: This raises the daily cap from $5 to $10 — a person confirms this at a terminal, and this run has none; nothing changed
```

`sakk cap off` works the same way; the word to type is `off`. The guard also
denies an agent that tries to run a `sakk cap` command or write to `~/.sakk`.

## 8. Spend as JSON, and the price table

```bash
sakk spend --json
```

```text
{
 "day": "2026-11-02",
 "zone": "Asia/Dubai",
 "cap_usd": 5,
 "spend_usd": 6.5,
 "calls": 2,
 "future": 0,
 "backdated": 0,
 "by_model": {
  "claude-sonnet-4-5": 4.5,
  "claude-opus-4-5": 2
 },
 "unpriced": {},
 "unreadable": 0,
 "source": "from local logs"
}
```

```bash
sakk prices
```

```text
prices: 170 model(s) from ~/.npm-global/lib/node_modules/sakk/prices/snapshot.json
  provenance (as recorded in the table): https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json, at commit 34c10829b1f2aba5ee44887a413bac12d77e2bc0, sha256 7989a84f15ba56025650ed850c1b1a262d95a42680746d7ec5b1c956dd012121, fetched 2026-10-28, LiteLLM (MIT, (c) Berri AI)
  claude-haiku-4-5-20251001  in 0.000001 / out 0.000005
  claude-haiku-4-5  in 0.000001 / out 0.000005
  claude-sonnet-4-5  in 0.000003 / out 0.000015
  …
```

Rates are US dollars per token. The table is built from LiteLLM's public
price list; the `provenance` line repeats what the `source` block inside
`prices/snapshot.json` records: the URL, commit, SHA-256 and date it was
built from.

## 9. The console

```bash
sakk ui --port 8790
```

```text
Sakk console: http://127.0.0.1:8790/?t=<tok>  (read-only; Ctrl+C to stop)
```

Open the printed address in your browser. The console shows today's spend
against the cap and the guard's recent decisions, such as the refusal from
step 6. It listens on 127.0.0.1 only, and every request
needs the token from the address: in this run, a request without it got
HTTP 403. Treat the address like a password and do not paste it anywhere.

Without `--port` the console picks a free port. If the port is taken it
says so and exits 2:

```text
UI_PORT_IN_USE: port 8790 is already in use — choose another --port
```

The console is read-only. Its Emergency stop button works only when a
ledger exists (step 10) and you start the console with
`sakk ui --allow-halt`; you then type STOP to confirm. It never resumes
agents; resuming is done at a terminal (step 10). Press Ctrl+C to stop the
console.

### Optional: a username and password

The token address is enough on your own machine. To sign in with a username
and password instead, set them at a terminal:

```bash
sakk ui --set-password
```

```text
Console username: oncall
Password (15 or more characters, not shown):
The same password again:
Console sign-in set for oncall (~/.sakk/console-login.json, owner-only). Restart sakk ui for it to take effect.
```

With no terminal (an agent's tool call, a script) it refuses and exits 2:

```text
UI_PASSWORD_NEEDS_TTY: set the password at a terminal: sakk ui --set-password asks for it and does not echo it
```

Restart the console and it says sign-in is on:

```text
Sakk console: http://127.0.0.1:8790/?t=<tok>  (read-only; Ctrl+C to stop)
Sign-in is on: http://127.0.0.1:8790/ asks for the username and password; the address above works too. sakk ui --clear-password turns it off.
```

A password sign-in reads the console; the Emergency stop still needs
`--allow-halt` and the token address. A session ends after 30 minutes idle or
8 hours, and after five wrong tries within 15 minutes sign-in refuses until
that window has passed. To go back to the token address only:

```bash
sakk ui --clear-password
```

```text
Console sign-in removed (~/.sakk/console-login.json). Restart sakk ui: it is token-only again.
```

Run it again when nothing is set and it says
`No console sign-in was set; sakk ui is token-only.`

## 10. Halt and resume

A halt is the kill switch: it refuses every new guarded tool call, whatever
the cap says (reading files inside the project stays allowed). The halt is kept in a spend ledger, so create
one first. Its `--cap` is the ledger's own budget for agent code that books
spend through Sakk; it is separate from the daily cap in step 5.

```bash
sakk init --cap 20 --by oncall
sakk halt --by oncall --reason "runaway loop"
sakk status
```

```text
ledger created: ~/.sakk/sakk-ledger.json
hook wired: a halt on this ledger now stops the guarded agent (~/.sakk/config.json)
cap: $20 — reserve before you spawn; reaching the cap refuses.
```

```text
HALTED all spending by oncall: every new reservation now refuses. Refusals are logged to sakk-alerts.jsonl beside the ledger.
```

```text
ledger      ~/.sakk/sakk-ledger.json
cap         $20
settled     $0
outstanding $0
committed   $0  (remaining $20, max reservable $0)
entries     0 (reserved 0, settled 0, reconciliation 0)
updated     2026-11-02T18:22:54.965Z
⛔ HALTED by oncall at 2026-11-02T18:22:55.031Z — runaway loop (all new spending refused)
```

`sakk status` exits 4 while a halt is on. The hook now refuses with the halt:

```text
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Sakk: shell.run refused — halted (global) by oncall at 2026-11-02T18:22:55.031Z — runaway loop; a person resumes with: sakk resume --by <name>. If this is wrong, tell the person you work for and stop; do not route around it."}}
```

`--by` is a name you type. Sakk records it as given and does not check who
you are. `--agent <id>` halts one agent instead of all of them.

To lift the halt, a person runs `sakk resume` at a terminal:

```bash
sakk resume --by oncall
```

```text
This lifts the halt on all spending (~/.sakk/sakk-ledger.json).
An agent must not make this change, so a person confirms it here. Type resume to go ahead:
```

Type `resume`. With no terminal it refuses with `HUMAN_CONFIRMATION_REQUIRED`
and exits 2, and the guard denies an agent that tries to run it.

## 11. Uninstall

Remove the guard **before** you remove the package. Otherwise the settings
file still points the hook at a file that no longer exists.

```bash
cd ~/work/demo
sakk guard uninstall claude-code
```

```text
This removes the guard from ~/work/demo/.claude/settings.json.
An agent must not make this change, so a person confirms it here. Type claude-code to go ahead:
```

Type `claude-code`. Then remove the package and, if you want, Sakk's state:

```bash
npm uninstall -g --prefix ~/.npm-global sakk   # drop --prefix for a normal global install
rm -rf ~/.sakk                                 # config, decision log, spend index, ledger
```

If you used the throwaway home from step 1, closing the shell is enough.

## Exit codes

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | ok                                                              |
| 1    | ledger error (for example `LEDGER_MISSING` before `sakk init`)  |
| 2    | usage error, or a change refused because no person confirmed it |
| 3    | reconciliation required (`sakk status`)                         |
| 4    | halted (`sakk status`; wins over 3)                             |

Next: the [FAQ](../FAQ.md) answers what happens when the hook fails, where
the data lives, and how spend is computed.
