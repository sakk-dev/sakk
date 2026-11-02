# `sakk gateway init` — threat-model note

Written with the change (branch `feat/gateway-entry`). `sakk gateway init`
writes three files: the shipped LiteLLM callback, a `config.yaml` copied from
`config.example.yaml`, and a `start.sh` that names the node, the sakk, the
ledger and the `litellm` the gateway runs with. Whoever controls `start.sh`
controls which ledger the gateway charges and which program receives the
provider keys, so it is treated as guard state when it lives in Sakk's home.

## Adversaries

- **A guarded coding agent.** Touches: shell commands, files in the project.
  Guard: the hook judges `sakk gateway init` as the write of `start.sh`
  (src/classify.mjs); under `SAKK_HOME` that is guard state and is denied
  (kill-switch R-24).
- **Whoever chooses `--dir`, `--ledger` or another path.** Touches: text that
  ends up inside a shell script. Guard: every path is made absolute and
  single-quoted with embedded quotes escaped; the port must be an integer
  1024-65535.
- **Something planted at a target name.** Touches: a file or symlink at
  `start.sh`, `config.yaml` and the rest. Guard: without `--force` any
  existing name refuses; new files use an exclusive create; `--force` writes
  a temp file and renames it, replacing a link, not its target.
- **A stale install (npx cache cleaned, node upgraded).** Touches: the paths
  `start.sh` pins. Guard: refused from an npx, bunx or pnpm dlx cache;
  `start.sh` checks node, sakk and the ledger exist and exits `GATEWAY_STALE`
  before starting litellm.
- **A hostile `PATH` or `--litellm`.** Touches: which `litellm` is pinned.
  Guard: only absolute `PATH` entries count; the file must be a regular
  executable; `gateway init` never runs it, and prints its path so a person
  can see it.
- **Anyone reading the written files.** Touches: `config.yaml`, `start.sh`.
  Guard: no key is written; keys stay `os.environ/` references and come from
  the environment `start.sh` is started in; the tests run the secret scanner
  over them.

## Input space

- **subcommand:** none, `init`, another word, `init` plus an extra word.
  Only `init` runs; the rest give `GATEWAY_USAGE`, exit 2, nothing written.
- **`--port`:** absent (4000), 1024-65535, 80, 70000, `4000.5`, `abc`. Out of
  range or not an integer gives `GATEWAY_PORT_INVALID`, exit 2.
- **ledger:** readable, missing, not JSON. Missing or unreadable gives
  `GATEWAY_LEDGER_UNREADABLE`, exit 1.
- **litellm:** on `PATH`, only in a relative `PATH` entry, not executable, a
  folder, none. Only an absolute, executable regular file counts; otherwise
  the install steps are printed.
- **target files:** none, some, all, a symlink, a folder at a target name.
  Any present gives `GATEWAY_FILES_EXIST` unless `--force`; a failed write
  rolls back what this run created.

## Known open

- The outage behaviour the docs describe (calls go through unmetered when the
  ledger cannot answer) is implemented by the gateway callback, changed in
  `feat/gateway-fail-open`. A test that ties the docs' words to that code is
  to be added once both are on `main`.
- `gateway init` does not check the LiteLLM version; it says so when it runs.
