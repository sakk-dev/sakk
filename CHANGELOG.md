# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (evidence bundles)

- `scripts/evidence-bundle.mjs <out-dir> --to <file.tgz>` (`npm run
evidence`): packs a run into one self-contained bundle — the untouched
  out-dir, the case definitions, `bundle.json`, `MANIFEST.sha256`, a README
  and `verify.mjs`, a zero-dependency verifier that runs with Node alone.
  Verify checks integrity (manifest) and internal consistency: verdict vs
  violations, per-case cost vs per-case ledger, one run id and one harness
  commit across traces, metrics.json and pack-report.json recomputed from
  the per-case files — so a forger who also rewrites the manifest is still
  caught. Building refuses (`BUNDLE_SOURCE_INVALID`, `BUNDLE_TARGET_EXISTS`,
  `BUNDLE_SELF_CHECK_FAILED`) rather than ship an unverifiable bundle.
  Authenticity is explicitly out of scope until the anchored ledger ships:
  the fingerprint must reach the auditor separately.

### Fixed (hardening campaign, 2026-10-16)

- **C-4 (disk-full could install broken books)**: `writeSync`'s return was
  unchecked, so a short write under ENOSPC could be fsynced and renamed
  into place — an atomically installed TRUNCATED ledger (found by the
  container matrix's tmpfs probe; the post-mortem read came back
  `LEDGER_MALFORMED`). Writes now account for every byte, zero-progress
  refuses, any write failure cleans the temp file and surfaces as the new
  public code `LEDGER_WRITE_FAILED` — and the matrix probe asserts the
  books remain readable after disk-full.
- **C-1**: `sakk-ledger.v1` is a CLOSED schema — unknown top-level keys
  (incl. a smuggled own `__proto__` key) refuse `LEDGER_SCHEMA_INVALID`.
- Campaign harnesses added under `scripts/campaign/` (soak with SIGKILL
  injection, fault-injection corpus, seeded MCP torture, container matrix
  with ENOSPC probe); measured lock-contention refusal rate ~0.016% under
  8-way chaos (C-2).

### Added (policy engine kernel — 🔒L2, design signed 2026-10-15)

- `sakk/policy` export: `loadPolicy` (validate + SHA-256 over raw bytes) ·
  `decide` (pure, first-match-wins, mandatory `default_verdict`) ·
  `logDecision` (hash-pinned JSONL) · `PolicyError`. New public error codes:
  `POLICY_UNREADABLE`, `POLICY_SCHEMA_INVALID`, `POLICY_VACUOUS_ALLOW`,
  `POLICY_RULE_SHADOWED`, `CONTEXT_INVALID`, `DECISION_UNLOGGABLE`. The
  kernel never imports the ledger; enforcers compose the two.
- `policies/` reference profiles (`permissive-dev`, `regulated-strict`) ship
  in the npm package; documented schema at `eval/schemas/policy.schema.json`
  with a drift-guard test against the kernel's own validation.
- Path matcher extracted to `src/match.mjs` — ONE implementation shared by
  scorer and policy kernel (scope entries are prefix rules, not wildcards).
- Mutation drill grows to 6 mutants (MUT-E rule-order, MUT-F vacuous-allow);
  the pristine control now runs both suites. `npm run fuzz:policy`: seeded
  policy/context fuzz (5 invariants, benign + adversarial size probes,
  replayable seed).
- Decision log line format (public API): one JSON object per line with
  `at` (ISO timestamp) · `by` (string|null) · `verdict` · `ruleId`
  (string|null) · `approversMin` (only on require_approval) · `policyHash`
  (64-hex) · `context` ({agent, action, scope, estimatedUsd, callId}).

### Added (MCP enforcer)

- `sakk mcp`: zero-dependency MCP stdio server exposing `sakk_reserve` /
  `sakk_settle` / `sakk_status` — the policy kernel's first enforcer.
  Ledger path is required (`MCP_LEDGER_PATH_REQUIRED`, no cwd default); a
  configured policy is loaded once, hash-pinned, and refuses startup on
  any `POLICY_*` code. Policy refusals surface as `POLICY_DENIED` /
  `POLICY_APPROVAL_REQUIRED` (public API) with the full decision attached;
  every decision logs to `sakk-decisions.jsonl` beside the ledger. 1 MiB
  frame cap; contract tests drive the real binary over real frames,
  including a thinness proof (library replay yields identical books).

### Fixed (certificate + MCP adversarial-review round)

R-05 on PR #3 found 4 merge-blocking defects and 11 more; all closed with
attack-shaped regressions:

