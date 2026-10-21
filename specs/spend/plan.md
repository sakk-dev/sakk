# Plan — spend (M2)

1. **Fixtures from real logs.** Collect a redacted sample of real Claude
   Code transcripts (streamed lines, subagents, cache breakdowns, an
   unpriced model). Store it under `test/fixtures/claude-logs/`, with
   message text stripped and only usage, ids and timestamps kept. Compare
   the totals against `npx ccusage` on the same files and explain every
   difference in the PR.
2. **`prices/snapshot.json`** and `scripts/prices-trim.mjs`, which builds
   the snapshot from the upstream file (records source, commit and hash;
   keeps it under 256 KiB).
3. **`src/prices.mjs`**: lookup, the cost formula and multipliers, aliases
   only through the table, `PRICE_UNKNOWN`.
4. **`src/spend.mjs`**: the incremental index, grouping by
   `(message.id, requestId)` with the maximum per field, maximum-ever
   counting, rewritten-log detection, day totals by zone, and the bounds.
5. **The guard hook's step 2**, through `src/hook.mjs`: the cap check, its
   reasons and fail-closed codes.
6. **`sakk spend`, `sakk cap`, `sakk prices [update]`**.
7. **Register the core files** in `test/core-specs.test.mjs`, add drill
   anchors (maximum-ever, unpriced deny, day boundary), and add a fuzz run
   over generated log lines.
8. **Independent adversarial review (money)**, rounds until it converges.
9. **One pull request.** The owner merges.
