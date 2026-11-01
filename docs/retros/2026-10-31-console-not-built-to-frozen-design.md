# Retro: the console was not built to its frozen design (F-223, 2026-10-31)

Blameless. Finding F-223 in `findings/ledger.json`; class C-05.

## What happened

The console spec named a frozen v10 design as the target. When the
maintainer opened `sakk ui` on a test home, the page did not match it: a
different shell and navigation, no Overview cards, no tour, no help
popovers, no stop wizard, no user menu, and the ledger on a page of its own.

Separately, the stop button never worked. With `--allow-halt`, pressing it
always got 403. The page read the halt token from `document.cookie`, but the
server sets the token cookie as HttpOnly, so the script read an empty string
and every halt request failed the token check.

## Impact

- The shipped console did not match its spec.
- The console's emergency stop button never worked. `sakk halt` from the
  terminal does not go through the page.
- An earlier finding, F-201 (2026-10-28), had already recorded the same
  stop-button failure; it was deferred with the rest of v1 (ADR-0010) and is
  still open in the ledger.

## Root cause

A sentence in the spec stood in for a check.

- Every console test read the page HTML or the JSON routes as text. None
  rendered the page or pressed the stop button the way a person does, so the
  403 and the missing design passed them all.
- The contract row for the design named a click-through test as its
  verifier, but that test was never written, and nothing checked that a
  contract row's verifier exists.
- The halt route's tests sent the token header directly. They proved the
  server accepts a correct token, not that the page can obtain one.

## What changed

- The console was rebuilt from the frozen v10 file on real data: shell, nav,
  cards, help popovers, a 14-step tour, the stop wizard and user menu. Cells
  without an open-source data source show a dash and the reason (commit
  f7ed38b, PR #41).
- The page sends the halt token from its address (`?t=`), not from the
  cookie.
- No inline style attributes.
- The contract row now names tests that exist (commit d442cdf).

Mechanism test:
`test/console.test.mjs::the console page follows the frozen v10 open-source layout (F-223)`.
Guard test:
`test/console.test.mjs::the page sends the halt token from its address, not the HttpOnly cookie (F-223)`.
Each was shown to go red when its check was removed.

## What we'd do differently

- Accept a UI by driving it in a browser, not by reading its HTML.
- Check that every verifier a contract names exists.
- When a finding is deferred, recheck it before the next UI release instead
  of rediscovering it.
