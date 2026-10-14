# AGENTS.md — eval/

Nearest-file rules for the eval harness. These override the root AGENTS.md
where stricter.

- **Case files are executable code.** `cases/*.json` and `gold/*/scoring.json`
  contain shell commands the harness executes (`verification_commands`,
  `coverage_mutants.cmd`). `schemas/*.json` feed `new RegExp`. Review and
  edit them with the severity of source code.
- **Never copy anything from `gold/` into `fixtures/` or any agent-visible
  surface.** The runner refuses runs on manifest mismatch.
- **After ANY change under `gold/`**, regenerate the manifest:
  `cd eval/gold && find . -type f ! -name manifest.sha256 -print0 | xargs -0 shasum -a 256 | sed 's|  \\./|  |' | sort -k2 > manifest.sha256`
- Machine logs (trace, gate-probe, test log) are runner-owned and live
  OUTSIDE workdirs. Fixture tools append to `$GOLD_TEST_LOG`; nothing else
  writes evidence.
- The scorer never imports the runner. Keep the dependency direction.
- Changing a refusal code, a rule name, a metrics field, or the packet
  prefix breaks the public contract — tests pin them; update both and say so.
- `--real` is fail-closed by design. Do not "fix" the authorization chain to
  make it pass in a fresh checkout.
