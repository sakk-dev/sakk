/**
 * Child-process environment scrub: NODE_TEST_CONTEXT, injected by an outer
 * `node --test`, makes a child `node --test` exit 0 even when its tests FAIL
 * (empirically confirmed) — a false-green channel for any runner/scorer that
 * treats exit codes as the single source of truth. Every spawn must go
 * through this scrub. (Its own module because both the runner and the scorer
 * need it, and the scorer must not import the runner.)
 */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}
