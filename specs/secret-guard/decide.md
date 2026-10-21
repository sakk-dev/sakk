# Decide — secret guard (M3)

**Go.** Blueprint line: open-source v1 headline 3, "the secret guard"
(decided 2026-10-21).

Evidence: GitGuardian's 2026 report finds secrets in 3.2% of Claude Code
commits, against a 1.5% baseline. The gitleaks rule set is MIT-licensed and
is the de-facto standard.

Owner decision, 2026-10-21: Node 20 or later, so the 38 rules that use
scoped modifiers are rewritten rather than requiring Node 23.

The C-13 stopline debt (due 2026-10-28) is paid by this milestone's
both-sided corpus. If M3 cannot land by then, the class detector lands
alone first.
