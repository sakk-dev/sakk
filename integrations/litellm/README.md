# Sakk spend gate for the LiteLLM proxy

Put the [LiteLLM proxy](https://docs.litellm.ai/docs/simple_proxy) between
your application and the model providers, load `sakk_gateway.py` as a
callback, and every chat call reserves its worst-case cost with Sakk before
the provider is called and settles the real cost afterwards. When the
reservation would pass the cap, the provider is never called and the client
gets HTTP 402.

The proxy speaks the OpenAI chat completions API, so any language that can
send an HTTP request works: Python, Node, Java, PHP, Go, curl. The client
changes two things, the base URL and the key.

## Why LiteLLM

We picked an existing gateway and wrote only the hook:

- **LiteLLM proxy** (MIT licence). It is OpenAI compatible,
  it reaches every provider a production content app uses, and its
  [custom callback](https://docs.litellm.ai/docs/proxy/call_hooks) can
  refuse a call before the provider sees it. This is the one we use.
- **Portkey gateway**, open source. Budgets and guardrail hooks are in the
  hosted or paid tiers, so we did not use it.
- **Bifrost**. Custom logic needs Go plugins built against the gateway, so we
  did not use it.

## Install (pinned)

LiteLLM's PyPI releases have been compromised twice: 1.82.7 and 1.82.8 in
March 2026 ([LiteLLM's security update](https://docs.litellm.ai/blog/security-update-march-2026)),
and 1.107.0 on 2026-10-21
([StepSecurity](https://www.stepsecurity.io/blog/litellm-1-107-0-compromised-pypi-backdoored-wheels-credential-stealer),
[Cloudsmith](https://cloudsmith.com/blog/litellm-1-107-0-compromised-on-pypi)).
Install only the pinned version, from a hash-locked file:

```bash
uv venv --python 3.12 .venv
uv pip compile req.in --generate-hashes --exclude-newer 2026-10-21T11:00:00Z -o req.lock
uv pip install --require-hashes -r req.lock
```

with `req.in` holding one line, `litellm[proxy]==1.106.2`. Version 1.106.2
was published before the October release. The lock comes to 117 packages, about
472 MB. Do not move to a newer version until LiteLLM's advisory names it
safe.

## Run

```bash
cp config.example.yaml config.yaml   # next to sakk_gateway.py
sakk init --cap 5 --ledger /abs/path/ledger.json --by you
export SAKK_BIN=/abs/path/to/sakk/bin/sakk.mjs
export SAKK_LEDGER=/abs/path/ledger.json
export SAKK_GATEWAY_CONFIG=$PWD/config.yaml
export LITELLM_MASTER_KEY=sk-choose-a-long-random-key
export LITELLM_LOCAL_MODEL_COST_MAP=True   # no cost-map fetch at start
export DEEPSEEK_API_KEY=...                # provider keys live here only
.venv/bin/litellm --config config.yaml --host 127.0.0.1 --port 4000
```

The gateway does not start without `SAKK_BIN`, `SAKK_LEDGER` and
`SAKK_GATEWAY_CONFIG`. Optional settings:

| Variable                  | Default | Meaning                                       |
| ------------------------- | ------- | --------------------------------------------- |
| `SAKK_NODE`               | `node`  | Node executable that runs Sakk                |
| `SAKK_DEFAULT_MAX_TOKENS` | 2048    | `max_tokens` added when a request has none    |
| `SAKK_TIMEOUT_S`          | 10      | How long one ledger call may take             |
| `SAKK_LATE_SETTLE_S`      | 2       | Wait before charging the worst case on errors |

### Prices

Prices are USD per token in `config.yaml`, under each model's
`litellm_params`, as `input_cost_per_token` and `output_cost_per_token`.
**Write them as decimals** (`0.00000028`). PyYAML reads `1e-06` as a string,
so a price written that way counts as missing and the model is refused. The
gateway logs the priced models when it starts; check that list.

## Clients

Point the client at `http://127.0.0.1:4000/v1` and send the gateway key.
Keep the provider keys out of the application.

Python (OpenAI SDK):

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:4000/v1", api_key=GATEWAY_KEY)
r = client.chat.completions.create(model="deepseek-chat", max_tokens=512,
                                   messages=[{"role": "user", "content": "hi"}])
```

curl:

```bash
curl -s http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","max_tokens":512,"messages":[{"role":"user","content":"hi"}]}'
```

Java (JDK 11+, no SDK):

```java
var body = """
  {"model":"deepseek-chat","max_tokens":512,
   "messages":[{"role":"user","content":"hi"}]}""";
var req = java.net.http.HttpRequest.newBuilder(
        java.net.URI.create("http://127.0.0.1:4000/v1/chat/completions"))
    .header("Authorization", "Bearer " + gatewayKey)
    .header("Content-Type", "application/json")
    .POST(java.net.http.HttpRequest.BodyPublishers.ofString(body)).build();
var res = java.net.http.HttpClient.newHttpClient()
    .send(req, java.net.http.HttpResponse.BodyHandlers.ofString());
if (res.statusCode() == 402) { /* over the cap: no call was made */ }
```

PHP (curl extension):

```php
$ch = curl_init('http://127.0.0.1:4000/v1/chat/completions');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $gatewayKey, 'Content-Type: application/json'],
  CURLOPT_POSTFIELDS => json_encode(['model' => 'deepseek-chat', 'max_tokens' => 512,
    'messages' => [['role' => 'user', 'content' => 'hi']]]),
]);
$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);   // 402: over the cap
```

The tests run the Python SDK and a plain HTTP client with no SDK. The Java
and PHP snippets send the same request but were not run here, because
neither runtime is installed on the test machine.

Provider fields outside the OpenAI spec pass through. For example, MiniMax's
`reasoning_split` sent in `extra_body` reaches MiniMax.

## How a call is charged

1. **Before the call**, the gateway takes the request's prompt fields and
   `max_tokens` and works out the most the call can cost:
   `(prompt bytes + 512) × input price + (max_tokens + 64) × n × output price`.
   Prompt bytes are an upper bound on tokens. If the request has no
   `max_tokens`, the gateway adds one. It reserves that amount with Sakk. A
   refusal means the provider is not called.
2. **After a success**, it settles the provider's reported usage at the
   configured prices. A stream is made to report usage in its last chunk.
   If no usage comes back, it settles the worst case.
3. **After a provider error** (4xx or 5xx, not a timeout) on a request that
   was not streaming, it settles zero, because the provider answered without
   generating. On a timeout, a dropped connection or a failed stream, it
   settles the worst case, because the provider may have run the call.
4. If the reported cost is above the reservation, Sakk halts the ledger and
   refuses every later call until a person runs `sakk reconcile`.

Retries are off in the example config, so one reservation covers one
provider request.

## Refusals

| HTTP | Code                      | Meaning                                                           |
| ---- | ------------------------- | ----------------------------------------------------------------- |
| 402  | `BUDGET_EXCEEDED`         | The worst case would pass the cap; the provider was not called    |
| 402  | `RECONCILIATION_REQUIRED` | An earlier call cost more than its reservation; a person must act |
| 402  | other Sakk codes          | The ledger refused, for example while halted                      |
| 403  | `SAKK_NO_PRICE`           | The model has no price in the config, or is a wildcard            |
| 403  | `SAKK_UNMETERED`          | A route other than chat, or a non-text message part (image/audio) |
| 400  | `SAKK_BAD_REQUEST`        | `max_tokens` or `n` is not a positive integer                     |
| 503  | `SAKK_UNAVAILABLE`        | The ledger cannot be reached; no call was made                    |

The Sakk code is in the error body, at
`error.provider_specific_fields.error.code`.

## Limits

- **A direct call bypasses the gateway.** An application holding a real
  provider key can call the provider directly, and Sakk never sees it. Give
  applications only the gateway key.
- **Only chat completions are metered.** Embeddings, images, audio, the
  responses API, Anthropic's `/v1/messages` route and pass-through routes are
  refused, not let through. An Anthropic-SDK client must switch to the
  OpenAI-format route to reach Claude through the gateway.
- **Paid calls that do not go through LiteLLM are not covered**, for example
  a search API the application calls itself.
- **Cached-input discounts are not applied.** Input is charged at the full
  price, so the ledger can read slightly higher than the provider's bill.
- **These Python tests are not in CI yet.** Adding a CI job changes the
  required checks, which is the owner's call. Run them locally:
  `.venv/bin/python -m unittest integrations/litellm/test_sakk_gateway.py -v`.
  They use a local mock provider and a temporary ledger, so they cost
  nothing and do not touch `~/.sakk`.
