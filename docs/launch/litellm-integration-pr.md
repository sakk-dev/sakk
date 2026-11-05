# Draft: a pull request to LiteLLM's docs (not submitted)

> **Do not submit before launch day.** Every link below points at
> github.com/sakk-dev/sakk and at the `sakk-litellm` package on PyPI, which
> 404 until the repository is public and the package is uploaded
> (`docs/launch/pypi-publish.md`). Submitting the pull request to
> BerriAI/litellm is the owner's action, from the owner's account.
>
> Before submitting, check two things against that day's code:
>
> - The section "When the ledger cannot be reached" describes the fail-open
>   behaviour with `SAKK_ON_UNAVAILABLE`. Compare it with
>   `integrations/litellm/README.md` once the fail-open change is merged, and
>   correct the draft if they differ.
> - LiteLLM's docs folder layout and sidebar (`docs/my-website/sidebars.js`)
>   on their main branch; the path proposed below is a guess from the
>   existing callback pages.

## (a) The docs page

Proposed path: `docs/my-website/docs/observability/sakk_integration.md`, with
an entry next to the other callbacks in `docs/my-website/sidebars.js`.

````markdown
# Sakk - spend gate

[Sakk](https://github.com/sakk-dev/sakk) puts a hard spend cap in front of
the LiteLLM proxy. Before each chat call reaches the provider, the
`sakk_gateway` callback reserves the call's worst-case cost in a local Sakk
ledger, using the prices in your `config.yaml`. A call that would go over
the cap is refused before any tokens are bought. After the call, the real
cost is settled and the rest of the reservation is released.

A call the gate cannot price is refused, not let through: a model without a
price in `config.yaml`, a wildcard model, or a route with no cost model.

:::info

Sakk is open source (Apache-2.0). The ledger is a file on your machine; no
data leaves it.

:::

## Install

Install LiteLLM from Sakk's hash-locked requirements, then the plugin
without dependencies:

```shell
curl -fsSLO https://raw.githubusercontent.com/sakk-dev/sakk/main/integrations/litellm/requirements.lock
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python --require-hashes -r requirements.lock
uv pip install --python .venv/bin/python --no-deps sakk-litellm
npm install -g @sakk-dev/sakk
sakk init --cap 5 --ledger /abs/path/ledger.json --by you
```

## Usage with LiteLLM Proxy

Every model needs a price. Prices are USD per token, written as decimals:

```yaml
model_list:
  - model_name: deepseek-chat
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: os.environ/DEEPSEEK_API_KEY
      input_cost_per_token: 0.00000028
      output_cost_per_token: 0.00000042
      max_retries: 0

litellm_settings:
  callbacks: sakk_gateway.handler
  num_retries: 0

router_settings:
  num_retries: 0

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

Retries are off so one reservation covers one provider request.

```shell
export SAKK_BIN=$(npm root -g)/@sakk-dev/sakk/bin/sakk.mjs
export SAKK_LEDGER=/abs/path/ledger.json
export SAKK_GATEWAY_CONFIG=$PWD/config.yaml
export LITELLM_MASTER_KEY=sk-choose-a-long-random-key
.venv/bin/litellm --config config.yaml --host 127.0.0.1 --port 4000
```

## Environment variables

| Variable                  | Required | Default | Meaning                                         |
| ------------------------- | -------- | ------- | ----------------------------------------------- |
| `SAKK_BIN`                | yes      |         | Path to sakk's `bin/sakk.mjs`                   |
| `SAKK_LEDGER`             | yes      |         | Absolute path of the ledger file                |
| `SAKK_GATEWAY_CONFIG`     | yes      |         | The proxy's `config.yaml`; prices are read here |
| `SAKK_NODE`               | no       | `node`  | Node executable that runs Sakk                  |
| `SAKK_DEFAULT_MAX_TOKENS` | no       | 2048    | `max_tokens` added when a request has none      |
| `SAKK_TIMEOUT_S`          | no       | 10      | How long one ledger call may take               |
| `SAKK_LATE_SETTLE_S`      | no       | 2       | Wait before charging the worst case on errors   |
| `SAKK_ON_UNAVAILABLE`     | no       | `allow` | `deny` refuses calls while the ledger is down   |

The proxy does not start without the three required variables.

## When the ledger cannot be reached

If Sakk cannot be run or the ledger file cannot be read, the call goes
through by default and is not recorded in the ledger. Set
`SAKK_ON_UNAVAILABLE=deny` to refuse those calls with
`SAKK_UNAVAILABLE` (503) instead, so nothing is spent while the cap cannot
be checked.

## Refusals

A refused call gets an HTTP error with the code in the response body and is
never sent to the provider.

- `BUDGET_EXCEEDED` (402): the worst case would pass the cap; the provider
  was not called.
- `RECONCILIATION_REQUIRED` (402): an earlier call cost more than its
  reservation; a person must act before the next call.
- `SAKK_NO_PRICE` (403): the model has no price in `config.yaml`.
- `SAKK_UNMETERED` (403): the route, or a part of a message, cannot be priced
  before the call.
- `SAKK_BAD_REQUEST` (400): `max_tokens` is not a positive integer, or the
  request cannot be read.
- `SAKK_UNAVAILABLE` (503): the ledger cannot be reached and
  `SAKK_ON_UNAVAILABLE=deny` is set.

## Run it as a service

Templates for launchd (macOS) and a systemd user service (Linux), which
restart the proxy if it stops and bind 127.0.0.1 only, are in
[integrations/litellm/service](https://github.com/sakk-dev/sakk/tree/main/integrations/litellm/service).
````

## (b) The pull request

**Title:** `docs: add Sakk spend gate callback`

**Body:**

```markdown
## Title

docs: add Sakk spend gate callback

## Relevant issues

None.

## Type

📖 Documentation

## Changes

- Adds `docs/observability/sakk_integration.md`: a callback page for
  [Sakk](https://github.com/sakk-dev/sakk), an open-source (Apache-2.0)
  spend cap for the proxy. The `sakk_gateway.handler` callback reserves
  each chat call's worst-case cost before the provider is called and
  settles the real cost after, so a cap is never overrun; calls it cannot
  price are refused.
- Adds the page to `sidebars.js` next to the other callbacks.

Docs only; no code in LiteLLM changes. The callback is a `CustomLogger`
loaded with `litellm_settings.callbacks`, published on PyPI as
`sakk-litellm`, and tested end to end against the proxy (1.106.2) in
Sakk's CI.

## Pre-Submission checklist

- [x] Documentation only; no tests needed in this repository
- [x] I have read the contributing guide
```
