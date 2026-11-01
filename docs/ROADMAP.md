# Roadmap

What Sakk does next, grouped as **Now**, **Next** and **Later**, with what
each step depends on. It is the public form of docs/V2-BACKLOG.md, which
keeps the full per-finding detail; `findings/ledger.json` has each finding's
current state. Dates are targets, not promises.

Items marked **enterprise edition, not in open source** belong to a separate
edition (see [ADR-0014](adr/0014-open-core-split.md)). They carry no date or
price here.

An item counts as done only when its acceptance case's expected result is
observed in a run of the case's own steps, the sibling cases its finding
names are checked the same way, and the test that would catch the next
instance lands in the same change.

## Now — release 0.3.0

- Apache-2.0 license, contributions under the DCO
  ([ADR-0011](adr/0011-apache-2-license-and-dco.md)).
- Public repository built from filtered history
  ([ADR-0012](adr/0012-public-repo-from-filtered-history.md)). Depends on a
  clean de-identification scan of the history.
- Basic username and password login for `sakk ui`, beside the token link
  ([ADR-0013](adr/0013-basic-password-login-sso-later.md)).
- Regulated case packs and the strict regulated policy move out of the open
  core ([ADR-0014](adr/0014-open-core-split.md)).

Already closed for release: third-party notices ship in NOTICE (F-199), and
version, CHANGELOG and tag agree (F-111).

## Next — guard reach, then spend, ledger and console

**Guard: how names are read.** The gaps an agent can use today.

- F-183: compare program names and protected folders without case on a
  case-insensitive volume.
- F-184: read git options the way git does (short clusters, unique long
  prefixes); ask on an inline alias.
- F-185: recognise the Sakk CLI through every launcher (`npx`, `npm exec`,
  `node` with a script path) before the gate that stops an agent loosening
  its own controls.
- F-186: resolve a symlink before every secret and scope rule.

**Guard: install and reach.**

- F-189: match every file-reading tool (Grep, Glob) and write the deny rules
  at install.
- F-187: protect a project-local install's code like guard state, or refuse
  a project-local install.
- F-190: scan content that is not a plain string, or deny it with a code.
- F-196: `sakk init` installs the guard, or says it did not and prints the
  next command.

**Spend, ledger and console.**

- F-191: record the log folder at `sakk cap set` and read only that.
- F-192: skip and report one unreadable log; the cap fails closed under it.
- F-193: bind the ledger summary to the chain head, and refuse `reserve` on
  a mismatch.
- F-194: redact secrets in every field of a decision, not only the command.
- F-201: a browser run of the console's stop button as an acceptance case.
- F-230: the Agents page shows the two doctor warnings it still hides.

**Secret scanning.** A recall corpus for the 125 enabled rules that have
precision only (C-13), a benign corpus as a precision row (F-75), and one
finding per secret when two rules match it (F-122).

**Package and README.** Every count in README and spec generated or tested
from the rules file (F-198); every README shell line run by a check (F-197 —
the marketplace file itself ships in 0.3.0); refusal codes collected from every source form (F-200); a pack-time
stray-file check and secret scan of the packed files; a clear refusal on Node
older than 20; each README figure backed by a linked measurement.

**Gold v2 and the eval harness — due 2026-11-30.** Real-mode cases that can
pass honestly and refuse a forged test log (F-90); a scorer that reads a
baseline taken at case prep, not the agent-writable git folder (F-76);
verifiable pack reports (F-50); a reference oracle for the policy fuzz
(F-113); harness nits (F-112).

## Later

- Local proxy and key custody: meter spend at egress and keep keys out of
  the agent's hands (DECISIONS D12). Depends on a design review before any
  build.
- Gateway follow-ups (D14): the LiteLLM plugin's tests in CI, Anthropic
  `/v1/messages`, paid search through the gateway, cached-input prices.
  Depends on adding a required CI check, which is the maintainer's call.
- The ledger books from a versioned price table: reserve from model and max
  tokens, settle from provider usage (F-125). Depends on a maintainer
  decision.
- Per-request prices for server tools such as web search (F-180). Depends on
  a maintainer decision.
- Declared fields required for allow-default policies over MCP (F-106).
  Depends on a maintainer decision.
- A portable self-evolution kit: an init command that lays it into any
  project, and a starter set of classes for a new ledger (F-123, F-124).
  Depends on a maintainer decision on F-124.
- Lock protocol: unlock refuses a live holder, and the owner is recorded in
  the lock (F-49, F-104). Depends on a review of the lock protocol change.
- A `sakk settle` CLI command for late settlement. Planned, not shipped.

## Enterprise edition, not in open source

- Case packs by regulation (CBUAE, DIFC, DORA) with per-requirement
  verdicts. Re-anchored on the binding regulations and reviewed by a local
  law firm before any outside use (F-127).
- The strict regulated policy and the compliance review, moved out of the
  open core (ADR-0014).
- Hash-chained (tamper-evident) ledger mode.
- Named-approver identity and SSO. The open release has one local login
  (ADR-0013).
- Team console: approvals, roles, audit export, outbound metering. The open
  release keeps the local read-only `sakk ui`.

## Not planned

Orchestration frameworks and model-level safety such as prompt-injection
detection. Sakk is the change-control and evidence layer, not another agent
platform.

## How to help

Pick an item from **Next**, open a discussion or issue, and read
CONTRIBUTING.md. Decisions behind the roadmap are in the
[architecture decision records](adr/README.md); what went wrong along the way
is in the [retrospectives](retros/README.md).
