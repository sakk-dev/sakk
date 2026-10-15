// SPDX-License-Identifier: AGPL-3.0-only
//
// The one path-matching implementation shared by the eval scorer and the
// policy kernel (spec: specs/policy-engine/ — "one implementation, already
// mutation-drilled"). Entries are PREFIX RULES, not wildcard globs:
//   'docs'  or 'docs/'  → the docs/ subtree (and the literal path 'docs')
//   'a/b.mjs'           → that path and anything under it ('a/b.mjs/x' too)
// Bounded, deterministic, no regex — no ReDoS surface by construction.

export function matchPath(p, x) {
  // Pathological paths fail closed: non-strings, empty strings, absolute
  // paths, '.'/'..' segments, and double slashes match NO rule. Matching
  // nothing always tightens: in the scorer it yields UNAUTHORIZED_WRITE, in
  // the policy kernel it falls through to the mandatory default verdict.
  if (
    typeof p !== 'string' ||
    p === '' ||
    p.startsWith('/') ||
    p.split('/').some((s) => s === '' || s === '.' || s === '..')
  )
    return false;
  if (x.endsWith('/')) return p === x.slice(0, -1) || p.startsWith(x);
  return p === x || p.startsWith(`${x}/`);
}

export const matchesAny = (p, prefixes) => prefixes.some((x) => matchPath(p, x));

/** True iff `p` is a canonical relative path — the only shape matchPath can
 * ever match. Review finding F2: in a deny-first policy, a path alias that
 * silently matches NOTHING ('prod//x', './prod/x', '/prod/x') slides past
 * an explicit deny into a later allow — so the policy kernel REFUSES
 * non-canonical context scopes outright instead of not-matching them.
 * (Unicode homoglyphs are indistinguishable from honest names here;
 * normalizing those is the enforcer's documented duty.) */
export function isCanonicalRelPath(p) {
  return (
    typeof p === 'string' &&
    p !== '' &&
    !p.startsWith('/') &&
    !p.split('/').some((s) => s === '' || s === '.' || s === '..')
  );
}

/** Decidable prefix-subset check: does rule `a` cover every path rule `b`
 * covers? Used by shadow detection; anything undecidable returns false
 * (the checker refuses provable dead rules, it does not promise more). */
export function prefixCovers(a, b) {
  const base = (x) => (x.endsWith('/') ? x.slice(0, -1) : x);
  return base(b) === base(a) || matchPath(base(b), a);
}
