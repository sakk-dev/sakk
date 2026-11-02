# LiteLLM gateway: let calls through when Sakk cannot answer

Threat-model note for a core-area diff (`bin/sakk.mjs`, `src/console.mjs`,
new `src/gateway-status.mjs`), written in the `specs/retro/` shape. The
behavior change itself lives in `integrations/litellm/sakk_gateway.py`.

Decision (the maintainer, 2026-11-02): when Sakk cannot answer, the gateway lets the
call through by default instead of taking the user's service down, and says
so loudly. `SAKK_ON_UNAVAILABLE=deny` keeps the old 503.

## Table 1 — current behavior

| #   | Surface                   | Before this change                                                                     |
| --- | ------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Sakk process dead or hung | every call answers 503 `SAKK_UNAVAILABLE` after up to 10 s; the provider is not called |
| 2   | dead process, next call   | respawned only after a call has already failed                                         |
| 3   | operator visibility       | an ERROR log line per call; nothing in `sakk status` or the console                    |
| 4   | structured Sakk refusal   | 402 with the Sakk code                                                                 |
| 5   | `config.example.yaml`     | carries a Claude route                                                                 |

## Table 2 — target behavior

| #   | Surface                  | After                                                                                                                                                                                                                       |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sakk dead, hung, garbage | allow (default): the call goes to the provider, unmetered; one JSON WARNING line, header `x-sakk-status: unmetered`, outage counted in the status file. deny: 503 as before, outage still counted                           |
| 2   | dead process, next call  | the call respawns it once and sends the request again only if it never reached the old process; if the new process answers, the call is metered. A request that was written and got no reply is an outage, never sent again |
| 3   | operator visibility      | `sakk status` line and `--json` `gateway` key; red console banner on every page during an outage, a warning after it; red banner if the gateway's health check fails                                                        |
| 4   | structured Sakk refusal  | unchanged in both modes: any answer from Sakk within the timeout is a refusal, never an outage; a refusal also ends an open outage                                                                                          |
| 5   | `config.example.yaml`    | no Claude route                                                                                                                                                                                                             |
| 6   | reserve timeout          | 2 s by default (was 10 s); settle uses the same value                                                                                                                                                                       |

## Adversary table

| #   | Who                                             | Attack                                                                                                                      | Answer                                                                                                                                                                                                | Guard                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | a client of the gateway                         | sends `metadata.sakk_unmetered: true` to skip settlement or earn the unmetered header                                       | the pre-call hook drops the key before anything reads it; only the gateway's own outage branch sets it                                                                                                | `test_sakk_gateway.py::test_u4_a_client_cannot_mark_its_own_call_unmetered`, `::test_k_a_metered_call_carries_no_unmetered_header`                                                                                                               |
| A2  | a client over the cap                           | hopes a refusal is treated as an outage and let through                                                                     | allow is reached only from `SakkUnavailable`; every structured answer that arrives within the timeout is `SakkRefused` and stays 402 (a lock held past the timeout is no answer: see the input table) | `test_sakk_gateway.py::test_o7_budget_exceeded_is_still_402_in_allow_mode`, `::test_u5_in_allow_mode_a_refusal_stays_a_refusal_and_an_outage_logs_a_warning`                                                                                     |
| A3  | anything that can stall Sakk                    | holds the process so every call waits                                                                                       | each wait is capped at `SAKK_TIMEOUT_S` (2 s), then allow or deny; a zero or non-numeric timeout refuses to start, so it cannot make every call unmetered                                             | `test_sakk_gateway.py::test_o5_a_hung_sakk_times_out_and_the_call_goes_through`                                                                                                                                                                  |
| A4  | a local user who can write the folder           | plants a status file: huge, a FIFO, a symlink, wrong types, terminal escapes in the reason                                  | the reader opens with O_NOFOLLOW and O_NONBLOCK, refuses over 64 KiB, copies a fixed set of typed fields; the CLI escapes text; the page sets textContent only                                        | `test/gateway-status.test.mjs::a broken, oversized or linked status file is a typed error, not a healthy gateway`                                                                                                                                |
| A5  | same                                            | deletes the status file to hide an outage                                                                                   | not prevented: the file is a report, not evidence. The WARNING log lines remain the record; the README says so                                                                                        | documented limit                                                                                                                                                                                                                                 |
| A6  | a page visitor without the console token        | reads outage figures or makes the console probe an address                                                                  | `/api/gateway` is behind the same token, Host and Origin checks as every route; the probe URL comes from the console's environment, never the request                                                 | `test/console.test.mjs::/api/gateway answers behind the token and probes the gateway it names`                                                                                                                                                   |
| A7  | a gateway that never answers its probe          | slows every page                                                                                                            | the probe is capped at 500 ms over the whole exchange and one result is shared for 5 s                                                                                                                | `test/gateway-status.test.mjs::gatewayView probes only with a status file, at most once per window`                                                                                                                                              |
| A8  | a Sakk process that dies after taking a reserve | a resend with the same callId is refused as `DUPLICATE_CALL_ID`, so a valid call gets 402 and the first reservation is held | the request is sent again only when the write itself failed (broken pipe, reset, `EPIPE`) on a process that was already running; a written request with no reply is an outage                         | `test_sakk_gateway.py::test_r2_a_reply_lost_after_the_request_was_written_is_an_outage_not_a_second_reserve`, `::test_r1_a_request_that_never_reached_a_dead_sakk_goes_to_a_fresh_one`, `::test_r3_a_fresh_sakk_that_fails_is_an_outage_at_once` |
| A9  | an operator who names the ledger another way    | `sakk status` or the console given a relative or linked ledger path reads a different status file and shows no outage       | both sides resolve the ledger's folder to its real path before adding `.gateway.json`                                                                                                                 | `test_sakk_gateway.py::test_u7_the_status_path_is_the_one_sakk_status_reads`, `test/gateway-status.test.mjs::a relative ledger path, or one through a linked folder, names the file the gateway writes`                                          |
| A10 | an outage followed only by refusals             | the outage stays open on every page although Sakk is answering                                                              | a refusal ends the outage the same as a reservation                                                                                                                                                   | `test_sakk_gateway.py::test_u6_a_refusal_after_an_outage_ends_the_outage`                                                                                                                                                                        |

