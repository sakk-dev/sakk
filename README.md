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

| Situation                                         | Sakk's answer                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Budget would reach the cap                        | **Refused.** The cap is a wall, not a target — reaching it counts as crossing it.                                               |
| Same `callId` reserved twice                      | **Refused.** Deduplicated billing with re-executed side effects is how money leaks.                                             |
| Ledger missing / corrupted / stale / wrong schema | **Refused.** A broken ledger is never "zero spend so far".                                                                      |
| Actual cost unknowable after a failure            | **No fake numbers.** The entry enters reconciliation, a global flag halts all further paid calls until a named human clears it. |
| Lock held by another process                      | **Refused after timeout.** The budget is never judged without mutual exclusion.                                                 |
| Ordinary read failure                             | **Never auto-creates an empty ledger.** "Lost ledger equals free money" is the exact back door this tool exists to close.       |

Two concurrent agents cannot jointly overspend: read-modify-write runs under an atomic lock, writes are temp+rename, and there is a real two-process race in the test suite to prove it (`test/ledger.test.mjs`, "two concurrent reservations cannot jointly overspend").

## Install

```bash
npm install sakk        # or call the CLI without installing: npx sakk …
```

## Quickstart

```bash
npx sakk init --cap 25          # create ./sakk-ledger.json (refuses to overwrite)
npx sakk status                 # totals, entries, reconciliation state (--json for machines)
npx sakk reconcile --by alice   # clear a reconciliation halt — takes a name
```

Every command accepts `--ledger <path>` (default: `./sakk-ledger.json`, or
`SAKK_LEDGER_PATH`).

`sakk status` exits 3 while reconciliation is required — gate your CI on it.

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
next to it. Writes are fsync'd before an atomic rename — the gate's decision
survives power loss.

The API is deliberately **synchronous** (lock waits block up to ~2s): correct
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

If a process crashes while holding the lock, the next caller detects the
dead owner (same host) and breaks the lock automatically; anything it cannot
judge stays locked until `npx sakk unlock --by <your-name>`.

**Auditors**: [docs/AUDITOR_REPLAY.md](docs/AUDITOR_REPLAY.md) — what you can
verify on your own clean machine in under 30 minutes, without trusting us.

## API

`initLedger · reserve · settle · markReconciliationRequired · clearReconciliation · forceUnlock · readLedger · totalsOf · LedgerError (every refusal carries .code and .details)`

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
`POLICY_VACUOUS_ALLOW` (a gate that can only say yes), `POLICY_RULE_SHADOWED`
(provably dead rules), `CONTEXT_INVALID` (no coercion — and no path aliases:
a non-canonical scope like `prod//x` refuses outright rather than sliding
past a deny; normalizing paths and unicode before calling `decide()` is the
enforcer's job), `POLICY_TOO_COMPLEX` (bounded by refusal, never by
hanging), `DECISION_UNLOGGABLE`
(an unauditable allow is a deny). Two reference policies ship in
[`policies/`](policies/) — a permissive dev profile and a regulated
three-tier profile. The kernel never imports the ledger and never performs
actions; an enforcer composes the two: `decide()` → on `allow` only →
`reserve()`.

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
books live is not a gate). `--policy` is optional; when set, every
`sakk_reserve` is decided by the policy kernel first and every decision —
allow and deny alike — lands hash-pinned in `sakk-decisions.jsonl` next to
the ledger. `require_approval` refuses over MCP by design (approval
collection is an enterprise concern, not an agent tool). The server adds
no semantics: replaying the same calls through the library yields
byte-identical books, and the test suite proves it.

## Roadmap — honest edition

- [x] CLI (`sakk init / sakk status / sakk reconcile / sakk unlock`)
- [x] Eval harness: gold cases with mutation-tested scoring (the judge gets judged) — ships in [`eval/`](eval/)
- [x] Policy kernel (`sakk/policy`): declarative `sakk-policy.v1`, pure `decide()`, hash-pinned decision log
- [x] MCP server enforcer (`sakk mcp`): reserve/settle/status as tools, policy-gated
- [ ] `sakk settle` CLI command (late settlement without writing code)
- [x] Evidence bundles: one .tgz per run with a manifest and its own zero-dependency verifier — auditors check it without the repository ([docs/AUDITOR_REPLAY.md](docs/AUDITOR_REPLAY.md) §6)
- [ ] Hash-chained (tamper-evident) ledger mode — enterprise
- [ ] Named-approver identity, SSO — enterprise

Not planned: orchestration frameworks, model-level safety (prompt-injection detection), dashboards. Sakk is the change-control and evidence layer, not another agent platform.

## License

AGPL-3.0-only. Commercial licenses (closed-source embedding, enterprise features) are available — open an issue or contact the author. Contributions require a CLA (see CONTRIBUTING.md).

---

_Sakk (صك): a written promise that the money is really there. Now your agents make the same promise._
