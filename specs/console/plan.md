# Plan — `sakk ui` (M4)

1. **`src/console.mjs`**: a `node:http` server bound to loopback with the
   token, Host, Origin and CSP rules. Routes `GET /` (page), `GET /api/*`
   (JSON, paged), and `POST /api/halt` (only with `--allow-halt`).
2. **The page.** Port the v10 open-source edition to real data. The sample
   data is replaced by `/api/*` calls, and the tour and the coming-soon
   window stay.
3. **API functions** shared with the CLI (`sakk spend`, `sakk try`,
   `sakk doctor`), so the console and the CLI cannot disagree.
4. **`sakk ui`** in `bin/sakk.mjs`.
5. **Tests**: the adversary table, plus a click-through of the page in
   headless Chrome against fixture data (the v10 `flowtest10.js`, adapted).
6. **Review**, then one pull request. The owner merges.
