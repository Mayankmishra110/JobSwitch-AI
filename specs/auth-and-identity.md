# Auth and identity

Signup, login, logout, password reset, and Google OAuth. Layer 0 (not
tenant-scoped — RLS begins at Layer 2; see `specs/architecture.md`). Built
Phase 1. For how the resulting session is *validated* on each subsequent
request (the cookie, the hash, the cross-language Go reimplementation),
see `specs/session-auth.md` — this spec covers how a session is *created*
and everything else identity-related.

## Routes (`apps/web/src/routes/auth.ts`)

```
GET  /login, /signup, /forgot-password, /reset-password   pages
POST /auth/signup              { email, password, fullName? }
POST /auth/login                { email, password }
POST /auth/logout
POST /auth/forgot-password      { email }
POST /auth/reset-password       { token, password }
GET  /auth/google                config-gated, 404 if disabled
GET  /auth/google/callback       config-gated, 404 if disabled
```

Every POST route accepts both form-encoded (for the server-rendered pages)
and JSON (`Accept: application/json`) — `wantsHtml(request)` branches the
response shape; a validation or auth failure re-renders the page with an
error rather than returning a bare JSON error to a browser navigation.

## Signup (`apps/web/src/services/auth.ts`'s `signup`)

`createUserWithAccount` (one transaction): inserts `account` (`type:
'personal'`), `app_user`, `account_member` (`role: 'owner'`) together —
these three rows are meaningless apart, so they're created together, not
via separate calls that could partially fail. Password is hashed
(Argon2id, below) before the transaction opens, so a slow hash never holds
a DB transaction open. Writes `audit_log` action `'user.signed_up'`
*outside* the creating transaction, best-effort — see "Audit log" below
for why.

**Signup is the one auth endpoint that reveals whether an email is
taken** (`Errors.conflict`) — it has to, or the user can't be told why
signup failed. Login and password reset, where an *attacker* chooses the
address to probe, stay deliberately non-revealing (see below) — this
asymmetry is intentional, not inconsistent.

## Login (`login`)

Constant-shape failure, deliberately:

- No such user → `equalizeTiming()` (below) → generic `invalidCredentials`.
- User exists but has no password hash (an OAuth-only account) → same
  generic failure, same timing call.
- Wrong password → same generic failure (after the real Argon2 verify,
  which is already slow enough to not need equalizing).

A user with no `account_member` row is treated as `Errors.internal`, not a
credential failure — that's a broken invariant to investigate, not
something a real login attempt produces. Failed and successful logins both
write an audit entry (`'user.sign_in_failed'` / `'user.signed_in'`).

## Logout (`logout`)

Revokes the session (`user_session.revoked_at = now()`), writes
`'user.signed_out'`. Session revocation is checked live on every
subsequent `resolveSession` call — see `specs/session-auth.md`.

## Password reset (`requestPasswordReset` / `confirmPasswordReset`)

Two-step, token-based, mirroring the session-token pattern exactly
(`packages/db/src/repositories/sessions.ts`'s
`createPasswordResetToken`/`consumePasswordResetToken`): a random token is
generated, only its hash is stored, the raw value is what goes in the
email link.

- **Request always resolves the same way** regardless of whether the
  address has an account — an unauthenticated endpoint that revealed
  "no such user" would become an account-existence oracle. The email
  itself has a **neutral subject line** ("Your password reset link," not
  naming the product) — most users are job hunting while employed, and a
  subject line naming a job-switch tool could expose that on a lock
  screen or shared machine (`docs/PRD.md` §30).
- **Confirm** is a compare-and-set: `consumePasswordResetToken` returns
  `false` if two concurrent requests race on the same token, and the
  second loses cleanly (`tokenInvalid`) rather than double-applying.
  Every existing session for that user is revoked on a successful reset —
  if the reset was prompted by a suspected compromise, leaving a prior
  (possibly attacker) session alive would defeat the point.
