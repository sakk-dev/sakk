# Sakk

> **The original check, rebuilt for AI agents.**

In medieval Arab commerce, a **ṣakk** (صك) was a written order of payment — a merchant's promise backed by real funds, honored across the trade routes. The word traveled through Persian and Latin into English as _cheque / check_. Its plural, _sukuk_, still names the Gulf's financial instruments today.

English kept both meanings: a **check** you write (money) and a **check** you run (verification). AI agents need exactly those two things, welded together. That is Sakk:

**a fail-closed spend ledger for AI agents — no reservation, no spawn; no proof, no pass.**

## Why

Agents spend real money and report their own success. Both are problems:

- A retry loop at 3 a.m. is indistinguishable from a working agent — until the invoice.
- "All tests pass" from an agent that never ran the tests looks identical to the real thing.

Sakk closes the first gap (the second is coming — see Roadmap). Every potentially paid action must **reserve** against a capped ledger _before_ it runs, and **settle** with the real cost after. Everything pathological refuses:

| Situation                                         | Sakk's answer                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Budget would reach the cap                        | **Refused.** The cap is a wall, not a target — reaching it counts as crossing it.                                               |
| Same `callId` reserved twice                      | **Refused.** Deduplicated billing with re-executed side effects is how money leaks.                                             |
| Ledger missing / corrupted / stale / wrong schema | **Refused.** A broken ledger is never "zero spend so far".                                                                      |
| Actual cost unknowable after a failure            | **No fake numbers.** The entry enters reconciliation, a global flag halts all further paid calls until a named human clears it. |
| Lock held by another process                      | **Refused after timeout.** The budget is never judged without mutual exclusion.                                                 |
| Ordinary read failure                             | **Never auto-creates an empty ledger.** "Lost ledger equals free money" is the exact back door this tool exists to close.       |

Two concurrent agents cannot jointly overspend: read-modify-write runs under an atomic lock, writes are temp+rename, and there is a real two-process race in the test suite to prove it.

## Quickstart

```bash
npx sakk init --cap 25          # create ./sakk-ledger.json (refuses to overwrite)
npx sakk status                 # totals, entries, reconciliation state (--json for machines)
npx sakk reconcile --by alice   # clear a reconciliation halt — takes a name
```

`sakk status` exits 3 while reconciliation is required — gate your CI on it.

In code:

```js
import { initLedger, reserve, settle } from 'sakk';

const ledgerPath = './ledger.json';
initLedger({ ledgerPath, capUsd: 25 }); // explicit — ledgers are never created implicitly

// before every paid action:
reserve({ ledgerPath, callId: 'task-42:call-1', estimatedMaxUsd: 1.5 });
const result = await callYourModel(); // only runs if the reservation succeeded
settle({ ledgerPath, callId: 'task-42:call-1', actualUsd: result.costUsd });

// if the cost could not be determined:
settle({ ledgerPath, callId: 'task-42:call-1', failedUnknownCost: true });
// → ledger enters RECONCILIATION_REQUIRED; everything halts until a human signs off:
// clearReconciliation({ ledgerPath, by: 'your-name' });
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
beyond that (the enterprise hash-chained ledger is built for scale).

If a process crashes while holding the lock, the next caller detects the
dead owner (same host) and breaks the lock automatically; anything it cannot
judge stays locked until `npx sakk unlock --by <your-name>`.

## API

`initLedger · reserve · settle · markReconciliationRequired · clearReconciliation · readLedger · totalsOf · LedgerError (every refusal carries .code and .details)`

Accounting rule: `settled actuals + outstanding reservations (at estimated max) + this estimate >= cap ⇒ refuse`.

## Roadmap — honest edition

- [x] CLI (`sakk init / sakk status / sakk reconcile`)
- [ ] Eval harness: gold cases with mutation-tested scoring (the judge gets judged) — extraction in progress
- [ ] Evidence packs: replayable, manifest-hashed run records for third-party audit
- [ ] Hash-chained (tamper-evident) ledger mode — enterprise
- [ ] Named-approver identity, SSO — enterprise

Not planned: orchestration frameworks, model-level safety (prompt-injection detection), dashboards. Sakk is the change-control and evidence layer, not another agent platform.

## License

AGPL-3.0-only. Commercial licenses (closed-source embedding, enterprise features) are available — open an issue or contact the author. Contributions require a CLA (see CONTRIBUTING.md).

---

_Sakk (صك): a written promise that the money is really there. Now your agents make the same promise._
