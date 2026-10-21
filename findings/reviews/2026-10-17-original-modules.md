# Stop-line review — 2026-10-17 (regression of the original modules)

Standard §14.4 and §15.4. The original modules (ledger core, policy
kernel, MCP enforcer, gold harness, the promise surface) had never been
reviewed on a different model. Five independent reviews (Claude Fable 5,
fresh clones) plus a framework pass against the standard produced
F-80 … F-115: 6 blockers (lockless ledger passing the race test, books
forked through a link, a nested frame killing the MCP gate, five gold cases
that cannot pass honestly in REAL mode, version/tag mismatch, and the
red lines without drill anchors), 27 fixed, 9 open.

The loop of standard v1.2 §15 ran on itself: every finding was checked
against the brief, every escape names why its class detector missed it,
and the gate refused this ledger six times until the gaps below were
written down.

## The pattern behind the escapes

Every class detector checks **what a thing is called or which shape it
has**, and the escapes came from **what a thing does**:

- names, not behaviour — a test called "a real two-process race" that ran
  sequentially (F-84); "every CI job has timeout-minutes" that read one
  file (F-91); a spec slot filled by the wrong spec (F-86);
- codes, not meanings — README parentheticals (F-88), a documented check
  that ran in two of four modes (F-96), a status figure that did not work
  when acted on (F-100);
- one field, not the rule — globs refused in scope only (F-87), one env
  variable denylisted (F-81), one symlink site fixed (F-101), one set of
  fields escaped (F-103).

Upgrades that landed are therefore of one kind: **enumerate from the
source, or exercise the behaviour** — exhaustive key deletion, red lines
mapped to anchors, rules emitted with `rule:` treated as codes, every
workflow file, every campaign, every doc file name, attack rows with a
control that proves the target is alive.

## §15.4 — two escapes in a row that upgraded nothing

- **RC-01 — F-108, F-114.** A fifo blocking two readers, and low-impact
  edges (ulp-sized max_reservable, crash debris, error attribution). Both
  are reader/environment facts no input enumerator produces. Next
  upgrade: one inventory of every path sakk reads or writes, each with its
  file-type, link and permission rule, and a test that walks it.
- **RC-06 — F-90, F-112.** The REAL evidence path never met the real
  fixtures because FAKE agents write their own evidence. Next upgrade: a
  stub-model REAL run per case in the test suite (no API key: a scripted
  CLAUDE_BIN that behaves honestly) — ships with gold v2.
- **RC-07 — F-109, F-111.** Protocol edges and release mechanics have no
  detector at all. Next upgrade: a release-rehearsal script (pack, install,
  version/CHANGELOG/tag agreement) run in CI before any publish.
- **RC-10 — F-96, F-100.** Documented checks and figures that did not hold
  in every mode. Next upgrade: for each documented exit code and status
  field, a CLI test that acts on it (reserve after reading
  max_reservable_usd; CI gate on the exit code).
- **RC-12 — F-113, F-115.** A fuzzer without an oracle and guards tested
  only on common values. Next upgrade: a reference decide() as fuzz oracle
  with generated boundary values.

## RC-04 (4) and RC-08 (3) — third occurrences

- **RC-04 — F-31, F-43, F-81, F-87.** Lists standing in for structural
  rules (secret patterns, env names, glob fields). The exec-env allowlist
  test is the first RC-04 detector that is not a pattern test; the next
  is to state each such rule once, as code, and test it on every field.
- **RC-08 — F-49, F-67, F-99.** Writes whose meaning outlives their scope:
  a manual unlock, a timestamp. The writeLedger classification caught the
  shape; F-99 showed it asked the wrong question (which option, not who
  can call). The classification now encodes the caller; F-49 (unlock
  during a halt) stays open with the lock-protocol change (F-104).

## Open, needing a decision

F-76 + F-90 + F-112 (gold v2: frozen ruler), F-104 (lock protocol),
F-105 (entry cap — product), F-106 (allow-default semantics over MCP),
F-111 (release version and tag).
