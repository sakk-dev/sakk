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
