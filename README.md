# Sakk

> **The original check, rebuilt for AI agents.**

In medieval Arab commerce, a **ṣakk** (صك) was a written order of payment — a merchant's promise backed by real funds, honored across the trade routes. The word traveled through Persian and Latin into English as _cheque / check_. Its plural, _sukuk_, still names the Gulf's financial instruments today.

English kept both meanings: a **check** you write (money) and a **check** you run (verification). AI agents need exactly those two things, welded together. That is Sakk:

**a fail-closed spend ledger for AI agents — no reservation, no spawn; no proof, no pass.**

## Why

Agents spend real money and report their own success. Both are problems:

- A retry loop at 3 a.m. is indistinguishable from a working agent — until the invoice.
- "All tests pass" from an agent that never ran the tests looks identical to the real thing.

The ledger closes the first gap. The eval harness in [`eval/`](eval/) grades the second from machine evidence (portable evidence packs are on the roadmap). Every potentially paid action must **reserve** against a capped ledger _before_ it runs, and **settle** with the real cost after. Everything pathological refuses:

| Situation                                         | Sakk's answer                                                                                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budget would reach the cap                        | **Refused.** The cap is a wall, not a target — reaching it counts as crossing it.                                                                   |
| Same `callId` reserved twice                      | **Refused.** Deduplicated billing with re-executed side effects is how money leaks.                                                                 |
| Ledger missing / corrupted / stale / wrong schema | **Refused.** A broken ledger is never "zero spend so far". Stale = not confirmed for 7 days; a person revives it with `sakk reconcile --by <name>`. |
| Actual cost unknowable after a failure            | **No fake numbers.** The entry enters reconciliation, a global flag halts all further paid calls until a named human clears it.                     |
| Lock held by another process                      | **Refused after timeout.** The budget is never judged without mutual exclusion.                                                                     |
| Ledger reached through a symlink or hard link     | **Refused** (`LEDGER_PATH_NOT_CANONICAL`). A write would replace the link and fork the books; use the one real path.                                |
| Ordinary read failure                             | **Never auto-creates an empty ledger.** "Lost ledger equals free money" is the exact back door this tool exists to close.                           |

Two concurrent agents cannot jointly overspend: read-modify-write runs under an atomic lock, writes are temp+rename, and a real race proves it: eight processes started together reserve against one cap, and every grant must be booked with nothing past the cap (`test/ledger.test.mjs`, "8 concurrent processes cannot jointly overspend"; mutation drill MUT-Z removes the lock and the race goes red).

## Install

```bash
npm install sakk        # or call the CLI without installing: npx sakk …
```

## Guard a coding agent

```bash
sakk guard install claude-code   # or: cursor, codex
sakk doctor                      # checks the hook really fires
sakk try 'git push --force origin main'   # what the guard would answer
```

Every Edit, Write and shell call of the agent is judged before it runs:
force pushes, deletes outside the project, reading secrets and deploys are
refused or asked by a policy you can read and change. A write whose content is
a secret, or a command that prints one, is denied too. The guard judges a
command by what it spells out — see the limits at the end of this page and
[docs/GUARD.md](docs/GUARD.md).

Or add Sakk to Claude Code as a **plugin** — it bundles the same hook,
fail-closed (`onFailure: block`):

```bash
npm install -g sakk
claude plugin install --plugin-dir "$(npm root -g)/sakk"
```

See what the guard did in a local, read-only console — today's spend and cap,
recent decisions, the policy with a try box, and secret blocks:

```bash
sakk ui        # prints http://127.0.0.1:<port>/?t=… — read-only; Ctrl+C to stop
```

Cap the day's spend (read from Claude Code's local logs — an estimate, not the invoice). A person sets it. The guard denies the agent a `sakk cap` command and a write to `~/.sakk`, and a one-command symlink chain that would reach it needs a person's approval. At the terminal, lifting the cap, raising it or moving its day asks you to retype a word; with no terminal it refuses with `HUMAN_CONFIRMATION_REQUIRED` and changes nothing. A path held in a shell variable is not caught yet — see the limits at the end of this page:

