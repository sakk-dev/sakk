# specs/

Working agreements that precede code (v3 pipeline).

- `retro/` — three-tables + acceptance contracts written for remediation
  batches (adversary table · input-space table · evidence-source
  declaration · converge contract). Template: any file in here.
- `<feature>/` — for 🔒L2 blocks and larger L1 features: `decide.md`
  (go / needs-clarification / kill, with the blueprint line it serves),
  `spec.md` (what & why), `plan.md` (how), `contract.md` (acceptance:
  what will be delivered and how it is verified — agreed BEFORE coding).

A core-area PR is reviewed against its specs/ entry; "done" means
**converged** against the contract, not tests-green.

## Open-source v1 (decided 2026-10-21)

Target design: `../sakk-console-prototype-v10/` (frozen). There is one pull
request per milestone, and each lands its tests and passes review before
the next one starts.

| Milestone | Spec            | What it delivers                                                         |
| --------- | --------------- | ------------------------------------------------------------------------ |
| M0        | this folder     | the four specs below, each with three tables and a contract              |
| M1        | `guard/`        | `sakk hook`, the classifier, the default policy, install, try, doctor    |
| M2        | `spend/`        | spend from local logs, prices, the daily cap (money: independent review) |
| M3        | `secret-guard/` | the gitleaks rule port, plus secret checks in the hook                   |
| M4        | `console/`      | `sakk ui`, local and read-only                                           |
| M5        | —               | release: npm package, Claude Code plugin, README quick start             |

Stopline debt that must be paid on the way (`findings/classes.json`):

- **C-04, by 2026-10-28.** A counter-bounded cost detector for every
  exported matcher and ledger operation. It is task 0 of M1, before the
  classifier.
- **C-13, by 2026-10-28.** The both-sided corpus for every detection rule
  set. It is M3 task 4; if M3 is not ready by then, it lands alone first.
