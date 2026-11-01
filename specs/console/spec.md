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

Sign-in is optional (item 10): `sakk ui --set-password` asks at a terminal
for a username and password, and `sakk ui --clear-password` removes them.
With none set, `sakk ui` behaves exactly as described here and the printed
address is the only way in.

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
   The one exception is `POST /login` and `POST /logout` when sign-in is on
   (item 10): they need the local `Origin` present, and no token header,
   because sign-in is the way in for someone without the address.
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
   - The index is counted by the hook when a cap is set, or by `sakk spend`.
     A day it has not counted has no figure, so the Today card shows "—" and
     "run sakk spend" until the index was counted today, never $0
     (`test/console.test.mjs::an uncounted day shows a dash, not $0, until sakk spend counts it (F-231)`).
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
10. **Sign-in (optional).** the maintainer's decision of 2026-11-01: the most basic
    sign-in, a username and a password; SSO, team accounts and anything more
    are V2 or the enterprise edition. It follows the OWASP Password Storage and
    Session Management cheat sheets and adds no dependency.
    - Off unless set. With no credential file the console is unchanged: no
      token is 403 and `/login` is 404
      (`test/console-login.test.mjs::with no password set the console is unchanged: no token is 403 and /login is 404`).
      With one, the printed address still opens the console, and every API
      route still needs the token or a session
      (`test/console-login.test.mjs::with a password set every API route still needs the token or a session`).
    - Storage. `console-login.json` under `SAKK_HOME`, written atomically with
      mode 0600, holds the username, a 16-byte random salt and a scrypt hash
      (N=2^17, r=8, p=1, 64 bytes, an explicit `maxmem`), never the password
      (`test/console-login.test.mjs::the credential file is mode 0600 and holds a scrypt hash, never the password`).
      A password is 15–1024 characters after NFKC normalisation (NIST SP
      800-63B-4 for a password used on its own). A file that is a symlink, a
      hard link, readable by others, someone else's, malformed or carrying other
      scrypt parameters stops the console from starting with
      `CONSOLE_LOGIN_UNSAFE` or `CONSOLE_LOGIN_INVALID` and exit 2, never a
      silent fall-back to token-only
      (`test/console-login.test.mjs::a credential file that is a symlink, a hard link or readable by others stops the console from starting`).
    - Setting it. The password is asked at a terminal without echo, twice; it
      is never read from the command line or a pipe, and an unknown flag is not
      echoed back (`test/console-login.test.mjs::sakk ui refuses a password on the command line and a password prompt without a terminal`).
      The file is read when the console starts, so a change needs a restart.
    - Checking it. `POST /login` takes JSON or a form, at most 2 KiB, and
      needs the local `Origin` and `Host`
      (`test/console-login.test.mjs::sign-in refuses a foreign Origin, a missing Origin and a foreign Host`).
      The username and password are compared in constant time, scrypt runs for
      a wrong username too, and a wrong username and a wrong password get the
      same 401 `CONSOLE_LOGIN_FAILED`
      (`test/console-login.test.mjs::a wrong password and a wrong username get the same refusal and no cookie`).
    - Limit. Five failed sign-ins in 15 minutes lock sign-in for the rest of the
      window with 429 `CONSOLE_LOGIN_LOCKED`, `Retry-After` and a message that
      names the printed address, which keeps working; one check runs at a time;
      a failure is logged with its count, never with the username or password
      (`test/console-login.test.mjs::five failed sign-ins lock sign-in out with a clear message, while the token link still works`).
    - Session. A sign-in sets `sakk_s`, a fresh 128-bit id, `HttpOnly` and
      `SameSite=Strict`; the server keeps a hash of it in memory, at most 16 at
      a time, and forgets all of them when it stops
      (`test/console-login.test.mjs::the right username and password open a session cookie that is HttpOnly and SameSite=Strict`).
      A session ends after 30 minutes idle or 8 hours in all, and at `POST
/logout` (`test/console-login.test.mjs::a session ends after the idle limit and after the absolute limit`).
      An id the server did not issue, or one from another run, is refused, and
      a cookie set before sign-in is never promoted
      (`test/console-login.test.mjs::a session cookie the server did not issue is refused`).
    - Reach. A password session reads; it cannot stop an agent, which still
      needs `--allow-halt` and the start token header
      (`test/console-login.test.mjs::a password session cannot stop an agent without the start token`).
    - Design. The v10 open-source edition has no sign-in screen. The page is a
      recorded deviation from v10, built from the console's own colours, type
      and controls, with the page's CSP nonce and no `innerHTML`; the frozen
      v10 files are not edited.

