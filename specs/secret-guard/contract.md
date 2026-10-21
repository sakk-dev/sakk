# Contract — secret guard (M3)

| #   | Delivered                                                                                        | Verified by                                                                                 |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 1   | Every gitleaks rule at the pinned commit is either ported or listed as refused, with the reason  | `test/secret-guard.test.mjs::every upstream rule is ported or listed as refused`            |
| 2   | Every ported rule catches its true samples and passes its false samples                          | `test/secret-guard.test.mjs::every rule catches its true samples and passes its false ones` |
| 3   | Per-rule false positives on the benign corpus are recorded; over-budget rules are off by default | `test/secret-guard.test.mjs::the benign corpus stays under each enabled rule's budget`      |
| 4   | Every row of the adversary table holds                                                           | the named tests                                                                             |
| 5   | The existing secret-scan guarantees still hold                                                   | `test/secret-scan.test.mjs` unchanged and green                                             |
| 6   | The port is reproducible byte for byte                                                           | `test/secret-guard.test.mjs::the port reproduces the generated rules exactly`               |