- MCP `sakk_settle` swallowed the ledger-halt signal (replied
  `settled:true` while the whole ledger froze) and truthy-coerced
  `failedUnknownCost`, breaking thinness — the library's return now rides
  the response and arguments pass verbatim (a divergence test pins MCP ==
  library behavior).
- Certificate freshness now requires EVERY drill kill to carry a verified
  hash block (a parse drift silently shrank the verified set); the tree is
  re-verified right before rendering (TOCTOU); refusals delete any stale
  certificate; the final write is atomic; `src/mcp.mjs` and the issuer
  itself join the certified surface; suite summaries with skipped/todo
  holes refuse; internal failures obey the 0/2 exit contract.
- MCP hardening: string args cap at 4096 (`MCP_ARG_TOO_LONG`, public
  API); batch/primitive frames answer -32600 (never a silent drop); one
  refusal per oversized flood; set-but-empty `SAKK_POLICY_PATH` refuses to
  start; `sakk_status` reads with the CLI's Infinity staleness; agent
  identity reaches the ledger (`agentId`); decision log is per-ledger
  (`<ledger>.decisions.jsonl`).

### Added (gate non-regression certificate)

- `npm run certificate`: executes every gate (both suites, gold manifest,
  6-mutant drill with evidence-freshness verification against the current
  bytes, both seeded fuzz legs, double-run reproducibility fingerprint) and
  renders CERTIFICATE.md. Fail-closed: any red gate, stale drill evidence
  or dirty tree refuses with a `CERT_*` code and emits nothing — the
  document's existence is the claim.

### Fixed (policy kernel adversarial-review round, 2026-10-15)

The R-05 independent review of the first kernel implementation found 4
merge-blocking defects and 8 more; all fixed with attack-shaped regressions:

- **F1 (critical, fail-open)**: a `default_verdict: "require_approval"`
  decision carried no `approversMin`, so the reference enforcer's
  `0 < undefined` comparison acted with ZERO approvals. Every
  require_approval decision — default path included — now carries it.
- **F2**: non-canonical scopes (`prod//x`, `./prod/x`, `/prod/x`) matched no
  rule and slid past explicit denies into later allows; they now refuse
  (`CONTEXT_INVALID`). Unicode normalization is the enforcer's documented
  duty.
- **F3**: the reference enforcer counted the same approver twice toward
  four-eyes; approvers are now a named set excluding the requester.
- **F4**: a schema-legal policy could park the quadratic shadow scan for
  minutes; a work budget now refuses with the new `POLICY_TOO_COMPLEX`, and
  the fuzz size probe is adversarial-shaped instead of best-case.
- F5 decide copies the context BEFORE validating (getter TOCTOU); F6 the
  log gate accepts only decide()-shaped decisions and serialization
  failures are typed; F7 duplicate JSON keys refuse (one hashed file, one
  meaning); F10 glob-looking scope entries refuse at load; F11 context
  strings cap at 4096 chars; F9 the schema drift guard now catalogs every
  known kernel-vs-schema divergence honestly.
- Verify-pass round (N1–N4): the shadow-scan budget now charges every pair
  iteration including pre-filtered ones (the guard's own bypass was the
  last hole — distinct-agent mega-policies spun unbounded); ALL
  non-canonical scope entries refuse at load, not only globs; the log gate
  binds `approversMin` to `require_approval` exactly as decide() emits;
  the signer name obeys the 4096-char cap. Policies beyond ~20k rules must
  be split (bounded-analysis cost, documented).

### Fixed (stranger-test findings, 2026-10-15)

- README failure-path sample now shows the real recovery sequence: settle the
  open entry with a human-decided figure, then `clearReconciliation` — the
  previous snippet refused as written (`RECONCILIATION_ENTRIES_OPEN`).
- Eval runner: execution modes from a ZIP/tarball download (no `.git`) now
  refuse once with `HARNESS_GIT_REQUIRED` (exit 2) instead of eight scattered
  crashes; `--validate` / `--dry-run` keep working without `.git`.
- `sakk reconcile` on a ledger with no halt says `nothing to clear` instead
  of claiming a clear that never happened.
- `sakk status` human output formats money to ≤ 6 decimals (the `1e-6`
  reserve guard no longer prints a float tail); `--json` keeps raw numbers.
- Eval runner main-module detection now compares realpaths: invoked through a
  symlinked path (macOS `/var` → `/private/var`) the CLI previously became a
  silent exit-0 no-op — a false green. Regression proves a refusal fires.

### Added (release line)

- docs/AUDITOR_REPLAY.md: the one-page auditor manual — gold-set integrity,
  deterministic verdict reproduction, judging the judge, and the honest
  boundary of what is not yet replayable.

### Fixed (second-stranger docs pass, 2026-10-15)

A context-free AI reader walked the five public docs and audited them
against the running code:

