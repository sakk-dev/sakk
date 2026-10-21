# Plan — secret guard (M3)

1. **Pin the upstream.** Choose a gitleaks commit. Fetch
   `config/gitleaks.toml` and the rule sources with their samples, and
   record the commit and hashes.
2. **`scripts/gitleaks-port.mjs`**: TOML → JavaScript rules, with the
   translations in the spec table. It refuses unknown constructs and
   writes `src/secret-rules.generated.mjs`, with a test that the port is
   reproducible.
3. **Corpus.** The true and false samples of each rule, plus the benign
   corpus. Record the per-rule false-positive counts, and disable the rules
   over budget by default (listed in the docs).
4. **The C-13 class detector.** Every detection rule set (secret rules,
   answer rules, shell classifier) runs on both sides. Record it in
   `findings/classes.json` as the stopline detector.
5. **Overlap merge (F-122)** in `src/secret-scan.mjs`.
6. **The hook's step 3**: the secret-file list, the env-dump forms, and the
   content scan of Edit, Write and the command text.
7. **Console data**: the decision-log lines for secret blocks
   (fingerprints only).
8. **Review** rounds until it converges.
9. **One pull request.** The owner merges.
