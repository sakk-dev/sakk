# Decide — spend from local logs, with a daily cap (M2)

**Go.** Blueprint line: open-source v1 headline 2, "a spend cap" (decided
2026-10-21).

Demand evidence: cost trackers are the largest category of open-source
tools for coding agents.

- ccusage: about 19,100 stars and 871,000 npm downloads a month.
- codeburn: about 11,500 stars, the fastest-growing at about 1,800 a month.

None of them stops spending. Sakk does: "ccusage tells you; Sakk stops you".

Owner decisions, 2026-10-21:

- Spend is read from local logs, not from a proxy.
- The price table is a bundled snapshot plus a manual override in
  `$SAKK_HOME/prices.json`. (The fetching updater subcommand named in the
  original decision was never built and was retracted — F-175, D11
  2026-10-29.)
- The cap applies at the next tool call.

**Money area:** independent adversarial review before merge (CONSTITUTION #3).