```bash
sakk cap set 5 --zone Asia/Dubai   # deny paid calls once today's spend reaches $5
sakk spend                         # today's spend by model
sakk cap off                       # lift it (asks you to confirm)
sakk prices                        # the price table in use, and where it came from
```

The per-token rates ship in `prices/snapshot.json`, regenerated from the
public [LiteLLM price table](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
(MIT) — the file's `source` block records the exact commit and SHA-256 it was
built from, and `sakk prices` prints that provenance. They are community
figures, an estimate and not any provider's invoice. A model the table does
not list is **not guessed**: it prices to nothing, and the cap then fails
closed for the day (`PRICE_UNKNOWN`) rather than undercount your spend. To
override a rate or add a model, drop a `sakk-prices.v1` table at
`~/.sakk/prices.json` (a user table wins over the shipped one, and a malformed
one is refused, never silently ignored); maintainers refresh the shipped
snapshot by re-running `scripts/prices-trim.mjs` against the LiteLLM table.

## Quickstart

```bash
npx sakk init --cap 25          # create ./sakk-ledger.json (refuses to overwrite) and wire it to the guard
npx sakk status                 # totals, entries, reconciliation state (--json for machines)
npx sakk reconcile --by alice   # clear a reconciliation halt — takes a name
npx sakk ledger verify          # check the sealed history's hash chain (exit 1 if broken)
```

The ledger commands (`init`, `status`, `reconcile`, `halt`, `resume`,
`unlock`, `mcp`, `ledger verify|export`) accept `--ledger <path>`. Without
it they use the absolute path `sakk init` recorded in `~/.sakk/config.json`
(the guard hook reads the same entry), then `SAKK_LEDGER_PATH`
(set-but-empty refuses), then `./sakk-ledger.json`. `mcp` still needs the
flag or the variable.

Settled entries are sealed into an append-only, hash-chained cold trail
(`<ledger>.cold/`) so the live file stays small and a call costs the same
whatever the history; nothing is capped and no entry is dropped.
`sakk ledger verify` walks the chain, `sakk ledger export` rebuilds one flat
ledger. At most 10,000 reservations may be outstanding at once.

`sakk status` exits 3 while a person must act before spending resumes —
reconciliation required (flag or entry), or a stale ledger — and 4 while
globally halted; gate your CI on it. `max_reservable_usd` is 0 whenever
every reserve would refuse.

In code:

```js
import { initLedger, reserve, settle, LedgerError } from 'sakk';

const ledgerPath = './ledger.json';
initLedger({ ledgerPath, capUsd: 25 }); // explicit — ledgers are never created implicitly

// before every paid action. reserve() THROWS a LedgerError on refusal
// (e.code names the reason) — if it returns, the money is reserved:
try {
  reserve({ ledgerPath, callId: 'task-42:call-1', estimatedMaxUsd: 1.5 });
} catch (e) {
  if (e instanceof LedgerError) return skipThisAction(e.code); // do NOT call the model
  throw e;
}
const result = await callYourModel();
settle({ ledgerPath, callId: 'task-42:call-1', actualUsd: result.costUsd });

// if the cost could not be determined:
settle({ ledgerPath, callId: 'task-42:call-1', failedUnknownCost: true });
// → ledger enters RECONCILIATION_REQUIRED; every further paid call refuses.
// To recover, a human first settles the open entry with the figure they
// decided on (the invoice amount, or a write-off) — clearing refuses while
// any entry is still open (RECONCILIATION_ENTRIES_OPEN):
settle({ ledgerPath, callId: 'task-42:call-1', actualUsd: 0.4 });
clearReconciliation({ ledgerPath, by: 'your-name' });
```

Zero dependencies. Plain Node (≥20) on **macOS or Linux** (the lock and the
tooling are POSIX; Windows is not supported yet). The ledger is a
human-readable JSON file; alerts append to a greppable `sakk-alerts.jsonl`
next to it (never written through a planted symlink). Writes are fsync'd
before an atomic rename. On Linux that survives power loss; on macOS fsync
does not flush the drive cache (Node has no F_FULLFSYNC), so a power cut can
lose the last writes there.

The API is deliberately **synchronous** (lock waits block up to ~3s): correct
for CLIs, hooks and per-task processes. Inside a long-running async server,
call it from a worker thread. Ledgers are single JSON files scanned per call
— right for hundreds-to-thousands of entries per ledger; archive or rotate
beyond that (a hash-chained ledger mode — enterprise, on the roadmap — is
the designed scale path).

Practical notes, earned the hard way:

- **`estimatedMaxUsd`** = the worst case the provider can bill for this one
  call (e.g. max output tokens × price, or the provider's own budget cap
  parameter). Too high parks budget; too low is dishonest — the cap check
  runs against estimates until settlement corrects them.
- **Crash between reserve and settle?** The reservation stays outstanding
  and keeps occupying the cap — correctly, because the money may genuinely
  have been spent. Recover by settling the **same `callId`** from any
  process: `settle({ ledgerPath, callId, actualUsd })` once you know the
  figure, or `failedUnknownCost: true` if it is unknowable (which halts the
  ledger for a human). A `sakk settle` CLI command is on the roadmap; today
  late settlement is a three-line Node script.
- **`markReconciliationRequired`** is for out-of-band discoveries — an
  invoice that disagrees with the books, a provider incident. It halts all
  further reservations until a named human clears the flag.

If a process crashes while holding the lock, the next caller usually detects
the dead owner (same host) and breaks the lock automatically. A crash in the
few microseconds while the lock is being created or released leaves a lock
it cannot judge (measured: about 3 in 100 SIGKILLs); that stays locked —
fail-closed — until `npx sakk unlock --by <your-name>`. One ledger directory
must not be shared across hosts: the dead-owner check compares hostnames.

**Auditors**: [docs/AUDITOR_REPLAY.md](docs/AUDITOR_REPLAY.md) — what you can
verify on your own clean machine in under 30 minutes, without trusting us.

## API

`initLedger · reserve · settle · halt · resume · markReconciliationRequired · clearReconciliation · forceUnlock · readLedger · totalsOf · LedgerError (every refusal carries .code and .details)`

Accounting rule: `settled actuals + outstanding reservations (at estimated max) + this estimate >= cap ⇒ refuse`.

### `sakk/policy` — the decision kernel

```js
import { loadPolicy, decide, logDecision, PolicyError } from 'sakk/policy';
```

A declarative, hash-pinned answer to _"may this agent do this action at this
cost?"_, decided **before** any reservation exists. `decide()` is pure: same
policy bytes + same context → same verdict on any machine, and every logged
decision carries the SHA-256 of the policy file that produced it — "why was
this allowed on March 3rd?" is answered by replay, not by trust. Policy files
(`sakk-policy.v1`, plain JSON) read top-to-bottom, **first match wins**, the
`default_verdict` is mandatory, and everything pathological refuses:
`POLICY_VACUOUS_ALLOW` (a gate that can only say yes: no rule that refuses
under a default allow, or a first rule that allows everything),
`POLICY_RULE_SHADOWED` (provably dead rules), `POLICY_SCHEMA_INVALID` (also
for a `*` inside an agent or action name — only the exact `*` is a
wildcard), `CONTEXT_INVALID` (no coercion — and no path aliases: a
non-canonical scope like `prod//x` refuses outright rather than sliding
past a deny), `POLICY_TOO_COMPLEX` (bounded by refusal, never by hanging),
`DECISION_UNLOGGABLE` (an unauditable allow is a deny).

Two limits to know before relying on a deny:

- **Under `default_verdict: allow`, a deny constrains only what the caller
  declares.** A rule on `scope` or `action` does not match a request that
  omits that field, so the request falls through to the allow default. Use
  a deny default (like `policies/regulated-strict.json`) when the caller is
  the party being constrained.
- **Paths are compared byte for byte.** The kernel and the MCP enforcer do
  not fold case, resolve symlinks or normalize unicode: on a
  case-insensitive volume (the macOS default) `Prod/api` is `prod/api` on
  disk but not to the policy. Normalize before calling `decide()`, or use a
  deny default. Two reference policies ship in
  [`policies/`](policies/) — a permissive dev profile and a regulated
  three-tier profile. The kernel never imports the ledger and never performs
  actions; an enforcer composes the two: `decide()` → on `allow` only →
  `reserve()`.

## Kill switch

```bash
npx sakk halt --by alice --reason "runaway agent"   # every new reservation refuses
npx sakk halt --by alice --agent bot-7              # stop one agent only
npx sakk resume --by alice                          # lift it (named)
```

`sakk init` records the ledger's absolute path in `~/.sakk/config.json`,
so a halt also stops an agent behind the installed guard: every tool call
except reading the repository is denied until `sakk resume`. Running `init`
again wires an existing ledger without touching it, and never replaces a
different recorded path — it says which ledger the hook still reads.
Because it decides where the hook reads halts from, the guard denies the
agent `sakk init`, as it denies `sakk cap`; a person runs it.

While halted, `reserve()` refuses `LEDGER_HALTED` (or `AGENT_HALTED`),
every reservation the halt refuses is logged to `sakk-alerts.jsonl`
(attempts refused earlier for another reason — an invalid agent id, a stale
ledger — carry their own code and are not halt alerts), and `sakk status`
shows who stopped it and, for a global halt, exits 4 — so CI stops too
(per-agent halts are listed, exit 0: other agents may still spend). In-flight calls can
still settle their real cost. The halt cannot be lifted by any money
operation, only by `resume`; agents cannot resume themselves over MCP. A
stale ledger or one in reconciliation can still be halted. Per-agent halts
match the agent id exactly (case-sensitive, code point for code point — no
Unicode normalisation, so `café` typed two ways is two ids) and rely on the
id the caller
declares when it reserves — an agent that switches ids escapes a per-agent
halt; the global halt is the hard stop. The first halt upgrades the ledger
file to schema `sakk-ledger.v2`, which earlier sakk versions refuse to read:
an old binary can never spend through a stop it does not understand.

## Secret scanning

```bash
npm install --save-dev sakk     # the hook runs THIS installed copy — not npx
npx sakk scan src config        # scan paths; exit 1 if anything is found
npx sakk scan --install-hook    # refuse commits and merge commits that contain secrets
```

It recognizes eight formats: database URLs with a password (`postgres`,
`postgresql`, `mysql`, `mariadb`, `mongodb`, `mongodb+srv`, `redis`, `rediss`,
`amqp`, `amqps`, `mssql`, `sqlserver`), URL-encoded passwords in any URL,
AWS access keys, API keys shaped `sk_live_…`/`sk_test_…`/`rk_live_…`/`rk_test_…`,
`sk-`/`sk_`/`rk-`/`rk_` followed by at least 20 characters that include a
digit, or `sk-` followed by at least 40 (so `sk_set_flags` does not match,
but a long identifier that starts `sk_` and contains a digit does), GitHub
tokens (classic and fine-grained), private-key blocks (PEM and PGP), bearer tokens, and
quoted `password = "…"` assignments. It does NOT catch secrets in any other
shape — an unquoted `.env` line such as `PASSWORD=hunter2hunter2`, other URL
schemes, a bare random string, personal data. A reference to a secret in
the secret's place (`${REDIS_PASSWORD}`, `$PW`, `%(pw)s`, `{{ pw }}`) is not
reported. A clean scan means "none of these formats", not "no secrets".

Findings print the rule, path, line and a 12-character keyed fingerprint —
never the secret. The key is random per run; set `SAKK_SCAN_KEY` (and keep
it private) when you need to compare fingerprints across runs. A file name
that itself contains a secret is printed redacted and counted as a finding;
control characters in names are printed escaped. The only exemption is a
secret that declares itself fake by containing
`TEST_ONLY_FAKE_SECRET_DO_NOT_USE` with nothing secret-shaped beside it;
there is no localhost exception.

Exit codes: 0 clean, 1 findings, 2 the scan could not do its job — a path
that does not exist (`SCAN_PATH_MISSING`), a file it could not read, a fifo
or device, or anything over 256 MB (`SCAN_UNREADABLE`), not a git repository,
git missing, an existing or unwritable hook, `--staged` combined with paths
(`SCAN_USAGE`). Paths you name are always scanned (even `dist/`, even
through a symlink); inside them, `node_modules`, `.git`, `.next`, `dist`,
symlinks, binary files and files named like media or archives (`.png`,
`.jpg`, `.gif`, `.zip`, `.gz`, `.tgz`, `.woff`, `.ico`, `.mp4`, `.bundle` —
by name, not content) are skipped and the skips are counted in the
summary. UTF-16 and UTF-32 files (with a byte-order mark) are scanned as
text.

`--staged` scans exactly what the commit would record — every added,
modified or type-changed blob in the index, wherever you run it from;
a staged symlink's target counts as content (replace refs are ignored: the
bytes scanned are the bytes the commit records). `--install-hook` writes
pre-commit and pre-merge-commit hooks (git 2.24+) that run the installed
sakk by absolute path. No git hook sees fast-forward merges, rebases,
cherry-picks or `--no-verify` — run `sakk scan .` in CI as well. It
refuses if either hook already exists (even a dangling symlink) and then
installs neither, and it refuses to install from a temporary `npx`,
`bunx` or `pnpm dlx` cache (`SCAN_HOOK_EPHEMERAL`) — that copy disappears
when the cache is cleaned. The hook pins node's real path: after a node
upgrade (Homebrew, nvm) or moving sakk, commits refuse with
`SCAN_HOOK_STALE` until you re-run `--install-hook`.

