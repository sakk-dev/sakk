# Secret scanning — three tables + contract

Plan item ②, L1 (a safety red line: secrets leaving the machine). Written
after implementation: the testing standard's audit found this L1 change had
no three-tables file (finding F-53). Every guard names the test that holds
it; `test/core-specs.test.mjs` checks the names resolve.

## Table 1 — danger surface

| Surface     | Danger                                                                          | Guard (mechanism + test)                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exemption   | A real secret passes because a fiction token sits somewhere in the match        | exemption judged on the secret capture only · `test/secret-scan.test.mjs::a token in the USERNAME does not exempt a real password` (drill MUT-J)                 |
| Exemption   | An exempt match swallows a real secret beside it (F-63)                         | only reported findings close a span to the second pass · `test/secret-scan.test.mjs::F-63: an exempt match never hides a real secret it swallowed` (drill MUT-S) |
| Staged scan | A blob the commit records goes unscanned (type change, odd names, subdirectory) | blob ids from one `git diff --raw` record · `test/secret-scan.test.mjs::a TYPE change (symlink → file holding a secret) is scanned` (drill MUT-K)                |
| Staged scan | Two names that decode alike hide a secret blob                                  | no name join · `test/secret-scan.test.mjs::two names that decode alike cannot hide a secret blob from the installed hook`                                        |
| Hook        | The hook runs something other than this installation, or is silently ignored    | absolute path, `wx`, chmod past umask · `test/secret-scan.test.mjs::installed under umask 177 the hook is still executable and still refuses secrets`            |
| Inputs      | A scan of nothing reads clean                                                   | missing/unreadable/special ⇒ exit 2 · `test/secret-scan.test.mjs::a mistyped path exits 2 SCAN_PATH_MISSING`                                                     |
| Output      | The scanner itself prints a secret (value, path, reversible hash)               | keyed fingerprints, redacted names · `test/secret-scan.test.mjs::a secret in a FILE NAME is redacted in output and counted as a finding`                         |
| Patterns    | A hostile line costs super-linear time                                          | bounded quantifiers · `test/secret-scan.test.mjs::200KB adversarial lines for every rule scan without catastrophic backtracking`                                 |

## Table 2 — failure modes

- Finding → exit 1, one line per finding (rule, path, line, fingerprint).
- Could not look everywhere → exit 2 (`SCAN_PATH_MISSING`, `SCAN_UNREADABLE`, `SCAN_NOT_A_REPO`, `SCAN_GIT_MISSING`, `SCAN_USAGE`).
- Hook cannot be installed → exit 2 (`SCAN_HOOK_EXISTS`, `SCAN_HOOK_DIR_MISSING`, `SCAN_HOOK_UNWRITABLE`, `SCAN_HOOK_EPHEMERAL`).
- Not covered by design (stated in README): unquoted `.env` values, encoded or split secrets, personal data — measured in `scripts/attack-asr.mjs` as KNOWN rows.

## Table 3 — audit questions

- Which rule matched, in which file and line? Is it the same secret as last run? (fingerprint, comparable with `SAKK_SCAN_KEY`)
- What was skipped and why? (summary counts)

## Contract

`sakk scan` never prints a secret, never reads "clean" when it could not
look, and the installed hook scans exactly what the commit records.
