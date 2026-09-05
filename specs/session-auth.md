# Session authentication

Email+password and Google OAuth login, both producing the same kind of
session: a signed-nothing, hashed-token cookie validated identically by
every service that needs to know who's asking. Built Phase 1 (TS); the
same mechanism was reproduced independently in Go for Phase 5.2's matcher
API, verified byte-for-byte against the TS implementation.

## How a session is created

`packages/db/src/repositories/identity.ts`:

```ts
export function generateToken(): IssuedToken {
  const raw = randomBytes(32).toString('base64url');   // 43 chars, unpadded
  return { raw, hash: hashToken(raw) };
}
export function hashToken(raw: string): Buffer {
  return createHash('sha256').update(raw, 'utf8').digest();  // 32 raw bytes
}
```

`packages/db/src/repositories/sessions.ts`'s `createSession` inserts
`(user_id, account_id, token_hash, expires_at, ip_address, user_agent)`
into `user_session` — `token_hash` is a `bytea` column holding the **raw
32-byte digest**, never hex- or base64-encoded. The **raw token** (`raw`,
the base64url string) is what gets set as the `js_session` cookie value —
`apps/web/src/routes/auth.ts`'s `setSessionCookie`, `httpOnly: true,
secure: <prod>, sameSite: 'lax', signed: false`. `@fastify/cookie` is
registered with `SESSION_SECRET` as its secret, but the session cookie is
never signed with it — `apps/web/src/server.ts`'s hook reads
`request.cookies[name]` directly, no `unsignCookie` call. `SESSION_SECRET`
only signs *other* cookies (OAuth state/PKCE verifier).

**This asymmetry is easy to get backwards when reimplementing the
validator**: the cookie is the raw token, the database holds its hash. Hash
what came out of the cookie; never try to "verify" a signature that was
never applied.

## How a session is validated

Exact SQL (`packages/db/src/repositories/sessions.ts`, reproduced
verbatim in Go — see below):

```sql
SELECT s.id, s.user_id, s.account_id, am.role, s.expires_at
FROM user_session s
JOIN app_user u ON u.id = s.user_id AND u.deleted_at IS NULL
JOIN account a ON a.id = s.account_id AND a.deleted_at IS NULL
JOIN account_member am
  ON am.account_id = s.account_id AND am.user_id = s.user_id
WHERE s.token_hash = $1
  AND s.revoked_at IS NULL
  AND s.expires_at > now()
```

`$1` is `sha256(rawCookieValue, utf8)` as raw bytes. Every check that must
hold: hash match, not revoked, not expired, user not soft-deleted, account
not soft-deleted, a membership row exists. **`role` is joined live from
`account_member` on every single call — never cached on the session row.**
A membership role change (or removal) takes effect on the very next
request, not at next login. This is deliberate, not an oversight, and is
covered by a dedicated test in both languages (see below).

On success, `resolveSession` (TS) / `session.Resolve` (Go) return a
`Principal { userId, accountId, role, sessionId }` — `packages/core/src/
identity.ts` and `services/matcher/internal/session/session.go`
respectively, kept in lockstep by hand (no shared schema-gen between the
languages yet).

The TS side also does a rate-limited "touch" (`UPDATE user_session SET
last_seen_at = now() WHERE ... AND last_seen_at < now() - interval '1
minute'`) on each resolution. The Go side deliberately does **not**
reproduce this — it's a write on the read path that only one of the two
services needs to own, and `apps/web` already does it.

## The Go reimplementation

`services/matcher/internal/session/session.go`. Connects on the **Web**
pool (`app_web`-granted, RLS enforced — Layer 0 tables aren't RLS-protected
anyway, but this is the same pool `WithAccount` uses for everything else,
kept consistent rather than opening a third pool just for this). Wired into
HTTP handlers via `internal/httpx/auth.go`'s `RequireAuth` middleware,
which mirrors `apps/web/src/server.ts`'s `requireAuth` guard: 401 JSON on
any failure, principal attached to the request context on success.

### The checklist that mattered

Everything here was verified, not assumed, against real Postgres:

- Cookie holds the **raw** base64url token (43 chars, unsigned) — no
  unsigning in Go.
- `sha256.Sum256([]byte(cookieValue))` hashes the **cookie string**, not
  decoded bytes. Passed to pgx as raw `[]byte` → `bytea`, never
  hex-encoded.
- The join, the soft-delete checks, the revoked/expiry checks: reproduced
  exactly, in the same order, same table aliases where it mattered for
  readability.
- Role read live from `account_member`, proven by
  `TestResolveRoleIsLiveNotCached` (Go) — changes a membership role
  mid-test and asserts the *next* `Resolve` call sees the new role without
  re-issuing a session.

### Cross-language hash parity — the highest-leverage single test in the project

`packages/db/test/fixtures/session-tokens.json` is a committed set of
`{rawToken, sha256Hex}` pairs, generated once with Node's `crypto` module.
**Both** `packages/db/test/sessionTokenParity.test.ts` (vitest) and
`services/matcher/internal/session/session_test.go`
(`TestHashTokenMatchesTypeScriptFixture`) assert their own language's hash
function against the same file. If the two languages' hashing ever
diverges — a wrong encoding, a UTF-8/UTF-16 mismatch, hashing decoded bytes
instead of the string — this is the test that catches it, immediately,
with no need to spin up both services and manually compare a real login.

## Known gaps

- No refresh-token / rotation mechanism — a session is a flat 14-day TTL
  (`SESSION_TTL_SECONDS`), matching what Phase 1 shipped.
- The Go side has no logout/revoke endpoint yet — only `apps/web` can
  revoke a session today.
- `services/matcher/cmd/api`'s only authenticated route right now is a
  temporary smoke-test endpoint (`GET /api/v1/_internal/whoami`), meant to
  be replaced by the first real route (`GET /api/v1/matches`), not grown
  into a permanent one.

## Tests

| Suite | File | Proves |
|---|---|---|
| vitest | `packages/db/test/sessionTokenParity.test.ts` | TS `hashToken` matches the committed fixture |
| Go | `internal/session/session_test.go` | Go `HashToken` matches the same fixture |
| Go | `internal/session/session_integration_test.go` | Valid/revoked/expired/unknown-token resolution against real Postgres; role-is-live property |
