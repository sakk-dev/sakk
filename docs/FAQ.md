# Sakk FAQ

**English** | [简体中文](FAQ.zh-CN.md)

Short answers to the questions people ask first. The
[tutorial](tutorial/en.md) shows each command with its real output.

## What happens if the Sakk hook itself fails?

It depends on how the hook was installed and on your Claude Code version.

- **Loaded as a plugin** (`claude --plugin-dir`): the hook entry in
  `.claude-plugin/plugin.json` sets `"onFailure": "block"`, a `"*"` matcher
  (every tool) and a 10-second timeout. If the hook cannot run, Claude Code
  blocks the tool call instead of letting it through.
- **Installed with `sakk guard install claude-code`**: Sakk writes
  `onFailure: block` only on Claude Code 2.1.295 or later, the first version
  that knows the key. On an older Claude Code it installs the guard
  fail-open, says so, and `sakk doctor` keeps flagging it: if the hook then
  fails to start, the tool call goes ahead unguarded. Upgrade Claude Code and
  run the install again to get a fail-closed guard.
- **Neither installed**: Claude Code has no Sakk hook to call, so nothing
  checks the agent's tool calls.

When the hook does run but cannot read its policy, its config or today's
spend, it refuses the call rather than allowing it. Only reading files
inside the project stays allowed, so the agent can still see its code.

## How is Sakk different from Microsoft's Agent Governance Toolkit?

They aim at different jobs. Microsoft's Agent Governance Toolkit
(`microsoft/agent-governance-toolkit`, MIT, in public preview) is a runtime
governance toolkit for teams building their own agents: policy enforcement
in YAML, OPA Rego or Cedar, zero-trust identity, sandboxing and reliability
features, with SDKs in several languages, addressing the OWASP Agentic Top 10
([I Programmer, 2026](https://www.i-programmer.info/news/105-artificial-intelligence/18796-microsoft-releases-open-source-agent-governance-toolkit-.html),
checked 2026-11-01).

Sakk guards coding agents you already run, such as Claude Code, through
their own hook, without changing the agent. It adds a daily spend cap read
from the agent's local logs, a secret guard and a kill switch, and keeps
everything on your machine. If you are writing an agent framework
integration, look at the toolkit; if you want a guard on the coding agent
on your laptop today, that is what Sakk is for. [compare.md](compare.md)
sets Sakk next to other tools.

## Where does Sakk keep its data?

On your machine, in plain files:

| Where                                   | What                                                              |
| --------------------------------------- | ----------------------------------------------------------------- |
| `~/.sakk/config.json`                   | the daily cap, its time zone, the ledger path                     |
| `~/.sakk/decisions.jsonl`               | one line per guard decision                                       |
| `~/.sakk/spend/`                        | the spend index (`files.json`, `baseline.json`, one file per day) |
| `~/.sakk/sakk-ledger.json`              | the spend ledger and any halt, after `sakk init`                  |
| `~/.sakk/sakk-alerts.jsonl`             | refusals while a halt is on                                       |
| `~/.sakk/prices.json`                   | your own price table, only if you add one                         |
| `.claude/settings.json` in your project | the hook entry `sakk guard install claude-code` adds              |

Sakk reads Claude Code's logs in `~/.claude/projects` (or under
`CLAUDE_CONFIG_DIR` when that is set) and never changes them. Set
`SAKK_HOME` to keep Sakk's own files somewhere other than `~/.sakk`. When
the guard finds a secret it records a fingerprint, never the value.

## Does Sakk send my data anywhere?

No. Sakk has no telemetry, no account and no server of ours to talk to; the
code you install makes no outgoing network requests. The only thing that listens on the
network is the console you start yourself with `sakk ui`: it binds to
127.0.0.1 only and refuses any request without the token in the address it
prints (HTTP 403).

## Does it work with Cursor or Codex?

The guard does: `sakk guard install cursor` and `sakk guard install codex`
add the same hook, so the policy, the secret guard and a halt apply to those
agents too. The spend figure does not cover them yet: `sakk spend` reads only
Claude Code's logs. The cap is still checked on every guarded call, but
tokens spent through Cursor or Codex are not in the total.

## How do I connect my own app, not a coding agent?

Through the LiteLLM proxy, which speaks the OpenAI API, so any language with
an OpenAI client works. Install LiteLLM 1.106.2 from a hash-locked file
(`sakk gateway init` prints the steps when it cannot find `litellm`), then:

```bash
sakk init --cap 5        # the ledger the gateway charges
sakk gateway init        # writes the gateway files and start.sh under ~/.sakk/gateway
LITELLM_MASTER_KEY=<a long random key> DEEPSEEK_API_KEY=<your key> ~/.sakk/gateway/start.sh
```

