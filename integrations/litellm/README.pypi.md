# sakk-litellm

The Sakk spend gate for the [LiteLLM](https://github.com/BerriAI/litellm)
proxy. Every chat call through the proxy reserves its worst-case cost in a
Sakk ledger before the provider is called, and settles the real cost after.
A call the gate cannot price or meter is refused.

This package is the plugin only, the module `sakk_gateway`. The ledger is
kept by [Sakk](https://github.com/sakk-dev/sakk), a Node.js command-line tool
(`npm install -g @sakk-dev/sakk`), which the plugin runs for every reservation.

## Install

LiteLLM 1.82.7, 1.82.8 and 1.107.0 were compromised on PyPI. Install LiteLLM
from Sakk's hash-locked file first, then this package without dependencies,
so nothing else picks the LiteLLM version:

```bash
curl -fsSLO https://raw.githubusercontent.com/sakk-dev/sakk/main/integrations/litellm/requirements.lock
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python --require-hashes -r requirements.lock
uv pip install --python .venv/bin/python --no-deps sakk-litellm==0.4.1
```

The package's own requirement, `litellm[proxy]>=1.106.2,!=1.107.0`, keeps the
known compromised releases out if you install it another way.

## Use

In the proxy's `config.yaml`:

```yaml
litellm_settings:
  callbacks: sakk_gateway.handler
```

Then set `SAKK_BIN` (sakk's `bin/sakk.mjs`), `SAKK_LEDGER` (the ledger file)
and `SAKK_GATEWAY_CONFIG` (this `config.yaml`, which holds the prices) and
start the proxy on 127.0.0.1. The full guide, the price format and the
refusal codes are in
[integrations/litellm](https://github.com/sakk-dev/sakk/tree/main/integrations/litellm).

Apache-2.0. See LICENSE and NOTICE.