## MCP: put the gate in front of any agent

`sakk mcp` speaks the Model Context Protocol over stdio — the same three
operations as the library, as tools an agent must call. Claude Code
config (Cursor/Copilot analogous):

```json
{
  "mcpServers": {
    "sakk": {
      "command": "npx",
      "args": [
        "sakk",
        "mcp",
        "--ledger",
        "/abs/path/ledger.json",
        "--policy",
        "/abs/path/policy.json"
      ]
    }
  }
}
```

The ledger path is REQUIRED (no cwd default — a server guessing where the
books live is not a gate). `--policy` (or `SAKK_POLICY_PATH`; set-but-empty
refuses) is optional; when set, every
`sakk_reserve` is decided by the policy kernel first and every decision —
allow and deny alike — lands hash-pinned in `<ledger>.decisions.jsonl` next to
the ledger. `require_approval` refuses over MCP by design (approval
collection is an enterprise concern, not an agent tool). The server adds
no semantics: replaying the same calls through the library yields the same
entries (callId, status, amounts — timestamps differ by construction), and
the test suite proves it. A policy `allow` is a decision, not a
reservation: the ledger can still refuse it (a zero estimate, for one), so
count reservations from the books, not allows from the decision log.

## Roadmap — honest edition

- [x] CLI (`sakk init / status / reconcile / unlock / halt / resume / scan / mcp`)
- [x] Eval harness: gold cases with mutation-tested scoring (the judge gets judged) — ships in [`eval/`](eval/)
- [x] Policy kernel (`sakk/policy`): declarative `sakk-policy.v1`, pure `decide()`, hash-pinned decision log
- [x] MCP server enforcer (`sakk mcp`): reserve/settle/status as tools, policy-gated
- [x] Kill switch (`sakk halt / resume`): named (self-declared `--by`), global or per agent; stop state provable from the books
- [x] Secret scanning (`sakk scan`, pre-commit hook): eight recognized formats, fingerprints only
- [x] Secret guard in the hook: a write whose content is a secret, or a command that prints one, is denied (open-source v1 M3; the gitleaks 222-rule port is pending)
- [x] Daily spend cap enforced by the hook from local transcripts, an estimate not the invoice (open-source v1 M2); set with `sakk cap set`
- [x] Local, read-only console `sakk ui`: spend, decisions, policy, secret blocks (open-source v1 M4)
- [x] Ships as a Claude Code plugin (`.claude-plugin/`) (open-source v1 M5)
- [x] `sakk cap set/off`, `sakk spend`, `sakk prices` — set the cap, see the day's spend, show the price table (F-161)
- [x] Case packs by regulation (CBUAE, DORA, DIFC — thematic, clause numbers unverified) with per-requirement verdicts
- [ ] `sakk settle` CLI command (late settlement without writing code)
- [x] Evidence bundles: one .tgz per run with a manifest and its own zero-dependency verifier — auditors check it without the repository ([docs/AUDITOR_REPLAY.md](docs/AUDITOR_REPLAY.md) §6)
- [ ] Hash-chained (tamper-evident) ledger mode — enterprise
- [ ] Named-approver identity, SSO — enterprise
- [ ] Team console: approvals, roles, audit export, outbound metering — enterprise (the local read-only `sakk ui` above is the open-source edition)

