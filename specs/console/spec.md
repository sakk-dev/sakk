# Local console, `sakk ui` (open-source v1, M4) — spec + three tables

Blueprint: open-source v1, headline 4 ("`sakk ui`"). Target design: the v10
console, open-source edition (`../sakk-console-prototype-v10/`), built
against the real data of M1–M3. It is the first part of Sakk that listens
on a network port, so it is treated as a core area: three tables, a
contract, and review before merge.

## What it is

`sakk ui [--port N] [--allow-halt]` starts a web server on this machine and
prints one address with a random token:

```
Sakk console: http://127.0.0.1:41723/?t=7f3c…  (read-only; Ctrl+C to stop)
```

The pages and their data, as in v10:

| Page                     | Data                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Overview                 | today's spend and cap (M2), the spend ledger's total, and "what the agent did recently" (allowed / blocked / asked)     |
| Spend log (in Overview)  | each metered call in the ledger, the cap, what is reserved and left, and the refusals from the alerts log               |
| Guard rules              | the policy in use, its hash and the try box (calls the same code as `sakk try`)                                         |
| Secret guard             | commit-scan hook status and the "agent touched a secret" card (M3 log lines)                                            |
| Agents                   | connections per agent (from `sakk doctor`'s checks) and per-agent stop (`sakk halt --agent`) when `--allow-halt` is set |
| Records & export         | decision log and spend index; export as CSV and JSONL (FOCUS and evidence bundles are the enterprise edition)           |
| Model prices             | the table in use, its source and hash                                                                                   |
| Enterprise · coming soon | static                                                                                                                  |

The page is one HTML file with inline script and style. It makes no
request to any other origin and uses no dependencies: zero runtime
dependencies, CONSTITUTION #6.

## Security

The prior art is Playwright's `show-report` and UK AISI's Inspect view.

1. **Address.** The server binds `127.0.0.1` only, never `0.0.0.0`. A
   `--host` flag does not exist.
2. **Token.**
   - Every start makes a fresh 128-bit token.
   - Each request must carry it: the first page load in the query string,
     after that in a `SameSite=Strict`, `HttpOnly` cookie. HTTP cookies are
     not isolated by port, so the token itself — a fresh 128-bit secret per
     start — and the `Host` check are the protection, not the cookie's scope;
     the cookie only spares the token from the address bar after the first load.
   - A request without it gets 403 and no data.
3. **Host check.** `Host` must be `127.0.0.1:<port>` or
   `localhost:<port>`, which blocks DNS rebinding.
4. **Origin check.** On every route, GET included, a request that carries an
   `Origin` header other than `http://127.0.0.1:<port>` (or the `localhost`
   form) gets 403 before dispatch (F-195). A request without an Origin header
   (a typed URL, curl, a same-origin GET) passes this gate. Any non-GET
   request must additionally carry the local `Origin` and the token header.
5. **Read-only by default.** The only write is stopping an agent, behind
   `--allow-halt`.
   - It calls the ledger's `halt()` with `by` set to the OS user name and
     the label "self-declared" (F-126).
   - Resume is not in the UI. It stays on the command line, as in v10's
     open-source edition, with one person to resume.
6. **Headers.**
   - `Content-Security-Policy: default-src 'none'; script-src 'self'
'nonce-…'; style-src 'self' 'nonce-…'; connect-src 'self';
img-src 'self' data:; frame-ancestors 'none'`
   - `X-Content-Type-Options: nosniff`
   - `Referrer-Policy: no-referrer`
   - `Cache-Control: no-store` on every response (F-195), and a non-HTML
     response — which carries no nonce — allows no script or style at all.
7. **Output.** Every string from the logs is escaped before it reaches the
   page, and no log text is ever used as HTML. Commands and file contents
   are not in the logs in the first place (M1).
8. **Bounded reads, and no writes.** The decision log is read in pages of 500
   lines from the end, and the spend index M2's hook maintains is read, not
   updated — a GET writes nothing and spawns nothing. The Agents page reports
   the installed state of each hook without firing it (`doctor({probe:false})`),
   so a read-only request never runs a subprocess or blocks on one. A 5 GB log
   never loads whole.
9. **The spend ledger.** The Spend log sub-page under Overview reads
   `GET /api/ledger`, which shows the ledger the console was
   started with (`--ledger`, `config.json` under `SAKK_HOME`, or
   `SAKK_LEDGER_PATH`); the request takes no query and cannot pick a file.
   - With no ledger set the page says so and never shows a $0 cap
     (`test/console.test.mjs::with no ledger set the ledger view says so, never $0`).
   - A refusal from the ledger is shown by its own code — `LEDGER_MISSING`,
     `LEDGER_PATH_NOT_CANONICAL` for a symlink or hard link, and the rest —
     never as an empty ledger
     (`test/console.test.mjs::a ledger path that does not exist answers LEDGER_MISSING, not an empty ledger`,
     `test/console.test.mjs::a symlinked ledger is refused, not read through the link`).
   - A ledger over 32 MiB is refused with `CONSOLE_LEDGER_TOO_BIG` before it is
     read (`test/console.test.mjs::an oversized ledger is refused before it is read`).
   - The calls list is the newest 500, with the total and `truncated`
     (`test/console.test.mjs::the entries list is capped and says when it is cut`).
   - The cap, settled, reserved, remaining and max-reservable figures are the
     object `sakk status --json` prints, from one shared function
     (`test/console.test.mjs::the ledger view and sakk status --json report the same numbers`).
   - Refusals come from `sakk-alerts.jsonl` next to the ledger, newest first,
     with the cap each was judged against; the file is labelled as shared by
     every ledger in that folder, and one that is not a regular file is
     skipped, never opened in a way that can block
     (`test/console.test.mjs::refusals from the alerts log show newest first with the cap they were judged against`,
     `test/console.test.mjs::an alerts file that is not a regular file is skipped, never blocks`).
   - Reading it changes nothing: the ledger's bytes, mtime and folder are the
     same after the request
     (`test/console.test.mjs::reading the ledger view leaves the ledger and its folder untouched`).

## Adversary table

The adversary is a web page in the user's browser, another local user or
process, or a prompt-injected agent that wants the console to lie or to act.

| #   | Move                                                                      | Must-hold outcome                                                          | Guard test                                                                                  |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | A web page fetches `http://127.0.0.1:<port>/api/decisions`                | no token → 403; and the response has no CORS header                        | `test/console.test.mjs::a request without the token gets nothing`                           |
| 2   | DNS rebinding: `evil.example` resolving to 127.0.0.1                      | wrong `Host` → 403                                                         | `test/console.test.mjs::a foreign Host header is refused`                                   |
| 3   | Cross-site POST to stop an agent                                          | no `--allow-halt` → 405; with it, a wrong or missing Origin or token → 403 | `test/console.test.mjs::writes need the flag, the origin and the token`                     |
| 4   | Another machine on the network                                            | the server is bound to loopback only; a test asserts the bound address     | `test/console.test.mjs::the server listens on loopback only`                                |
| 5   | A log line carrying `<script>` (a tool name, a path, an MCP server name)  | escaped and shown as text                                                  | `test/console.test.mjs::log text is escaped everywhere it is shown`                         |
| 6   | Guessing the token                                                        | 128 bits; constant-time compare; 403s are counted and shown                | `test/console.test.mjs::token compare is constant-time and failures are counted`            |
| 7   | A huge log to hang the server                                             | paged reads; a request finishes in bounded work                            | `test/console.test.mjs::a huge decision log is paged, never loaded whole`                   |
| 8   | The console shows spend as billed, or a self-declared stop as signed      | labels "from local logs" and "self-declared (the OS account name)" (F-126) | `test/console.test.mjs::evidence is labelled by its source`                                 |
| 9   | The page loads anything from the network (a CDN font)                     | CSP `default-src 'none'`; a test lists every URL in the HTML               | `test/console.test.mjs::the page makes no request to another origin`                        |
| 10  | A process that can write the ledger folder puts `<script>` in an agent id | returned as JSON data and shown as text                                    | `test/console.test.mjs::hostile ledger text is returned as data, never put into the page`   |
| 11  | The ledger path is swapped for a symlink to another file                  | `LEDGER_PATH_NOT_CANONICAL`; the target is not read                        | `test/console.test.mjs::a symlinked ledger is refused, not read through the link`           |
| 12  | A fifo is put where the alerts log should be, to hang the request         | skipped as "not a regular file"; the ledger still shows                    | `test/console.test.mjs::an alerts file that is not a regular file is skipped, never blocks` |

## Input-space table

| Input       | Classes covered                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request     | Every route with and without the token, cookie, Host and Origin; methods other than GET/POST; paths with `..`, `%2e`, `//`; query strings over 8 KiB |
| Data files  | Absent (pages say "nothing yet" and how to start); empty; malformed lines (counted, shown, skipped); 5 GB                                            |
| Ledger      | Not set; missing; symlinked; over 32 MiB; over 500 calls; hostile text; alerts log absent, a fifo, a directory or a symlink                          |
| Port        | Default (random free port); `--port` in use (refuse, never pick another silently); privileged port (refuse)                                          |
| Environment | Headless (no browser: print the address); `SAKK_HOME` unreadable (refuse at start)                                                                   |

## Evidence-source declaration

The console only shows what M1–M3 recorded, with their labels: decisions
from the hook, spend from local logs, secret blocks as rule matches. It
adds one claim of its own, "the console was read-only", which is as strong
as the flag the server was started with. The header shows it.

## Ceilings

1. Anyone with a shell as the same user can read `$SAKK_HOME` directly. The
   token protects the port, not the files.
2. Open-source sign-in is out of scope for v1 (decided 2026-10-21).

## History pitfalls

| Class                                 | How this design avoids it                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| C-04 Unbounded cost                   | paged reads; bounded request work                                                           |
| C-05 Statement the code does not keep | every number on a page comes from the same function as the CLI, and a test compares the two |
| C-06 Weak evidence as strong          | source labels on spend and on stops                                                         |
| C-07 Untrusted input trusted          | escaping; token, Host and Origin checks; no CORS                                            |
| C-09 Environment assumed              | headless start; port in use; Node 20/22/24                                                  |