## Adversary table

The adversary is a web page in the user's browser, another local user or
process, or a prompt-injected agent that wants the console to lie or to act.

| #   | Move                                                                      | Must-hold outcome                                                           | Guard test                                                                                                                            |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A web page fetches `http://127.0.0.1:<port>/api/decisions`                | no token → 403; and the response has no CORS header                         | `test/console.test.mjs::a request without the token gets nothing`                                                                     |
| 2   | DNS rebinding: `evil.example` resolving to 127.0.0.1                      | wrong `Host` → 403                                                          | `test/console.test.mjs::a foreign Host header is refused`                                                                             |
| 3   | Cross-site POST to stop an agent                                          | no `--allow-halt` → 405; with it, a wrong or missing Origin or token → 403  | `test/console.test.mjs::writes need the flag, the origin and the token`                                                               |
| 4   | Another machine on the network                                            | the server is bound to loopback only; a test asserts the bound address      | `test/console.test.mjs::the server listens on loopback only`                                                                          |
| 5   | A log line carrying `<script>` (a tool name, a path, an MCP server name)  | escaped and shown as text                                                   | `test/console.test.mjs::log text is escaped everywhere it is shown`                                                                   |
| 6   | Guessing the token                                                        | 128 bits; constant-time compare; 403s are counted and shown                 | `test/console.test.mjs::token compare is constant-time and failures are counted`                                                      |
| 7   | A huge log to hang the server                                             | paged reads; a request finishes in bounded work                             | `test/console.test.mjs::a huge decision log is paged, never loaded whole`                                                             |
| 8   | The console shows spend as billed, or a self-declared stop as signed      | labels "from local logs" and "self-declared (the OS account name)" (F-126)  | `test/console.test.mjs::evidence is labelled by its source`                                                                           |
| 9   | The page loads anything from the network (a CDN font)                     | CSP `default-src 'none'`; a test lists every URL in the HTML                | `test/console.test.mjs::the page makes no request to another origin`                                                                  |
| 10  | A process that can write the ledger folder puts `<script>` in an agent id | returned as JSON data and shown as text                                     | `test/console.test.mjs::hostile ledger text is returned as data, never put into the page`                                             |
| 11  | The ledger path is swapped for a symlink to another file                  | `LEDGER_PATH_NOT_CANONICAL`; the target is not read                         | `test/console.test.mjs::a symlinked ledger is refused, not read through the link`                                                     |
| 12  | A fifo is put where the alerts log should be, to hang the request         | skipped as "not a regular file"; the ledger still shows                     | `test/console.test.mjs::an alerts file that is not a regular file is skipped, never blocks`                                           |
| 13  | Guessing the password                                                     | five failures in 15 min lock sign-in (429); the printed address still works | `test/console-login.test.mjs::five failed sign-ins lock sign-in out with a clear message, while the token link still works`           |
| 14  | Probing which usernames exist                                             | the same 401 and the same scrypt work for a wrong user and a wrong password | `test/console-login.test.mjs::a wrong password and a wrong username get the same refusal and no cookie`                               |
| 15  | A web page posts the sign-in form cross-site, or via DNS rebinding        | foreign or missing `Origin`, or foreign `Host` → 403; no cookie             | `test/console-login.test.mjs::sign-in refuses a foreign Origin, a missing Origin and a foreign Host`                                  |
| 16  | A planted or replayed session cookie (fixation, another run's id)         | refused; sign-in always issues a fresh id                                   | `test/console-login.test.mjs::a session cookie the server did not issue is refused`                                                   |
| 17  | Another local user reads or swaps the credential file                     | mode 0600, one name, no link, same owner, or the console does not start     | `test/console-login.test.mjs::a credential file that is a symlink, a hard link or readable by others stops the console from starting` |
| 18  | The password lands in shell history, `ps` or a pipe                       | no flag or pipe takes it; it is asked at a terminal without echo            | `test/console-login.test.mjs::sakk ui refuses a password on the command line and a password prompt without a terminal`                |
| 19  | A signed-in browser tab is used to stop an agent                          | 403 without the start token header                                          | `test/console-login.test.mjs::a password session cannot stop an agent without the start token`                                        |

## Input-space table

| Input           | Classes covered                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request         | Every route with and without the token, cookie, Host and Origin; methods other than GET/POST; paths with `..`, `%2e`, `//`; query strings over 8 KiB        |
| Data files      | Absent (pages say "nothing yet" and how to start); empty; malformed lines (counted, shown, skipped); 5 GB                                                   |
| Ledger          | Not set; missing; symlinked; over 32 MiB; over 500 calls; hostile text; alerts log absent, a fifo, a directory or a symlink                                 |
| Port            | Default (random free port); `--port` in use (refuse, never pick another silently); privileged port (refuse)                                                 |
| Environment     | Headless (no browser: print the address); `SAKK_HOME` unreadable (refuse at start)                                                                          |
| Sign-in body    | JSON, form, other or no `Content-Type` (415); not JSON or missing fields (400); over 2 KiB by `Content-Length` (413) or chunked (cut off)                   |
| Credential file | Absent (sign-in off); mode 0644; hard link; symlink; `{}`; downgraded scrypt cost; over 4 KiB (another owner is checked but needs a second account to test) |
| Session cookie  | Absent; malformed; never issued; another run's; idle over 30 min; older than 8 h; after sign-out                                                            |

## Evidence-source declaration

The console only shows what M1–M3 recorded, with their labels: decisions
from the hook, spend from local logs, secret blocks as rule matches. It
adds one claim of its own, "the console was read-only", which is as strong
as the flag the server was started with. The header shows it.

## Ceilings

1. Anyone with a shell as the same user can read `$SAKK_HOME` directly. The
   token protects the port, not the files.
2. Open-source sign-in is the basic username and password of item 10 (the maintainer,
   2026-11-01; this replaces "out of scope for v1" of 2026-10-21). SSO, team
   accounts, roles and named approvers are not in the open-source edition;
   they stay V2 or enterprise stubs. The limits of the basic sign-in:
   - it adds a second way in next to the token; it does not replace or
     harden the token, and the same-user shell of ceiling 1 still reads the
     files;
   - the failed-sign-in limit is one counter for the run, so a local process
     can lock password sign-in for 15 minutes; the printed address is the way
     in meanwhile;
   - the cookie has no `Secure` flag because the console is plain HTTP on
     loopback;
   - sessions live in memory: a restart signs everyone out, and a new or
     cleared password takes effect at the next start.

## History pitfalls

| Class                                  | How this design avoids it                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| C-04 Unbounded cost                    | paged reads; bounded request work                                                           |
| C-05 Statement the code does not keep  | every number on a page comes from the same function as the CLI, and a test compares the two |
| C-06 Weak evidence as strong           | source labels on spend and on stops                                                         |
| C-07 Untrusted input trusted           | escaping; token, Host and Origin checks; no CORS                                            |
| C-09 Environment assumed               | headless start; port in use; Node 20/22/24                                                  |
| C-04 Unbounded cost (sign-in)          | 2 KiB body cap; one scrypt check at a time; five failures per 15 min; at most 16 sessions   |
| C-07 Untrusted input trusted (sign-in) | Origin and Host on `/login`; constant-time compare; a credential file is checked before use |
