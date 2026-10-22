# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — the secret guard in the hook (open-source v1, M3)

- A write whose content is a secret, and a shell command (or `apply_patch`
  body) whose text contains a literal secret, are now denied inside the hook
  (`evaluate` step 3), scanned once per call through the existing eight-rule
  `scanText`. This runs for every agent (claude-code, cursor, codex) and over
  every write surface (Write `content`, Edit/MultiEdit new text, NotebookEdit,
  `apply_patch`). Reading a secret file was already denied by the `secret.read`
  rule and is unchanged.
- The deny names the matched rule and a keyed fingerprint, never the secret
  value; the decision-log line drops the reason text and the content, so the
  value reaches neither the agent nor `~/.sakk/decisions.jsonl`. A scan that
  cannot run fails closed as `HOOK_SECRET_SCAN_FAILED` (a deny, via the
  guard's rules-unknown path). New refusal code: `HOOK_SECRET_SCAN_FAILED`.
- Deferred: the gitleaks 222-rule port (`specs/secret-guard/`, "Status") needs
  the upstream rule file fetched at a pinned commit (a network download) and
  waits on approval; the hook ships the eight rules until then.

### Added — spend and the daily cap (open-source v1, M2)

- `sakk spend` reads Claude Code's local transcripts
  (`~/.claude/projects/**/*.jsonl`), prices them, and shows a day's spend by
  model and what could not be priced. Each call is counted once at its
  largest recorded usage (dedup by `message.id`+`requestId`, max-merge);
  cache writes are priced per duration (5m/1h) and the whole request bills at
  the long-context rate past a model's threshold.
- `sakk cap set <usd> [--zone <IANA>]` / `sakk cap off`: a daily cap the guard
  enforces at the next tool call. The cap, zone and log folder are frozen in
  `~/.sakk/config.json` by a person — not read from the agent's environment —
  and writing `~/.sakk/` is denied by the guard, so an agent cannot raise its
  own cap. Fail-closed: a model with no price (`PRICE_UNKNOWN`) or an
  unreadable log line (`SPEND_UNREADABLE`) is a deny while a cap is set.
- `sakk prices` shows the table in use; `sakk prices update` fetches a newer
  list from LiteLLM (the only network call). A small, approximate starter
  snapshot ships in `prices/` (schema `sakk-prices.v1`); unlisted models fail
  closed until refreshed.
- The spend index (`~/.sakk/spend/`) is incremental and only grows — a
  deleted or rewritten log keeps what was counted. The figures are an
  estimate from local logs, not the provider's invoice. New refusal codes:
  `PRICES_INVALID`, `PRICES_UNREADABLE`, `PRICE_UNKNOWN`, `USAGE_INVALID`,
  `SPEND_UNREADABLE`, `SPEND_CAP_REACHED`, `SPEND_TOO_MANY_LOGS`.

### Fixed — F-105 archive, from the independent review (F-159)

- `sakk ledger verify` now checks the call-id index as well as the segment
  chain, so a lost or wrong index (which silently re-admitted a sealed
  call-id — a double-spend) is caught; `reserve` refuses when the whole index
  is gone but segments are sealed, and `sakk ledger reindex` rebuilds it from
  cold.
- verify sums the sealed total per segment exactly as it is stored, so an
  intact chain never false-fails on float order.
- `sakk ledger export --out` reports a typed `LEDGER_EXPORT_FAILED` instead of
  a raw stack. The spec now states verify detects accidental corruption and
  loss, not tampering by a writer who can recompute the unkeyed hashes.

### Added — the ledger's hot/cold split (F-105, schema v3)

- Settled entries are sealed into an append-only, hash-chained cold trail
  (`<ledger>.cold/`), with a call-id index (`<ledger>.idx/`), so the live
  `ledger.json` stays small and `reserve`/`settle`/`status` cost the same
  whatever the history — 2万 entries used to cost 96 ms a call, 10万 539 ms;
  now a call is flat. No entry is dropped and nothing is capped.
- The gate reads only the hot file; its total is `archive.settledUsd` plus the
  hot entries. Cold integrity is on demand: `sakk ledger verify` walks the
  hash chain (exit 1 if a segment is lost or altered), `sakk ledger export`
  rebuilds one flat ledger from cold + hot.
- Schema `sakk-ledger.v3` (adds the `archive` summary; a ledger becomes v3 the
  first time it seals and an older binary refuses it by schema name). v1/v2
  ledgers read and migrate on first seal.
- In-flight cap (public API): at most 10,000 reservations may be outstanding
  at once (`LEDGER_FULL`); settling what is open always works. New refusal
  code `LEDGER_ARCHIVE_BROKEN`. `SEAL_AT` (settled kept hot before sealing) is
  a tuning knob via `SAKK_SEAL_AT`, default 1000.
- The ledger's durable write now uses one shared hardened writer
  (`writeFileAtomic` in `append.mjs`), used for the hot file and the cold
  segments and index shards.

### Added — the agent guard (open-source v1, M1)

- `sakk hook --agent claude-code|cursor|codex`: one hook for all three
  agents. Each tool call is classified into actions (`file.read`,
  `file.write`, `file.delete`, `secret.read`, `git.destructive`,
  `prod.delete`, `deploy`, `package.install`, `net.download`,
  `shell.constructed`, `shell.run`, `mcp.<server>.<tool>`) and judged by the
  policy kernel. Any error is a deny with a code.
- `sakk guard install|uninstall <agent> [--user]`, `sakk try "<command>"`,
  `sakk doctor` (checks the hook really fires).
- `policies/guard-default.json`: the shipped policy (docs/GUARD.md).
- Writing outside the project (your home folder and elsewhere, temporary
  folders excepted) now asks first (`ask-write-outside`): the home folder is
  where a manipulated agent would otherwise leave a shell profile or an SSH
  key to persist, so an outbound write is a confirmation, not a silent allow.
- Scopes (public API): repo-relative, `~sakk/…`, `~home/…`,
  `~outside/<absolute>`, and `~protected/repo|home|sakk` for a delete that
  would take the repository, the home folder or Sakk's state with it
  (F-146).
- A broken rule file is isolated, never a refusal of every call (RC-09):
  - A project policy that fails to load gives way to the last one that
    loaded, kept in `$SAKK_HOME/policy-good/`. Refusals say so, and
    `alerts.jsonl` records `POLICY_FALLBACK`.
  - With nothing to fall back to, or an unreadable config or ledger, only
    reading the project goes on (`ruleId: rules-unknown`).
- New refusal codes in hook answers (public API): `HOOK_PAYLOAD_INVALID`,
  `HOOK_INPUT_TOO_LARGE`, `HOOK_POLICY_UNREADABLE`, `HOOK_LEDGER_UNREADABLE`,
  `HOOK_CONFIG_UNREADABLE`, `HOOK_CONTEXT_INVALID`, `HOOK_DEADLINE`,
  `HOOK_PATH_UNREADABLE`, `HOOK_USAGE`.

### Added — bounds on what the books store (F-105, first part; C-04)

- New refusal codes (public API):
  - `INPUT_TOO_LONG`: a call id, run id, task id or agent id over 256
    characters, a name over 256, or a halt reason over 1024.
  - `POLICY_TOO_LARGE`: the policy file is over 4 MiB.
- `ESTIMATE_INVALID` now also refuses estimates below $0.000001.
- `test/cost-bounds.test.mjs` lists every exported function with the
  refusal that bounds it; a new export without an entry fails the suite.

### Fixed — found while building M1 (F-141 to F-149)

- F-141: a checker that could not load locked the repository it guards. It
  now loads its library lazily, and while it cannot load only the gate's own
  files can be repaired.
- F-142: the adversarial review showed as passed when no key was set. It
  is now skipped at the job (shown as skipped), and a review that cannot be
  made or posted fails.
- F-143: a hung synchronous child could hold a test run with no bound.
  `test/bounded-spawn.mjs` now bounds every one.
- F-144: the gate's files are listed once, in `scripts/gate-files.json`.
- F-145: a wrapper's flag value (`sudo -u root`) is no longer read as the
  command.
- F-146: a temp-folder allow no longer covers the home folder, and a delete
  of the repository itself is named and denied.
- F-147: drill ids of any length are recognised.
- F-148: the guard spec's rule table is compared with the shipped policy.
- F-149: every mutation-drill anchor is checked by `npm test`, not only by
  the hour-long drill.
- F-150: the F-105 input bounds no longer lock settled money — a reservation
  made before ids were bounded still settles — and a non-string `runId`,
  `taskId` or `tokens` is now refused (`INPUT_INVALID`) instead of stored
  whole; reconciliation reasons are truncated so a long id cannot jam the
  books.
- F-151: the cost-bounds detector now accepts only a real test as a guard,
  never a circular self-reference, and covers the non-string inputs.
- F-152: `max_reservable_usd` is computed once in the ledger and reports 0
  when the headroom is below the estimate floor, so the figure `status`
  shows is one `reserve` actually accepts.
- F-153: commands that move or destroy files but were not in the classifier's
  set — `dd`, `tar --remove-files`, `rsync --delete`, in-place `perl`/`ruby` —
  are now modelled as the writes and deletes they perform instead of being
  waved through as `shell.run`.
- F-154: `find -exec`/`-ok` and `xargs` are judged by the command they run
  (a remover deletes, a reader reads), not by the runner's name.
- F-155: reading a secret file through a command outside the reader list
  (`base64`, `openssl`, `dd if=`) is still a `secret.read`.
- F-156: a git value-option (e.g. `--namespace x`) can no longer shift the
  subcommand so a `push --force` reads as ordinary work.
- F-157: while the checker cannot load it now resolves a path's symlink leaf
  (not just its parents), judges a Bash call by its command rather than a
  stray `file_path` key, and denies instead of crashing when the library
  throws a non-error; the loop's shell classifier treats `node --test` as
  read-only only when it injects no module.
  The same review's own detectors are strengthened too: the bounded-spawn
  preload now bounds an explicit null/undefined options slot and the scripts
  that spawn `node --test`, and the ci-honesty detector catches more
  skip/failure-to-green shapes.
- F-158: the CI base checker runs in its own job with a fresh checkout, so the
  pull request's own checker can no longer move HEAD or write the environment
  to leave the base checker an empty range.

### Changed (release preparation)

- Halt, resume, reconcile and unlock records are now described as named:
  they carry the name the operator typed and nothing verifies it (F-126).
  A test fails if a user-facing document gives a record a security
  property that no code provides.
- README states the open core's limits: self-declared names,
  caller-reported costs, approval-required means refused, voluntary gating.
  Dashboards are no longer listed as not planned; a web console is on the
  enterprise roadmap.

### Fixed (regression of the original modules, findings F-80 … F-115)

- Ledger: the concurrency test was sequential and a lockless ledger passed
  it — eight workers now race for real (drill MUT-Z); a ledger reached
  through a symlink or hard link refuses (`LEDGER_PATH_NOT_CANONICAL`)
  instead of forking the books; settle no longer makes a stale ledger
  fresh; alerts and decision logs never follow a planted symlink; a fifo
  ledger or policy refuses instead of blocking.
- `sakk status` judges reconciliation from both sources, shows a stale
  ledger, exits 3 for either and reports nothing reservable when every
  reserve would refuse; a named `sakk reconcile` confirms stale books.
- MCP: a nested frame can no longer crash the gate (bounded echo, frame
  isolation); an agent cannot settle its own reconciliation entry; a
  relative `--ledger` is resolved at startup.
- Policy: `*` inside agent/action names refuses at load; policies that can
  only say yes refuse; decisions validate the path once.
- Eval: the child environment is an allowlist (operator credentials and
  `NODE_OPTIONS` test flags no longer reach children); a scoring failure
  is that case's FAIL; the answer key is checked in every mode; every
  scorer rule has a negative test.
- CI: the review workflow actually posts and has a timeout; the timeout
  detector reads every workflow.

### Added

- Attack rows for the ledger core, policy kernel, MCP enforcer and gold
  harness environment (E5–E8); campaigns run in the audit and CI; every red
  line names its drill anchors (26 mutants); `specs/ledger`.

### Added (self-evolution loop — docs/SELF_EVOLUTION.md)

- `npm run brief -- <paths>`: before a change, the past findings for those
  files, the questions to answer first (`findings/prevention.json`), the
  known blind spots of the checks that will run, and those checks. The
  commit gate prints it.
- The ledger gate now requires `areas` on every finding, `since` on every
  class-mechanism reference, and for every escape past an existing
  detector a `mechanism_gap` and `mechanism_upgrade`; every class has a
  prevention question; two escapes in a row that upgraded nothing need a
  stop-line review. `findings-report` adds the past-detector escape rate
  and the detector upgrade rate.
- Rule R-22; AGENTS.md "Before you change anything"; PR template section.

### Fixed (independent review on a second model, findings F-62 … F-79)

- Evidence bundles: a REAL run must name its model (verifier and
  builder); every run records `harness_dirty` in `metrics.json`; a REAL
  run on a modified or uncheckable harness tree is INCOMPLETE and its pack
  requirements read `HARNESS_MODIFIED`, never `COVERED`; pack reports and
  `bundle.json` are closed (every key required). The auditor procedure now
  runs the CURRENT verifier from a clone — a bundle can ship an older
  genuine verifier that misses later checks.
- Gold runner: a copy of sakk inside another git repository refuses
  (`HARNESS_GIT_REQUIRED`) instead of recording that repository's commit.
- Secret scan: an exempt fiction-token match no longer hides a real secret
  it swallowed; `--staged` ignores git replace refs; PGP private-key
  blocks are detected; `--install-hook` writes pre-commit AND
  pre-merge-commit hooks (both or neither) and the hook refuses with
  `SCAN_HOOK_STALE` after a node upgrade instead of a bare shell error.
- Kill switch: halt and resume keep `updatedAt`, so a stop never makes a
  stale ledger fresh; `halt.lifts` keeps who lifted which halt in the
  ledger (v2 halt shape, unreleased); blank names refuse; `sakk status`
  escapes operator text.
- Case packs: `gaps` and `not_covered` must be non-empty; pack evidence
  sentences state what the cases check (G03 markers, G06's reference gate,
  git facts the agent can rewrite).

### Added (class detectors)

- `test/bundle-absence.test.mjs`: deletes every key of every bundle
  document; any deletion that still verifies must be declared.
- Secret-scan context matrix (every secret shape × every fiction-token
  position); ledger-write classification (confirms the books or not);
  the stopwatch detector covers deadlines; the repository self-scan test
  scans the root, not a list of directories.
- Mutation drill: 23 anchors (was 18).

### Known, not fixed

- F-75: false positives on translation files and Ansible variables
  (precision needs a benign corpus and a re-measured attack list).
- F-76: the scorer reads changed files from the agent's own `.git`;
  disclosed in every affected pack requirement; the fix changes the
  frozen scorer and needs a decision.

### Added (testing-standard audit)

- `npm run audit`: one command for every layer of the AI-agent testing
  standard that applies to Sakk — T0 suites, format, secret self-scan,
  mutation drill, ledger and policy fuzz; T2 `npm run golden-k` (k = 3,
  pass@1 with Wilson interval, pass^k; FAKE executor = harness only);
  T3 `npm run attack-asr` (attack list over the kill switch, secret
  scanning, case packs and evidence bundles, ≥ 5 variants per payload,
  CLAIMED ASR must be 0, documented non-coverage reported); §14 ledger gate
  and `npm run findings-report`. Exit codes taken directly; logs in
  `audit-logs/`. Layer map: `docs/testing-profile.md`.
- Mutation drill: 23 anchors (was 7) — one per core guard, including the
  per-agent halt and resume scoping, the HARNESS_ONLY and HARNESS_MODIFIED
  rules, the secret-scan exemption (both directions) and staged type
  changes, the bundle verifier's spend, metrics, parsing, model and
  closed-report checks, the MCP policy gate, the path matcher, the
  paid-step cap and the bundle self-check. The certificate expects 23.
- `specs/case-packs`, `specs/secret-scan`, `specs/evidence-bundle`: the
  three-tables files these L1 changes lacked; `test/core-specs.test.mjs`
  keeps every core file specified and drilled.

### Changed (kill switch — behaviour of existing APIs)

- `reserve()` now refuses an `agentId` that is not a non-empty string
  (`AGENT_ID_INVALID`); before, `agentId: 7` or `""` was accepted and
  recorded. `null`/absent stays anonymous. Reason: a numeric id could never
  match a per-agent halt.
- The `sakk` CLI refuses unknown flags, the `--flag=value` form and repeated
  flags with exit 2 (`USAGE_UNKNOWN_ARGUMENT`, `USAGE_EQUALS_FORM`,
  `USAGE_REPEATED_FLAG`); before, they were ignored — `sakk resume --by op
--agent=bot` lifted the GLOBAL halt.

### Added (kill switch)

- `halt()` / `resume()` and `sakk halt|resume --by <name> [--agent <id>]`:
  stop all new spending (or one agent's) with a named record stored in a
  top-level ledger key `halt` — deliberately outside `flags`, which four
  money paths rewrite wholesale. **Schema `sakk-ledger.v2`**: the first
  halt upgrades the file to v2, which REQUIRES `halt` (deleting it refuses
  rather than reading as "not halted"); v1 forbids it; resume keeps v2
  with an emptied record. Genesis ledgers stay v1. New public codes:
  `LEDGER_HALTED`, `AGENT_HALTED`, `HALT_BY_REQUIRED`,
  `RESUME_BY_REQUIRED`, `AGENT_ID_INVALID` (reserve/halt/resume now refuse
  a non-string or empty agent id — a numeric id could never match a halt;
  `null` stays anonymous); `sakk status` exits **4** while globally halted
  (4 wins over 3; both conditions are printed). Agent ids are matched
  exactly as own keys, so ids like `__proto__` or `constructor` halt and
  resume like any other.
  Halting works on stale ledgers and during reconciliation; the CLI
  retries lock contention; settle stays open for in-flight calls; first
  halt wins; alerts `HALT_SET` / `HALT_REFUSED` / `HALT_CLEARED`. MCP
  status shows halts, and no MCP tool can halt or resume. Older versions
  refuse a v2 ledger by schema name — they can never ignore a stop. Drill gains MUT-G (7 mutants); invariant fuzz gains halt ops and
  refuses vacuous seeds that never probe a halt.

### Added (secret scanning)

- `sakk scan <paths> | --staged | --install-hook` and `src/secret-scan.mjs`
  (ported from the predecessor system, English-ized and hardened): eight
  rules (DSNs with passwords, URL-encoded passwords, AWS keys, `sk-`/`rk-`
  keys, GitHub tokens, private-key blocks, bearer tokens, password
  assignments); fingerprint-only findings; a single declared-fiction
  exemption token, judged on the secret part of a match only (a token in a
  username exempts nothing). New over the predecessor: staged-blob scanning
  for pre-commit (read by blob id, so type changes and names like `0:foo`
  are scanned; submodule pointers skipped and counted), a hook that runs the
  installed copy by absolute path and is written with `wx` (never overwrites,
  never writes through a symlink), symlinks skipped (no loops, no escaping
  the tree), NUL-sniffed binary skipping with UTF-16 decoded as text,
  keyed fingerprints (random per run, `SAKK_SCAN_KEY` to compare), redacted
  secret-bearing paths, length-bounded patterns (a 200KB hostile line scans
  in linear time). Exit 0 clean / 1 findings / 2 the scan could not do its
  job (`SCAN_PATH_MISSING`, `SCAN_UNREADABLE`, `SCAN_NOT_A_REPO`,
  `SCAN_HOOK_EXISTS`, `SCAN_HOOK_DIR_MISSING`, `SCAN_FAILED`). Recognized
  formats only — unquoted `.env` passwords are not detected.
  Verify-pass round: `--staged` reads each blob id from one `git diff
--cached --raw` record (two names that decode alike, or a run from a
  subdirectory, can no longer hide a blob) and batches blob reads; staged
  symlink targets are scanned; explicit roots are followed, a fifo/device
  or a >256 MB input is `SCAN_UNREADABLE`; `--staged` with paths is
  `SCAN_USAGE`; git missing is `SCAN_GIT_MISSING`; hook write failures are
  `SCAN_HOOK_UNWRITABLE`, installing from the npx cache is
  `SCAN_HOOK_EPHEMERAL`; the hook line is shell-quoted and chmod'ed past the
  umask. Patterns: `sk`/`rk` keys need a digit (identifiers no longer
  match), `mariadb`/`rediss`/`amqps`/`mssql`/`sqlserver` and empty-user URLs
  added, aligned `password    = "…"` found, a fiction token glued to a real
  key exempts nothing. UTF-32 and odd-length UTF-16 decoded; names with
  control characters printed escaped; exit codes set without truncating
  piped output.
  Verify round 3: key shapes the digit rule had dropped are back
  (`sk_live_`/`rk_test_`-prefixed keys need no digit; `sk_<hex>` and `sk-`
  keys of 40+ chars match); `--no-relative` so `diff.relative=true` cannot
  hide files from a subdirectory scan; values on the next line
  (`password:` + newline, wrapped `Bearer`) found; placeholders such as
  `${REDIS_PASSWORD}` in the secret position are not secrets; a key glued
  right after the fiction token is found; C1 controls and U+2028/2029 in
  names escaped; a missing staged object is named as missing;
  `--install-hook` with paths is `SCAN_USAGE`, without git
  `SCAN_GIT_MISSING`; ephemeral-cache detection covers npx hash dirs, bunx
  and pnpm dlx without refusing ordinary paths that contain `_npx`.

### Added (case packs)

- `eval/packs/`: gold cases grouped by regulatory requirement —
  `cbuae-ai-oversight` (4), `dora-ict-change` (3), `difc-data-protection` (3)
  requirements over 9 of the 12 cases (G04 and G09 map to no requirement in
  these packs; control-plane G12 cannot run against a model, and packs admit
  only `execution_mode: "model"` cases). `gold-runner --pack <id>` runs a
  pack's cases and writes `pack-report.json` with its provenance (mode, run
  id, harness commit, stop info). FAKE runs read `HARNESS_ONLY`; only REAL
  runs can read `COVERED`. Every requirement carries `gaps`, every pack
  `not_covered` — mandatory fields, so the honest boundary travels with the
  claim. Refusals: `PACK_UNKNOWN`, `PACK_INVALID`, `SELECTOR_CONFLICT`,
  `USAGE_EQUALS_FORM`, `USAGE_UNKNOWN_ARGUMENT`, `USAGE_REPEATED_FLAG`,
  `USAGE_MISSING_VALUE`, `USAGE_MODE_CONFLICT` — the runner now refuses any
  argument it does not know (a misspelled `--packs x` used to run ALL
  cases). A REAL pack report names the model (`model`: provider, model id,
  executor binary, whether `CLAUDE_BIN` overrode it) and whether the harness
  tree was dirty; `not_covered` is marked non-exhaustive. **Exit code:** a
  REAL batch that stops early now exits 1 even if every case that ran passed.
  Verify round 3: `harness_dirty` is computed from the repository top (it
  could never be true before) and excludes the run's own out dir;
  `model.executor_binary_resolved` records the file PATH actually ran, and
  the REAL meaning says the binary is recorded, not verified; empty values
  and flags the chosen mode never reads refuse (`USAGE_FLAG_NOT_FOR_MODE`).
  `--validate` checks all packs and reports `packs_ok`.

### Added (evidence bundles)

- `scripts/evidence-bundle.mjs <out-dir> --to <file.tgz>` (`npm run
evidence`): packs a run into one self-contained bundle — the out-dir, the
  case definitions read from the run's own harness commit (`git show`),
  `bundle.json` (schema `sakk-evidence-bundle.v1`), `MANIFEST.sha256`, a
  README and `verify.mjs`, a zero-dependency verifier that runs with Node
  alone. The auditor checks the bundle WITHOUT running its code first:
  fingerprint = `shasum -a 256 MANIFEST.sha256` against a value received
  out of band, then `shasum -a 256 -c MANIFEST.sha256` (AUDITOR_REPLAY §6).
  verify.mjs then checks integrity (regular files only — links are
  failures, never followed) and internal consistency: one run, one commit,
  one executor mode cross-checked against every trace's provider; case list
  vs case directories; verdict vs violations; per-case cost vs its own
  ledger; every metric except trace_completeness_rate recomputed (pass
  rates, first-pass yield, counts, costs, p50/p95); pack report recomputed
  (a FAKE run can only read HARNESS_ONLY). Unreadable, falsy or ill-typed
  files are named failures (`CASE_FILE_INVALID`, `METRICS_UNVERIFIABLE`,
  `BUNDLE_META_INVALID`, `NOT_A_REGULAR_FILE`, `MODE_MISMATCH`,
  `CASE_SET_MISMATCH`, …), never skipped checks. Building refuses
  (`BUNDLE_SOURCE_INVALID` incl. symlinks and commits the clone lacks,
  `BUNDLE_TARGET_EXISTS`, `BUNDLE_SELF_CHECK_FAILED`, `BUNDLE_WRITE_FAILED`),
  verifies the archive itself after unpacking it fresh, and places it with
  an exclusive link — no partial file is ever left at the target.
  Authenticity is out of scope until the anchored ledger ships: a full
  rebuild passes verify.mjs; only the out-of-band fingerprint catches it.
  Verify-pass round: a third outcome, **INCOMPLETE** (exit 3, like `sakk
status`), for a genuine run with unsettled/unreconciled spend, unknown
  cost, a stopped batch, or selected cases that never ran — such a run used
  to read PASS while its spend was understated; it now ships labelled and
  never reads PASS. The runner records `selected_cases` and `stopped` in
  `metrics.json` (bundles refuse older run dirs). Per-case ledgers are
  checked against sakk's ledger rules, this run's id and the case's budget
  (`LEDGER_INVALID`); mode labels and trace model ids join the mode check;
  pack reports recompute their quoted verdicts, commit, total and stop
  record; lowercase rule names, duplicate JSON keys (`DUPLICATE_JSON_KEY`),
  negative durations and empty directories (`EMPTY_DIRECTORY`) fail;
  `verifyBundle` never throws. The shipped verifier must be committed
  (`BUNDLE_VERIFIER_DIRTY`) and its commit is recorded (`verifierCommit`);
  targets must be `.tgz`/`.tar.gz` (`BUNDLE_TARGET_INVALID`), a dangling
  symlink counts as existing, files over 1 GiB are refused. A SIGINT or
  SIGTERM during a build lets it finish or fail as a whole — it does not
  cancel it — and temp files are always removed (SIGKILL excepted).
  Verify round 3: a truthful overrun past a case cap (sakk flagged it) is
  INCOMPLETE (`SPEND_OVER_CAP`) and ships, labelled — it used to be
  unbundleable; an unflagged one is a forgery. Ledgers are checked as
  closed documents (unknown keys, missing updatedAt, duplicate callIds, an
  overrun without the flag sakk sets); every paid step in a trace must have
  a ledger entry and vice versa; estimated costs (`cost_is_estimate`,
  `real-exec.json` without a cost) are INCOMPLETE; pack reports may only
  quote selected cases and must name the run's model; stop records compare
  regardless of key order; hidden-dotfile targets are refused.

### Fixed (gold runner)

- A relative `--out` (e.g. `--out run1`) reached executors and verification
  commands that run in other working directories, so every case scored
  FAIL while the same run with an absolute path passed. The out path is now
  resolved to an absolute path once, at parse time; the printed `outDir` is
  absolute. Fails safe before and after (no false PASS), but a real-model
  run with a relative path would have spent budget on wrong verdicts.

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
  every decision logs to `<ledger>.decisions.jsonl` beside the ledger. 1 MiB
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
  with a dual-source halt and entry-resolving named clearance; retry limits
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
