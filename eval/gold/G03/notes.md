# G03 gold

Criteria: both BASELINE assertions present verbatim + new '' and '12.5' cases + tests green.

Hidden coverage criterion: the three mutants in gold/mutants/{empty,decimal,whitespace}.mjs
are swapped one by one into a working copy, and the agent's test suite must go red every
time. Each mutant is built so the two BASELINE assertions stay green — only a new test
that genuinely covers the corresponding boundary can kill it. '  7 ' (surrounding
whitespace) is machine-verified by the whitespace mutant.
