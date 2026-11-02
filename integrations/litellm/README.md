# Sakk spend gate for the LiteLLM proxy

Put the [LiteLLM proxy](https://docs.litellm.ai/docs/simple_proxy) between
your application and the model providers, load `sakk_gateway.py` as a
callback, and every chat call reserves its worst-case cost with Sakk before
the provider is called and settles the real cost afterwards. When the
reservation would pass the cap, the provider is never called and the client
gets HTTP 402.

If Sakk itself cannot answer, the gateway lets calls through by default,
unmetered and loudly, so a Sakk outage does not take your service down. See
[When Sakk cannot answer](#when-sakk-cannot-answer).

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
Install only the pinned version, from the hash lock committed next to this
file, the same way CI does:

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python --require-hashes --no-build -r integrations/litellm/requirements.lock
```

The lock's input is `integrations/litellm/requirements.in`, one line,
`litellm[proxy]==1.106.2`, with the command that regenerates the lock in its
comments. Version 1.106.2 was published before the October release. The lock
comes to 117 packages, about 472 MB. Do not move to a newer version until
LiteLLM's advisory names it safe.

Installed Sakk from npm? The lock is not in the npm package, so make the
same kind of lock from the same one-line input. These are the steps
`sakk gateway init` prints when it finds no `litellm`; the cut-off date
keeps out every release published after 2026-10-21 11:00 UTC, 1.107.0
included:

```bash
printf 'litellm[proxy]==1.106.2\n' > req.in
uv venv --python 3.12 .venv
uv pip compile req.in --generate-hashes --exclude-newer 2026-10-21T11:00:00Z -o req.lock
uv pip install --require-hashes -r req.lock
```

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
`SAKK_GATEWAY_CONFIG`, or with a `SAKK_ON_UNAVAILABLE` other than `allow` or
`deny`, or a `SAKK_TIMEOUT_S` that is not a positive number. Optional
settings:

| Variable                  | Default                      | Meaning                                              |
| ------------------------- | ---------------------------- | ---------------------------------------------------- |
| `SAKK_NODE`               | `node`                       | Node executable that runs Sakk                       |
| `SAKK_DEFAULT_MAX_TOKENS` | 2048                         | `max_tokens` added when a request has none           |
| `SAKK_TIMEOUT_S`          | 2                            | How long one ledger call may take, reserve or settle |
| `SAKK_LATE_SETTLE_S`      | 2                            | Wait before charging the worst case on errors        |
| `SAKK_ON_UNAVAILABLE`     | `allow`                      | `allow` or `deny` a call when Sakk cannot answer     |
| `SAKK_GATEWAY_STATUS`     | `<SAKK_LEDGER>.gateway.json` | Where the gateway records outages                    |
| `SAKK_GATEWAY_URL`        | `http://127.0.0.1:4000`      | Read by the console, which checks the gateway is up  |

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

## When Sakk cannot answer

Sakk cannot answer when its process will not start, crashes, closes its
pipe, takes longer than `SAKK_TIMEOUT_S` (2 seconds by default), or replies
with something that is not a valid answer. A process that died since the last
call is started again within the next call, and the request goes to the new
one only if it never reached the old one (the pipe was already closed). If
the new one answers, that call is metered as usual. A request that was
written and then got no reply is not sent again: the first reservation may
have landed, and Sakk would refuse the same call id twice. That call counts
as an outage, and the reservation, if it landed, is held until a person
reconciles it.

With the default, `SAKK_ON_UNAVAILABLE=allow`, the gateway then sends the
call to the provider anyway, and says so:

- one WARNING log line per call, in JSON, with `"event": "sakk_unavailable_allowed"`,
  the model, the call's worst-case price (`est_max_usd`), the reason, when the
  outage began (`outage_since`) and how many calls it has let through
  (`allowed_calls`);
- the response header `x-sakk-status: unmetered`, on plain and streamed
  responses;
- an outage record in the status file (below). `sakk status` prints it,
  `sakk status --json` returns it under `gateway`, and the console shows a red
  banner on every page while the outage lasts.

The first reservation Sakk answers again ends the outage. The record moves to
`last_outage`, the gateway logs a `sakk_outage_ended` line, and the console
shows a yellow note instead of the red banner.

**Calls let through during an outage are not recorded in the ledger and are
not capped.** `est_max_unrecorded_usd` is the sum of their worst-case prices:
an upper bound, not a spend. Check the provider's bill for that window. If no
call may ever go out unmetered, set `SAKK_ON_UNAVAILABLE=deny`. Those calls
then get 503 `SAKK_UNAVAILABLE` and the provider is not called; the outage is
still recorded, with `allowed_calls` at 0.

A refusal from Sakk is an answer, not an outage, and stays a refusal in both
modes: 402 over the cap, halted, or reconciliation required, and any other
code Sakk returns within `SAKK_TIMEOUT_S`. A refusal also ends an open outage,
the same as a reservation.

A ledger file lock that another process holds is the one case that depends
on timing. Sakk waits about 2 seconds for the lock, then answers
`LEDGER_LOCK_UNAVAILABLE`. If that answer arrives within `SAKK_TIMEOUT_S`, it
is a 402 like any other refusal. A lock held longer than the timeout means
Sakk has not answered in time, and that counts as Sakk cannot answer, the way
Envoy's `ext_authz` filter treats an authorization service that is too slow:
the call is let through, recorded and shown red, or gets 503 in deny mode.
With the default 2-second timeout the gateway usually stops waiting first, so
a held lock usually shows up as an outage, not as a 402.

The gateway's own 403 and 400 refusals do not depend on Sakk at all.

### Status file

The path is `SAKK_GATEWAY_STATUS`, or the ledger path with `.gateway.json`
added, after the ledger's folder is resolved to its real path (a relative
path or a linked folder names the same file). `sakk status` and the console
use the same rule, so if you set
`SAKK_GATEWAY_STATUS` for the gateway, set it for them too. The file is
written whole each time (temporary file, fsync, rename) with mode 0600. A
write that fails is logged at ERROR and the call goes on.

```json
{
  "version": 1,
  "updatedAt": "2026-11-02T06:10:00.000Z",
  "mode": "allow",
  "outage": {
    "since": "2026-11-02T06:02:11.408Z",
    "allowed_calls": 3,
    "est_max_unrecorded_usd": 0.004213,
    "last_reason": "sakk_reserve: TimeoutError: ",
    "last_at": "2026-11-02T06:09:58.120Z"
  },
  "last_outage": null
}
```

`outage` is null while Sakk answers. `last_outage` is the most recent outage
that ended, with the same fields plus `ended_at`. An outage still open when
the gateway restarts keeps counting.

When the status file exists, the console also checks the gateway: it asks
`SAKK_GATEWAY_URL` for `/health/liveliness`, waits at most 500 ms, reuses the
answer for 5 seconds, and shows a red "Gateway not answering at <url>"
banner when the check fails.

## Refusals

| HTTP | Code                      | Meaning                                                           |
| ---- | ------------------------- | ----------------------------------------------------------------- |
| 402  | `BUDGET_EXCEEDED`         | The worst case would pass the cap; the provider was not called    |
| 402  | `RECONCILIATION_REQUIRED` | An earlier call cost more than its reservation; a person must act |
| 402  | other Sakk codes          | The ledger refused, for example while halted                      |
| 403  | `SAKK_NO_PRICE`           | The model has no price in the config, or is a wildcard            |
| 403  | `SAKK_UNMETERED`          | A route other than chat, or a non-text message part (image/audio) |
| 400  | `SAKK_BAD_REQUEST`        | `max_tokens` or `n` is not a positive integer                     |
| 503  | `SAKK_UNAVAILABLE`        | Deny mode only: Sakk cannot answer; no call was made              |

The Sakk code is in the error body, at
`error.provider_specific_fields.error.code`.

## Limits

- **An outage lets calls through unmetered by default.** They are not in the
  ledger and not capped; only the status file and the log count them. Use
  `SAKK_ON_UNAVAILABLE=deny` if that is not acceptable.
- **One gateway process per ledger.** The status file is guarded by a lock
  inside the process, so several LiteLLM workers would overwrite each other's
  outage counts.
- **Outage records are written on the event loop.** Each call that opens,
  counts or ends an outage takes that lock and fsyncs the status file on the
  event-loop thread, so a slow disk delays every call in the worker meanwhile.
  A metered call with no outage open writes nothing.
- **Waiting calls queue.** Calls to Sakk go one at a time, so while Sakk hangs
  each waiting call adds up to `SAKK_TIMEOUT_S` before it goes through.
- **A reservation that timed out may still land.** If Sakk wrote it after the
  gateway gave up, it stays reserved and counts against the cap until a person
  reconciles it. That over-counts; it never under-counts.
- **A direct call bypasses the gateway.** An application holding a real
  provider key can call the provider directly, and Sakk never sees it. Give
  applications only the gateway key.
- **Only chat completions are metered.** Embeddings, images, audio, the
  responses API, Anthropic's `/v1/messages` route and pass-through routes are
  refused, not let through. An Anthropic-SDK client must switch to the
  OpenAI-format route.
- **Paid calls that do not go through LiteLLM are not covered**, for example
  a search API the application calls itself.
- **Cached-input discounts are not applied.** Input is charged at the full
  price, so the ledger can read slightly higher than the provider's bill.
- **The Python tests run in CI but are not a required check.** The `gateway`
  job runs them on every pull request; adding it to main's required checks is
  the owner's call, so read its result before merging. Run them locally:
  `.venv/bin/python -m unittest integrations/litellm/test_sakk_gateway.py -v`.
  They use a local mock provider and a temporary ledger, so they cost
  nothing and do not touch `~/.sakk`.