## Input-space table

| Input                 | Pathological values                                                                                                                                        | Handling                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAKK_ON_UNAVAILABLE` | empty, `Allow`, `off`, `sometimes`                                                                                                                         | refuse to start                                                                                                                                           |
| `SAKK_TIMEOUT_S`      | `0`, `-1`, `nan`, `inf`, `abc`                                                                                                                             | refuse to start                                                                                                                                           |
| Sakk reply            | none (exit), none (hang), EOF, non-JSON, wrong id                                                                                                          | `SakkUnavailable` → allow or deny                                                                                                                         |
| Sakk reply            | `isError` with any code that arrives within `SAKK_TIMEOUT_S`, including `LEDGER_LOCK_UNAVAILABLE`, `LEDGER_MISSING`                                        | `SakkRefused` → 402 in both modes; ends an open outage                                                                                                    |
| ledger file lock      | held by another process longer than `SAKK_TIMEOUT_S`; Sakk itself waits about 2 s, so with the default 2 s timeout the gateway usually stops waiting first | no answer in time: `SakkUnavailable`, the way Envoy's `ext_authz` treats a slow authorization service → allowed, recorded and shown red; 503 in deny mode |
| request write         | broken pipe, connection reset, `EPIPE`, on a process that was already running                                                                              | sent again once, to a fresh process; any failure after the write, or on a fresh process, is an outage                                                     |
| ledger path           | relative, through a linked folder                                                                                                                          | both sides resolve the folder; one status file                                                                                                            |
| status file           | absent, empty, not JSON, version 2, negative counts, string counts, NaN, >64 KiB, link, directory                                                          | absent → null; everything else → typed `GATEWAY_STATUS_*` error                                                                                           |
| status file write     | folder missing, rename fails, disk full                                                                                                                    | ERROR log, call unaffected, temp file removed                                                                                                             |
| `SAKK_GATEWAY_URL`    | `file:`, `ftp:`, not a URL, a port nothing listens on, a server that never answers                                                                         | `GATEWAY_URL_INVALID` / the error code / `timeout`; red banner                                                                                            |

## Evidence source

The outage counts are the gateway's report about itself, in a file it writes.
They are never ledger records, and every surface says "the gateway reports"
or "not in this ledger". The Python tests drive a real LiteLLM proxy against
the repo's mock provider and break Sakk through a wrapper script (exit at
once, or sleep past the timeout); the provider's own hit counter shows
whether a call went out.

## Known limits (stated in integrations/litellm/README.md)

- Calls let through during an outage are not in the ledger and not capped.
- One gateway process per ledger: the status-file lock is in-process.
- A reservation that timed out, or whose reply was lost, may still land and
  stay reserved: over-counts.
- Calls queue on the client lock; while Sakk hangs each adds up to 2 s.
- Outage status writes take the lock and fsync on the event-loop thread: a
  slow disk delays every call in the worker while an outage opens, counts or
  ends.

## Acceptance contract

Done means: the Python unit and E2E tests named above pass on LiteLLM 1.106.2
with the mock provider; `npm run test:all`, `npm run drill`, format and lint
pass; each new test fails on main (old code: 503, no header, no status file,
no `gateway` key, no banner).