- Email delivery is `apps/web/src/services/mailer.ts`'s `Mailer`
  interface — `MAIL_TRANSPORT=log` (dev default) writes the link to the
  application log with an explicit warning; `noop` (tests) does nothing. A
  real provider is Phase 8, not yet built. The interface exists now
  specifically so Phase 8 changes one factory function, not every call
  site.

## Google OAuth (`apps/web/src/services/google-oauth.ts`, `upsertOauthUser`)

Standard Authorization Code + PKCE flow, config-gated: with any of
`GOOGLE_CLIENT_ID`/`_SECRET`/`_REDIRECT_URI` missing, the routes return
404 rather than half-working — a partially configured OAuth flow that
fails at the callback is a worse failure mode than one that's visibly off.

- `state` (CSRF) and the PKCE `code_verifier` are both random, stored in
  short-lived signed cookies (10 min), checked on callback before
  anything else runs.
- The `id_token`'s signature is **not verified** — safe only because it's
  received directly from Google's token endpoint over a server-to-server
  TLS request, never from a redirect fragment or client POST. The code
  comment flags explicitly that any other delivery path would need real
  JWKS signature verification.
- **`email_verified` from Google's claims must be true, or the flow fails
  outright.** This is the account-takeover guard: `upsertOauthUser` links
  by email when no existing OAuth identity is found, so accepting an
  unverified email would let anyone who can create a Google account
  claiming an address seize the matching local account.
- New Google sign-ins get `email_verified_at` set immediately
  (`emailVerified: true` passed to `createUserWithAccount`) — Google has
  already done that verification.

**Never verified end to end.** No real Google credentials exist in this
build environment. The shape, state/PKCE handling, and claim checks are
implemented and unit-tested against synthetic tokens; the live round trip
is untested. Treat the first run against real credentials as the actual
verification (same honesty pattern as the ATS adapters in
`specs/ingestion.md`).

## Password hashing (`apps/web/src/services/password.ts`)

Argon2id (`@node-rs/argon2`), OWASP-current parameters: 19 MiB memory cost,
2 iterations, parallelism 1. Memory cost is the parameter that makes GPU
cracking expensive — deliberately not trimmed for speed.

`DUMMY_PASSWORD_HASH` + `equalizeTiming()`: when no user exists for a
submitted email, login still runs a real Argon2 verification against this
constant hash. Without it, "no such user" returns in ~1ms while "wrong
password" takes ~50ms — a timing side-channel that reveals which
addresses have accounts, which for this product specifically reveals who
is job hunting.

## Rate limiting

Per-route limits via `@fastify/rate-limit`, in-memory (single-process;
weakens the moment a second `apps/web` replica exists — a known,
documented gap, not a surprise). `RATE_LIMIT_ENABLED` is a single config
boolean, off for most of the test suite (so repeated signups in unrelated
tests don't trip it) and explicitly on in `apps/web/test/rate-limit.test.ts`,
which is the one suite that actually proves the limits are real: 10
login attempts per 15 minutes before `429`, and — deliberately —
`/healthz` is **never** rate-limited, so an uptime monitor polling it
can't be throttled into reporting a false outage.

## Health and readiness (`apps/web/src/routes/health.ts`)

- `GET /healthz` — liveness. Touches nothing (no DB query) — a database
  blip must not get a healthy process killed by an orchestrator.
- `GET /readyz` — readiness. Runs `SELECT 1` and checks
  `pendingMigrationsReadOnly` (reads `schema_migration`, never issues DDL
  — the web role has no DDL rights by design). Returns `503` with
  `pendingMigrations: [...]` if the schema is behind; `200` otherwise.

## Tests

| Suite | File | Proves |
|---|---|---|
| vitest | `apps/web/test/auth.test.ts` (30) | Signup/login/logout/password-reset/OAuth-gating, real Fastify + real Argon2 — no mocks of the pieces under test |
| vitest | `apps/web/test/rate-limit.test.ts` (3) | Login lockout at the real threshold, structured 429 body, `/healthz` exempt |