Not planned: orchestration frameworks, model-level safety (prompt-injection detection). Sakk is the change-control and evidence layer, not another agent platform.

Know these limits of the open core before relying on it:

The guard and the cap:

- **It reads a command as written.** A command built at run time — `eval`,
  backticks, `bash -c "$X"`, `python -c`, `source` — can only be asked or
  denied, never judged by what it does. A file the shell or a program picks at
  run time is judged by the name written in the command, so a read of `.env`
  spelled any other way is allowed: a glob (`cat .e*`), a brace
  (`cat .e{nv,x}`), a variable (`f=.env; cat $f`), `grep -r`,
  `find … -exec cat`, `xargs`. The same holds for a write, a delete or a flag
  held in a variable: `f=~/.sakk/config.json; rm $f` and
  `o=--force; git push $o` are not caught. A script the agent runs is one
  `shell.run` call.
  Only isolation (a container) answers what a command does.
- **`@` references skip the hook.** Files you @-mention in Claude Code are read
  without a tool call, so the guard never sees them.
- **The cap stops the next call, not the one that crosses it.** A response
  already in progress completes, so a running agent can go over by one
  response.
- **The logs are local files the agent can reach.** The cap reads Claude Code's
  transcripts; a direct write to them needs a person's approval and a write to
  `~/.sakk` is denied, but a script the agent runs is not inspected and can
  rewrite them. Spend already counted never goes down; spend not yet counted
  can be erased. A tamper-evident ledger is enterprise.
