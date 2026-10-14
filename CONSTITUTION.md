# Sakk Constitution

Non-negotiable principles. Every session (human or AI) loads this; PRs are
checked against it. Full rulebook with sources and triggers: docs/RULES.md.

1. **Fail closed, no exceptions.** Unknown states refuse with a structured
   code. An empty selection, a missing field, an unreadable file is an
   error — never a silent green.
2. **Machine facts are the only evidence.** Self-reports (an agent's, a
   model's, this file's author's) may be cross-checked, never trusted.
   Every judgement declares its evidence source.
3. **Money semantics change only under adversarial review.** Any diff
   touching lock/reserve/settle/flags gets an independent reviewer that did
   not write it, before merge. The author's own tests do not count as review.
4. **Threat model before code** in core areas (money, evidence, isolation,
   concurrency): adversary table, input-space table, evidence-source
   declaration, acceptance contract — written first, checked at PR.
5. **Every fix ships its attack.** A bugfix lands with an attack-shaped
   regression test and reports verified / partial / failed. Same defect
   bounced twice → stop and redesign (no third patch).
6. **Zero runtime dependencies.** Auditability is the product. The ledger
   stays a human-readable file an auditor can grep.
7. **Done = converged**, not tests-green: implementation checked against the
   written contract, adversarial coverage included, docs consistent.
8. **The closed layer may only tighten.** Enterprise code plugs into named
   seams and can refuse more than the open core — never spend more.
