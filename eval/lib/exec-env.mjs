/**
 * Child-process environment: an ALLOWLIST, not a scrub. Everything the
 * runner, scorer and the agent under test need to run passes (paths,
 * locale, terminal); everything else in the operator's environment stays
 * with the operator — credentials, the organisation ledger path, and
 * NODE_OPTIONS, whose test flags (--test-only, --test-skip-pattern) and
 * NODE_TEST_CONTEXT make a failing child `node --test` exit 0 (F-81). A
 * denylist of one variable missed the second channel; a list of what may
 * pass cannot (prevention RC-04). Only the real executor additionally gets
 * its provider's variables. (Its own module because both the runner and the
 * scorer need it, and the scorer must not import the runner.)
 */
const BASE =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_[A-Z]+|TERM|TZ|XDG_[A-Z_]+|SYSTEMROOT|COMSPEC|PATHEXT|WINDIR)$/;
const PROVIDER =
  /^(ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_[A-Z0-9_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|NODE_EXTRA_CA_CERTS)$/;

export function childEnv(extra = {}, { provider = false } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env))
    if (BASE.test(k) || (provider && PROVIDER.test(k))) env[k] = v;
  return { ...env, ...extra };
}