- AUDITOR_REPLAY over-claimed "byte-identical" reproduction — run-local
  fields (runId, durations) differ by construction. It now states precisely
  what reproduces (judgements and scoring metrics) and ships a **verified**
  canonical comparison command; defines "guardian test"; marks which
  evidence files are per-case conditional; aligns the ZIP wording.
- README: Install section; `reserve()` throws-on-refusal shown in the
  sample; crash-between-reserve-and-settle recovery (late settlement by
  callId) and `estimatedMaxUsd` guidance documented; roadmap ship-state
  made consistent (eval harness ✅ in-repo, hash-chain/enterprise =
  roadmap); the two-process race test named.
- CONTRIBUTING: quality pipeline rewritten without internal jargon (plain
  scope tiers, each gate explained); `npm run fuzz` added to the commands.
- ARCHITECTURE: enterprise seam column explicitly marked forward-looking.
- eval/README: `maintainer-label.json` (reviewer label) and the `PACKET.md` task
  brief defined at first use.

### Added

- Gold eval harness: 12 cases, deterministic scorer, fixture/gold isolation
  with a SHA-256 manifest, reviewer label gate, fail-closed real-run
  authorization chain, recorder-tested real adapter.
- Mutation drill (`npm run drill`): four named mutants, each killed by its
  named guardian test, with a pristine control run.
- CLI: `sakk init / status / reconcile` (`npx sakk …`), JSON output, exit 3
  while reconciliation is required — CI-gateable.
- Community files: contributing guide, security policy, code of conduct,
  issue/PR templates, architecture notes.

### Added (v3 quality pipeline)

- CONSTITUTION.md, AGENTS.md (+ eval/AGENTS.md), docs/RULES.md (R-01…R-13
  with sources and the first attribution round), specs/ convention,
  session stop-gate, `npm run fuzz` ledger invariant fuzzing, and an
  automated per-PR adversarial review workflow (depth scales with the diff).

### Fixed

- Adversarial-review round 2 (the fix batch reviewed author-blind before
  merge): lock takeover rebuilt on a breaker mutex (judgement+removal in one
  critical section; crashed breakers fail closed to `sakk unlock`); release
  authority is a process-local registry; real-mode machine logs relocated
  out of the evidence store and the gate module copied local (log
  forgeability by the same-uid adversary is now a DOCUMENTED trade-off,
  cross-checked by runner verification); fuzz oracle corrected; work-root
  gate moved first with a real refusal test; --out guard catches crashed
  runs; CI review workflow is static and base-context only (never executes
  PR code with a secret).
- Review batch D/E/F (16 findings, each with an attack-shaped regression
  test): atomic single-winner stale-lock takeover + release ownership check;
  runner-owned evidence paths no longer transit to the real-mode child;
  real-mode test evidence now reads the machine test log (honest real passes
  no longer structurally fail); non-object JSON stdout is a structured parse
  failure; settle overrun records + alerts + halts; flags is schema-required
  with a dual-source halt and entry-resolving signed clearance; retry limits
  count tool machine logs; canary scan covers all run artifacts; strict case
  selector (empty/unknown refuse); corrupt log heads fail closed; --out reuse
  refuses; flag parsing rejects flag-shaped values; tmp-boundary separator.
- Durability: ledger writes fsync before the atomic rename (and best-effort
  directory fsync) — the gate's decision survives power loss.
- Cap comparison carries a conservative epsilon so float drift can never
  fill the cap exactly.
- Stale locks from crashed holders on the same host are detected via owner
  metadata and broken automatically; `forceUnlock`/`sakk unlock --by <name>`
  cover what automation refuses to judge.
- Re-settling a callId with a different amount (or a late unknown-cost flag)
  is refused with `SETTLE_MISMATCH` instead of being silently ignored.
- The real-run authorization gate requires `SAKK_BUDGET_LEDGER_PATH`
  explicitly and never falls back to `SAKK_LEDGER_PATH`.
- CI toolchain pinned (prettier exact version, actions by commit SHA);
  platform support declared (macOS/Linux).

## [0.1.0] - 2026-10-13

### Added

- Fail-closed spend ledger (`src/ledger.mjs`): `initLedger`, `reserve`,
  `settle`, `markReconciliationRequired`, `clearReconciliation`, `readLedger`,
  `totalsOf`, `LedgerError` — reserve-before-spend, hard caps where reaching
  the cap refuses, duplicate `callId` refusal, reconciliation-required state
  that halts all paid calls, atomic lock + temp-rename writes, alert JSONL.
- 23-test ledger suite including a real two-process race.

[Unreleased]: https://github.com/sakk-dev/sakk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sakk-dev/sakk/releases/tag/v0.1.0
