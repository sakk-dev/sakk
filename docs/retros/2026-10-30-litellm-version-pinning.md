# Retro: pinning LiteLLM after its compromised releases (2026-10-30)

Blameless. Decision D14 in docs/DECISIONS.md; commit 90c02ab.

This one is a near miss, not an incident: nothing compromised was ever
installed. It is written up because the risk was real and the mechanism is
worth reusing.

## What happened

While adding the LiteLLM gateway plugin (ADR-0007), the design had to pick a
LiteLLM version. LiteLLM's PyPI releases had been compromised twice: 1.82.7
and 1.82.8 in March 2026, and 1.107.0 on 2026-10-21, each published with a
credential stealer. An unpinned install resolves to the newest release,
so a compromised build that is live on the index would land in a process
that holds provider keys.

## Impact

None observed. The exposure was the install step itself: the gateway holds
every provider key, so a compromised dependency there would see all of them.

## Root cause

A gateway sits where secrets concentrate, and Python installs resolve to the
newest release by default. Upstream package publishing is outside this
project's control.

## What changed

- LiteLLM is pinned to 1.106.2, published before the October release.
- The install is hash-locked: the lock file is compiled with
  `--generate-hashes` and `--exclude-newer 2026-10-21T11:00:00Z`, and
  installed with `--require-hashes`. The lock holds 117 packages, about
  472 MB.
- `integrations/litellm/README.md` says not to move to a newer version until
  LiteLLM's advisory names it safe, with links to the advisories.

Guard test: none in CI. The gateway's Python tests,
`integrations/litellm/test_sakk_gateway.py`, run by hand; a CI job for them
is a v2 item. There is no ledger finding for the pin, because no fault was
found.

## What we'd do differently

- Check a dependency's recent advisories before choosing a version, as was
  done here, and make it a written step for every new dependency that will
  see secrets.
- Add a CI check that the lock file still pins the reviewed version and
  carries hashes.
