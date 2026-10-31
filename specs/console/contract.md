# Contract — `sakk ui` (M4)

| #   | Delivered                                                                                  | Verified by                                                                               |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 1   | Every row of the adversary table holds                                                     | the named tests in `test/console.test.mjs`                                                |
| 2   | Every v10 open-source page renders from real data, and the coming-soon window is unchanged | the adapted click-through test, green on fixture data                                     |
| 3   | Numbers on the page equal the CLI's for the same data                                      | `test/console.test.mjs::the console and the CLI report the same numbers`                  |
| 4   | Read-only unless `--allow-halt`; resume stays on the command line                          | `test/console.test.mjs::writes need the flag, the origin and the token`                   |
| 5   | No request leaves the machine                                                              | `test/console.test.mjs::the page makes no request to another origin`                      |
| 6   | The Spend log shows the same numbers as `sakk status --json` for the same ledger           | `test/console.test.mjs::the ledger view and sakk status --json report the same numbers`   |
| 7   | The ledger shown is the one the console was started with; the request cannot choose a file | `test/console.test.mjs::sakk ui started elsewhere shows the ledger config.json points at` |
