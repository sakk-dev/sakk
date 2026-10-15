# Policy engine — decide

**Verdict: GO** (pending design-review signature — 🔒L2 gate: no
implementation before the signed review).

## Blueprint line served

P1 前置闸 · 策略引擎: "按 agent/仓/动作/金额分级, 声明式策略文件" — the
component every paying customer asks about first, and the direct
implementation of CBUAE's "risk-tiered human oversight" requirement
(low = auto-ledger, medium = sampled, high = held for approval).

## Why now

- It is the first 🔒L2 block, and the first full run of the v3 pipeline
  (specs → signed design review → converged implementation → signed PR).
- MCP server (next L1 block) is the first enforcer; designing the kernel
  before the enforcer keeps the dependency arrow inward.
- Open kernel + closed policy packs is the open-core line applied: the
  decision _mechanism_ must be auditable by anyone; the regulated-scenario
  _content_ is what enterprises pay for.

## Kill criteria (any of these ends the design, back to the maintainer)

- The kernel cannot stay zero-dependency (e.g. needs a YAML/regex engine).
- The design cannot avoid touching ledger money semantics (frozen core).
- A policy file cannot express the CBUAE three-tier mapping without
  per-customer code.

## Scope cut

IN: decision kernel (load/validate/hash/decide/log), policy file format
`sakk-policy.v1`, refusal codes, integration contract for enforcers.
OUT (explicitly): enforcement itself (MCP server / hooks — separate block),
approval service (enterprise), policy packs (enterprise), web editor,
ITSM/SIEM sync, policy distribution.
