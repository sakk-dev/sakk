# Secret guard (open-source v1, M3) — spec + three tables

Blueprint: open-source v1, headline 3 ("the secret guard"). Target design:
the v10 console, Secret guard page (commit scanning, plus "agent touched a
secret, blocked"). It extends the existing scanner
(`specs/secret-scan/spec.md`, eight rules, keyed fingerprints, staged
scan). Everything that spec guarantees stays guaranteed.

## What changes

1. **Rules.** The scanner gains gitleaks' rule set (`config/gitleaks.toml`,
   MIT, 222 rules on 2026-10-21), translated to JavaScript regular
   expressions that run on Node 20 and later. The eight existing rules
   stay; where both sets name the same secret, one finding is reported
   (F-122).
2. **In the hook** (the guard's step 3, `specs/guard/`). Three calls are
   denied:
   - **Reading a secret:** `secret.read`, by path and by command.
   - **Writing a secret:** an Edit or Write whose new content matches a
     rule.
   - **Printing a secret:** a shell command whose text contains a literal
     secret, e.g. `curl -H "Authorization: Bearer sk-…"`.
3. **Records.** Each secret block is a decision-log line that carries the
   rule and the fingerprint, never the value. The console's
   "agent touched a secret" card reads these lines.

## Translating the rules

Measured on gitleaks' file, 2026-10-21:

| Construct in the rule                      | Rules | Translation                                                                                                                   |
| ------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| Scoped modifiers `(?i:…)`                  | 38    | Node 23+ only, so they are rewritten: each letter becomes `[xX]` inside the scope                                             |
| A bare `(?i)` mid-pattern                  | 22    | rewritten as above from that point; a leading `(?i)` becomes the `i` flag                                                     |
| `(?P<name>…)`                              | 1     | becomes `(?<name>…)`                                                                                                          |
| `\z`, POSIX classes `[[:alnum:]]`          | 6     | `$` (no `m` flag) and explicit classes. These six translated **silently wrong** in a naive port, so each carries its own test |
| Unicode                                    | —     | never the `u` flag. Inputs are capped (existing `MAX_SCAN_BYTES`, and 1 MiB per line in the hook)                             |
| `keywords`, `entropy`, `allowlist`, `path` | —     | ported: keywords pre-filter, Shannon entropy threshold, per-rule allowlists and path filters                                  |

Translation is done by `scripts/gitleaks-port.mjs`. It reads the upstream
file at a pinned commit and writes `src/secret-rules.generated.mjs` with the
licence notice and the commit. It refuses any construct it does not know,
so it never guesses. A test re-runs the port and requires byte-identical
output.

**Samples.** gitleaks' Go rule sources carry true- and false-positive
samples for each rule (`cmd/generate/config/rules/*.go`). Those samples
become the both-sided corpus: every rule must catch its true samples and
pass its false samples. This is the C-13 class detector, due 2026-10-28
(`findings/classes.json` stopline debt). Rules without samples get one true
and one false sample written here, each with its source.

**Benign corpus.** Precision (F-75) is measured on:

- this repository;
- the Node.js `lib/` folder at a pinned tag;
- a translation-files sample;
- an Ansible variables sample.

The false-positive count per rule is recorded. A rule above its budget is
disabled by default and listed as such, never shipped noisy.

## Adversary table

| #   | Move                                                                                                                           | Must-hold outcome                                                                                                                                       | Guard test                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Read `.env` through another route: Read tool, `cat`, `head`, `less`, `grep`, `awk`, `cp .env x && cat x`, `source .env && env` | `secret.read` → deny on every route; the copy is denied at the source                                                                                   | `test/secret-guard.test.mjs::every read route to a secret file is denied`            |
| 2   | Secret file under an odd name: `.env.production.local`, `config/.env`, `../other/.env`, symlink `notes.txt → .env`             | names matched after symlink resolution; the list is the gitleaks/dotenv set plus `*.pem`, `id_*`, `*.p12`, `credentials`, `.npmrc`, `.netrc`, `.pgpass` | `test/secret-guard.test.mjs::secret files are recognised through aliases`            |
| 3   | Write a key into source: Edit adding `AWS_SECRET_ACCESS_KEY="…"`                                                               | the Edit's new content is scanned → deny with the rule and fingerprint                                                                                  | `test/secret-guard.test.mjs::an edit that writes a secret is denied`                 |
| 4   | Paste a secret into a command: `curl -H "Authorization: Bearer <token>"`                                                       | the command text is scanned → deny                                                                                                                      | `test/secret-guard.test.mjs::a command carrying a literal secret is denied`          |
| 5   | Dump the environment: `printenv`, `env`, `set`, `export -p`, `cat /proc/self/environ`                                          | `secret.read` → deny                                                                                                                                    | `test/secret-guard.test.mjs::environment dumps are denied`                           |
| 6   | Split the secret: `"sk-" + "abc…"`, base64 it                                                                                  | not caught by patterns. This is ceiling 1; the commit scan catches it if it is ever committed whole                                                     | —                                                                                    |
| 7   | A secret in the decision log or console                                                                                        | only fingerprints and rule names are written; a test plants a secret and greps every output                                                             | `test/secret-guard.test.mjs::no secret value reaches the log, the console or stderr` |
| 8   | Catastrophic backtracking on a hostile line                                                                                    | every translated rule runs over 200 KB adversarial lines within a step counter                                                                          | `test/secret-guard.test.mjs::every translated rule is linear on hostile input`       |
| 9   | One secret matched by two rules is reported twice (F-122)                                                                      | overlapping spans merge to one finding naming both rules                                                                                                | `test/secret-guard.test.mjs::one secret matched by two rules is one finding`         |

## Input-space table

| Input        | Classes covered                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| Rule file    | Pinned commit; a construct the port does not know (→ refuse); a rule with no samples (→ hand samples, source named)   |
| Text scanned | Empty; ASCII; UTF-8 with combining marks and lookalikes; CRLF; one 1 MiB line; binary (skipped, counted)              |
| Paths        | The secret-file list; case variants; symlinks in and out; files that do not exist yet (Write)                         |
| Hook calls   | Read, Edit (old and new strings), Write (content), NotebookEdit, Bash (command text), MCP arguments (scanned as text) |

## Evidence-source declaration

| Claim                       | Source                                       | Strength                                                                                |
| --------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| "A secret was blocked"      | rule match on the call's text, fingerprinted | A pattern match, not proof it was a live credential. The console says "matched rule R". |
| "The commit has no secrets" | the staged scan                              | Only for the patterns and the bytes the commit records (existing spec)                  |

## Ceilings

1. **Split, encoded and computed secrets** are not caught by patterns.
2. **Secrets in tool output.** A secret that reaches the agent through a
   tool's output is already in its context; PreToolUse cannot unsee it.
   Reads are blocked before they happen, which is why the read routes
   matter most.
3. **Personal data** (ID numbers, IBANs) is not a secret rule. It belongs
   to the enterprise edition's data-loss prevention.

## History pitfalls

| Class                                         | How this design avoids it                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| C-02 A list stands in for the rule (F-122)    | overlapping findings merge by span, not by rule list                                          |
| C-04 Unbounded cost                           | linear-time check per rule on hostile input, by step counter                                  |
| C-05 A statement the code does not keep       | the rule count and the disabled-by-default list in the docs are generated from the rules file |
| C-12 Literal without context                  | allowlists and entropy from gitleaks; false samples per rule                                  |
| C-13 Detector tuned on one side (F-75, F-119) | true and false samples per rule, plus the benign corpus                                       |
