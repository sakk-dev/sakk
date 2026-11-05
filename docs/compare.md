# ccusage tells you, Sakk stops you

People who worry about what an AI coding agent spends or does usually reach for
one of four tools. They answer different questions, and most teams need more
than one. This page compares them as fairly as we can, including what Sakk does
not do. Facts about the other projects come from their public pages, read on
2026-11-01 (links at the end). If something here is out of date, open an issue
and we will correct it.

## The short version

- **ccusage** reports what Claude Code has spent, from the logs on your
  machine, by day, month, session and five-hour block. It is a report, not a
  gate.
- **Claude Code's own `/usage` and spend limits.** `/usage` shows what the
  session and the month have cost. The spend limits are enforced by Anthropic
  itself: workspace limits in the Claude Console for API users, and
  organization, group or member limits on Team and Enterprise plans. They are
  monthly and apply to the whole account or workspace.
- **Microsoft's Agent Governance Toolkit** is a governance layer that checks
  each agent action against policy before it runs, with agent identity and
  sandboxing. It ships a Claude Code plugin and installers for GitHub Copilot
  CLI and Codex CLI. It is broader than Sakk, MIT-licensed and in public
  preview. Its README describes no spend cap and no runtime secret blocking.
- **Sakk** sits in the hook of a coding agent you already use (Claude Code,
  Cursor or Codex) and refuses a tool call **before** it runs: a force push, a
  delete outside the project, a secret being read, written or printed, or any
  call once the day's estimated spend reaches your cap.

## Side by side

|                         | ccusage                                                 | Claude Code `/usage` and spend limits                                       | Agent Governance Toolkit                                                                  | Sakk                                                                              |
| ----------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| What it answers         | Where did the money go?                                 | What has this session or month cost, and has the account reached its limit? | Is this agent allowed to act, as whom, in what sandbox?                                   | May this coding agent run this call, now, at today's spend?                       |
| Refuses a call          | No                                                      | Yes, at Anthropic, once a monthly spend limit is reached                    | Yes: each action is checked against policy before it runs                                 | Yes, in the agent's pre-tool-use hook                                             |
| Daily spend cap         | No                                                      | No: the limits are monthly                                                  | No spend limit in its README                                                              | Yes: `sakk cap set`, refused with `SPEND_CAP_REACHED`                             |
| Spend figure comes from | Claude Code's local logs, priced by a model price table | Anthropic's own billing                                                     | Not covered here                                                                          | Claude Code's local logs, priced by `prices/snapshot.json` (from LiteLLM)         |
| Secrets                 | No                                                      | Not covered here                                                            | No runtime secret blocking in its README                                                  | Denies writing or printing a secret and reading secret files; `sakk scan` for git |
| Coding agents it guards | Reports on Claude Code                                  | Claude Code                                                                 | Claude Code (plugin), GitHub Copilot CLI and Codex CLI (installers); Cursor not mentioned | Claude Code, Cursor, Codex                                                        |
| Where it runs           | Your machine (Node CLI)                                 | Inside Claude Code and at Anthropic                                         | Your agent's process or a coding agent's plugin (packages for several languages)          | Your machine (Node 20+, zero dependencies, macOS and Linux)                       |

"Not covered here" means the public pages we read did not settle it, so we make
no claim either way.

## When to use which

- **You want to know where last week's money went.** Use ccusage. Its reports
  by day, month, session and billing block are good at that, and Sakk does not
  try to replace them. `sakk spend` shows one day at a time, by model.
- **You want a hard ceiling on the bill.** Use the spend limits Anthropic
  enforces: Console workspace limits if you pay per token through the API,
  admin-set limits on a Team or Enterprise plan. They are the invoice-side
  stop, monthly. Sakk's cap is a local daily estimate on top, and `/usage`
  shows where you stand.
- **You want identity, sandboxing and policy across many agents.** Look at the
  Agent Governance Toolkit, which also reaches Claude Code through its plugin.
  Sakk's open core has no identity service: names such as `--by` are
  self-declared.
- **You want an agent you already run to be refused before it overspends for
  the day, leaks a secret or force-pushes.** That is what Sakk is for:

```bash
npm install -g @sakk-dev/sakk
sakk guard install claude-code     # or: cursor, codex
sakk doctor                        # checks the hook really fires
sakk cap set 5 --zone Asia/Dubai   # deny paid calls once today's spend reaches $5
```

They combine well: ccusage for the report, Anthropic's limit for the monthly
ceiling, Sakk for the daily stop.

## What Sakk does not do

So that the table above is a fair fight, here is the other side. The full list
is in the README's limits section.

- **The cap is an estimate, not the invoice.** It reads Claude Code's local
  logs and prices them from a community price table. A model the table does
  not list is not guessed: the cap fails closed for the day (`PRICE_UNKNOWN`).
- **The cap stops the next call, not the one that crosses it.** A response
  already in progress completes.
- **The logs are local files the agent can reach.** A script the agent runs is
  not inspected and can rewrite them.
- **The guard reads a command as written.** A command built at run time
  (`eval`, `bash -c "$X"`) can only be asked or denied, never judged by what it
  does. Only isolation, such as a container, answers what a command does.
- **Older Claude Code fails open.** Before 2.1.295 a hook that times out lets
  the call run; `sakk doctor` warns.
- **The spend cap reads Claude Code's logs only.** The guard also covers Cursor
  and Codex, but Cursor keeps no local token log and Codex logs are read in a
  later release, so their spend is not capped yet.

## Sources

- ccusage: <https://github.com/ryoppippi/ccusage>
- Claude Code, manage costs effectively (`/usage`, Console workspace spend
  limits, Team and Enterprise spend limits):
  <https://code.claude.com/docs/en/costs>
- Microsoft Agent Governance Toolkit, repository and README (status, license,
  the Claude Code plugin and the Copilot CLI and Codex CLI installers):
  <https://github.com/microsoft/agent-governance-toolkit>; documentation:
  <https://microsoft.github.io/agent-governance-toolkit/>; launch coverage
  (2026-04-03):
  <https://www.helpnetsecurity.com/2026/04/03/microsoft-ai-agent-governance-toolkit/>
- Sakk's own claims: the [README](../README.md), [the agent guard](GUARD.md)
  and [spend and the daily cap](SPEND.md).