In the app, change one line and send `LITELLM_MASTER_KEY` as the API key:

```bash
OPENAI_BASE_URL=http://127.0.0.1:4000/v1
```

`sakk gateway init` refuses to overwrite its files unless you pass
`--force`, and takes `--dir`, `--ledger`, `--port` and `--litellm`. Prices,
refusals and limits are in
[integrations/litellm/README.md](../integrations/litellm/README.md). A call
the app sends straight to the provider, with a real provider key, does not
go through the gateway; keep provider keys out of the app.

## What happens to my app's calls if Sakk is down?

If the gateway cannot get an answer from the spend ledger, it lets the call
through by default and says so: a WARNING in the proxy's log, an
`x-sakk-status: unmetered` header on the response, a red banner in `sakk ui`
and a line in `sakk status`. Those calls are not recorded in the ledger and
not held to the cap. Start the gateway with `SAKK_ON_UNAVAILABLE=deny` to
refuse them instead. A deliberate refusal is always a refusal: 402 when the
budget is exceeded, 403 for a model with no price, 400 for a malformed request. Only the gateway behaves
this way; the coding-agent guard and the spend ledger for your own code stay
fail-closed (see the first answer above).

## What does it cost to run?

Nothing. Sakk is free, open source and runs locally on Node with no runtime
dependencies, no account and no service to pay for. It makes no model calls
of its own. Each guarded tool call starts a short Node process for the
hook, so there is a small local delay per call.

## How is spend computed?

From your local logs, as an estimate:

1. Sakk reads the token usage of each assistant message in Claude Code's
   logs. Each call is counted once, keyed by its message id and request id,
   so a log read twice does not double it.
2. It multiplies the tokens by a price table. The table that ships with
   Sakk, `prices/snapshot.json`, is trimmed from LiteLLM's public price list
   (MIT, by Berri AI); its `source` block records the URL, commit, SHA-256
   and the date it was fetched (2026-10-28 for 0.4.0). `sakk prices` shows
   the table in use.
3. The day follows your time zone, or the one you set with
   `sakk cap set <usd> --zone <IANA>`. A log line dated in the future, or
   first seen after its day, is counted on the day Sakk sees it.

It is not your invoice: plan pricing, discounts and anything not written to
the local logs are not in it. Spend that has been counted stays counted for
the day, even if the log is edited or deleted.

A model missing from the table is never guessed. The cap then refuses with
`PRICE_UNKNOWN`, because it cannot show that spend is under the cap. To add
a price, copy `prices/snapshot.json` to `~/.sakk/prices.json` and add the
model there. That file replaces the shipped table whole instead of adding to
it, so always start from a copy.

## What does "halt" do?

`sakk halt --by <name>` is the kill switch. It refuses every new guarded
tool call, whatever the cap says; reading files inside the project stays
allowed. `--agent <id>` stops one agent instead of all. The halt is kept in
the spend ledger, so run `sakk init` once first, and code that books spend
through the ledger is refused too (`LEDGER_HALTED`, `AGENT_HALTED`).

`--by` is a name you type; Sakk records it as given and does not check who
you are. While a halt is on, `sakk status` shows it and exits 4. Only a
person at a terminal lifts it: `sakk resume --by <name>` asks you to type
`resume`, the guard denies an agent that tries to run it, and the console
never resumes.

## What licence is Sakk under?

Apache-2.0. See the LICENSE and NOTICE files in the repository.

## How do I contribute?

Read `CONTRIBUTING.md`. Contributions use the Developer Certificate of
Origin ([DCO](https://developercertificate.org/)): add a sign-off line to
each commit with `git commit -s`, which states that you have the right to
submit the work under the project's licence. Every change in behaviour comes
with a test; run `npm test` before you open a pull request.

## Is there an enterprise edition?

Coming soon. It is not part of the open-source project and none of it is in
this repository; features such as regulation case packs were moved out of
the open core for it. Everything in this repository is the open-source
edition.

## Does the console have a login?

A basic one, and it is optional. By default the console is protected by a
random token in the address `sakk ui` prints, and it listens on 127.0.0.1
only, so treat the address like a password. `sakk ui --set-password` adds a
username and a password (15 or more characters, asked at a terminal); after a
restart of `sakk ui`, `http://127.0.0.1:<port>/` asks for them, and the token
address still works. A password sign-in can read the console but not stop an
agent: stopping still needs `--allow-halt` and the token address. A session
ends after 30 minutes idle or 8 hours. After five wrong tries within 15
minutes, sign-in refuses until that window has passed. `sakk ui --clear-password` turns it off. SSO, team accounts and
named approvers are not in the open-source edition.
