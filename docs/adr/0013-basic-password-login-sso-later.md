---
status: accepted
date: 2026-11-01
decision-makers: the maintainer
---

# The console gets basic password login now; SSO comes later

Implementation in progress.

## Context and Problem Statement

`sakk ui` is guarded by a random token in its address (ADR-0006). The maintainer chose to add a normal
login before the public release. Teams will later want single sign-on. What ships in
the open-source release?

## Decision Drivers

- A login a single operator can use with no identity provider.
- No weaker than the token path it sits beside.
- No promise of team or SSO features that do not exist yet.

## Considered Options

- Token only, as today.
- Basic username and password, stored locally.
- SSO (OIDC or SAML) now.

## Decision Outcome

Chosen option: "Basic username and password". The password is stored as a
salted scrypt hash and compared in constant time. A session lives in an
HttpOnly, SameSite=Strict cookie. Failed attempts are rate limited. The
token path keeps working.

SSO, team accounts and roles go to v2 or to community contributions.

### Consequences

- Good, because one operator gets a familiar login with no extra service.
- Good, because existing token links keep working.
- Bad, because there is one local account and no roles.
- Bad, because the console now has two ways in (token and password) that
  must stay equally strict.

### Confirmation

The login change must land with tests for the hash, the constant-time compare,
the cookie flags and the rate limit, each shown red before the fix.

## More Information

Related: ADR-0006 (console), ADR-0014 (what stays in open source).
