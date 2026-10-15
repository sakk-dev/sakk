// SPDX-License-Identifier: AGPL-3.0-only
//
// The one path-matching implementation shared by the eval scorer and the
// policy kernel (spec: specs/policy-engine/ — "one implementation, already
// mutation-drilled"). Entries are PREFIX RULES, not wildcard globs:
//   'docs'  or 'docs/'  → the docs/ subtree (and the literal path 'docs')
//   'a/b.mjs'           → exactly that file
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

/** Decidable prefix-subset check: does rule `a` cover every path rule `b`
 * covers? Used by shadow detection; anything undecidable returns false
 * (the checker refuses provable dead rules, it does not promise more). */
export function prefixCovers(a, b) {
  const base = (x) => (x.endsWith('/') ? x.slice(0, -1) : x);
  return base(b) === base(a) || matchPath(base(b), a);
}
