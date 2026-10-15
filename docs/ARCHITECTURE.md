# Sakk Architecture

Sakk is two trust roots and the seams around them. This file is the map; the
code is the contract (every rule named here has a test, and the critical ones
have mutation drills — `npm run drill`).

```
sakk/
├── src/ledger.mjs          # trust root 1: fail-closed spend ledger
├── test/                   # ledger suite (incl. a real 2-process race)
├── eval/                   # trust root 2: gold eval harness
│   ├── bin/gold-runner.mjs #   orchestrates: validate / dry-run / fake / real
│   ├── lib/                #   scorer, trace, paid-step gate, env scrub, schema validator
│   ├── cases/              #   12 case definitions (what the agent is asked)
│   ├── fixtures/           #   what the agent SEES (one micro-repo per case)
│   ├── gold/               #   how the agent is JUDGED (never enters fixtures;
│   │                       #   SHA-256 manifest verified at startup)
│   ├── fake/agents/        #   scripted well-behaved agents (harness validation)
│   ├── examples/           #   injectable reference modules (approval gate)
│   └── schemas/            #   case / trace / metrics JSON Schemas
└── scripts/mutation-drill.sh  # proves the judge can fail
```

## Trust root 1: the ledger

One JSON file, one rule: **no successful reservation, no paid action.**
`reserve → (spawn) → settle` with the hard cap and the reservation reading
from the same variable. Every pathological state refuses: cap reached,
duplicate `callId`, unreadable/stale/wrong-schema ledger, unknown actual cost
(→ `RECONCILIATION_REQUIRED`, which halts all further reservations until a
named human clears it). Writes are temp+rename under an atomic mkdir lock.

## Trust root 2: the eval harness

Grades agent work from machine facts only — the runner's own git diff, the
exit codes of verification commands the runner re-runs itself, the ledger on
disk. The agent's self-report is cross-checked, never trusted; a claim/reality
mismatch is itself a failure. Gold answers live outside the agent-visible
surface and are integrity-checked by manifest. Real-model execution sits
behind a fail-closed authorization chain (file → provider/model → scope and
budget binding → authoritative ledger → reviewer labels → manifest → written
closure attestation → isolated work root); in a fresh checkout it is
structurally unreachable, by design.

## The seams (how the two first versions coexist)

The same core must serve **v1-open** (this repo, shipping today) and
**v1-enterprise** (closed modules — on the roadmap, none shipped yet)
without forking. The "Enterprise plug-in" column below is therefore
forward-looking by design: the seams are named and kept honest now so that
closed capability plugs in later instead of patching the core:

| Seam            | Mechanism                                                   | Open default                        | Enterprise plug-in                          |
| --------------- | ----------------------------------------------------------- | ----------------------------------- | ------------------------------------------- |
| Approval gate   | `GOLD_GATE_MODULE` (module path, injected per run)          | `eval/examples/approval-gate.mjs`   | four-eyes approval service, RBAC/SSO-backed |
| Org ledger      | `SAKK_BUDGET_LEDGER_PATH` (env)                             | any sakk ledger file                | hash-chained, externally anchored ledger    |
| Ledger location | `SAKK_LEDGER_PATH` / explicit `ledgerPath` — never implicit | local file                          | VPC-mounted, access-controlled store        |
| Scoring policy  | `gold/<case>/scoring.json` overlays on case defaults        | shipped cases                       | regulated-scenario policy packs             |
| Executor        | `CLAUDE_BIN` (binary path)                                  | any CLI with `--output-format json` | pinned, audited executor builds             |
| Evidence        | runner-owned out-dir (traces, logs, results, metrics)       | replay by hand                      | report generator, auditor portal            |

Rules for keeping the seams honest:

1. **The core never imports enterprise code.** Enterprise modules implement
   the seam contracts; dependency arrows point inward only.
2. **Money semantics live in the open core only.** A closed module may refuse
   _more_, never spend more — caps, duplicate refusal, and reconciliation are
   not overridable.
3. **Every seam keeps a working open default**, so the open product is
   complete on its own and every enterprise claim is testable against the
   open reference implementation.

## Engineering conventions

- Plain Node ≥ 20, ES modules, **zero runtime dependencies** — auditability
  is the product.
- Conventional Commits, SemVer, Keep-a-Changelog (see CONTRIBUTING.md).
- Prettier for formatting (`npm run format:check`, enforced in CI).
- Fail-closed by default: unknown states refuse; refusals carry stable
  machine codes (`LedgerError.code`, gate refusal codes) that are part of the
  public API and covered by tests.
