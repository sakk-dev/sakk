# Decide — agent guard (open-source v1, M1)

**Go.** Blueprint line: open-source v1 headline 1, "the agent guard"
(decided 2026-10-21; target design v10). Demand evidence:

- Destructive-command guards are the second-fastest-growing category of
  open-source tools for coding agents (dcg about 6,200 stars;
  cc-safety-net about 59,000 npm downloads a month).
- Claude Code's own data: 93% of permission prompts are approved, and auto
  mode misses 17%.

Decisions taken by the owner on 2026-10-21 (development plan, seven items):

1. Node 20 or later.
2. Hook errors deny.
3. An `ask` that cannot be answered (Codex) is a deny.
4. Claude Code, Cursor and Codex are all supported in v1.

Not borrowed: dcg's licence rider excludes Anthropic, so its rules are not
used. cc-safety-net (MIT) is studied for its tokenizer and wrapper
unwrapping. No code is copied without its licence notice.

**Owner sign-off needed before M1 merges:** this is a core area (it decides
for the kernel's callers), so the contract and the independent review apply.