- **Older Claude Code fails open.** Before 2.1.295 a hook that times out or is
  killed lets the call run. `sakk guard install` says so and `sakk doctor`
  warns.
- **The confirmation checks for a terminal, not a person.** An agent whose
  shell runs in a pseudo-terminal, or a script it writes that opens one, can
  type the word. The guard asks before `script`, `expect` and `unbuffer`, and
  knows Sakk only by the name `sakk`: `npx sakk cap off` meets the
  confirmation but not the guard's deny. Named approvals are enterprise.

The ledger and the library:

- **Names are self-declared.** `--by` on halt, resume, reconcile and unlock
  records the name the operator typed; nothing authenticates it.
- **The ledger is in the agent's reach.** The guard allows a guarded agent to
  run `resume`, `reconcile` and `unlock`, and the default ledger
  (`./sakk-ledger.json`) is a project file the agent may write, so one agent
  can lift a halt on another. A global halt holds: it denies every call but
  reading.
- **Costs are what the caller reports.** `reserve()` and `settle()` book the
  amounts they are given; nothing reads the provider's usage yet.
- **Approval-required means refused.** A policy that asks for approval
  answers `POLICY_APPROVAL_REQUIRED`; the open core has no approval service.
- **Gating is voluntary.** An agent that never calls the MCP tools or the
  library is not gated.

## License

AGPL-3.0-only. Commercial licenses (closed-source embedding, enterprise features) are available — open an issue or contact the author. Contributions require a CLA (see CONTRIBUTING.md).

---

_Sakk (صك): a written promise that the money is really there. Now your agents make the same promise._
