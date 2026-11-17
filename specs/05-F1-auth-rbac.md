# F1 — Auth & RBAC (Feature Spec)

> Doc 6 of the spec set. First of the per-feature specs. Build order: this one first — every other feature depends on knowing who the caller is and what they're allowed to do.

---

## 1. User Story

> As an **admin**, I can sign in and see every user's account, their crawl/apply activity, and flip a kill-switch on anyone's auto-apply.
> As a **user**, I can sign in and only ever see my own data — and the system should be architecturally incapable of showing me anyone else's, even if a handler has a bug.

## 2. What already exists (reuse, don't rebuild)

Your codebase already has, per the audit:

- Cookie-based server sessions (`user_session`, `token_hash` stored as SHA-256, never the raw token)
- Argon2id password hashing (OWASP params) with timing-equalization on failed login to prevent user enumeration
- Google OAuth2 + PKCE sign-in (code complete, **never verified against real Google credentials** — see §6)
- Password reset flow (hashed tokens, TTL, revokes all sessions on use)
- `account_member.role` with `owner | admin | member`
- RLS policies on every tenant table, scoped by `app_current_account_id()`, set via `SET LOCAL`

**What's actually new in F1:** (a) collapsing the role enum to `admin | user`, (b) an RBAC middleware layer in the Go gateway, (c) the `withAdminSession()` context helper from migration 0021, (d) verifying the Google OAuth flow for real.

## 3. Acceptance Criteria

| # | Criterion |
|---|---|
| AC1 | A user with `role='user'` calling any `/api/v1/admin/*` endpoint gets **403**, not 404 or 500 |
| AC2 | An admin's cross-account read sets `app.is_admin_session=true` via `SET LOCAL` inside the same transaction as the query — never as a connection-level `SET` |
| AC3 | A logged-in user querying `apply_action` with a tampered `account_id` in the request body still gets only their own rows (RLS enforces it, not the handler) |
| AC4 | Session cookie is `httpOnly`, `sameSite=lax`, `secure` in production |
| AC5 | Google sign-in completes a real round trip against real Google credentials (closes the existing unverified gap) |
| AC6 | Role is read from the DB per request, never from a client-supplied header/claim |

## 4. Implementation

### 4.1 Role model change

```sql
-- 0024 · Collapse account_member.role to admin|user.
-- The existing owner|admin|member enum was built for org-account
-- multi-tenancy that this product doesn't use yet (PRD non-goal).
-- Two roles is the honest model for what actually ships.

ALTER TABLE account_member DROP CONSTRAINT account_member_role_check;
UPDATE account_member SET role = 'user' WHERE role = 'member';
UPDATE account_member SET role = 'admin' WHERE role = 'owner';
ALTER TABLE account_member ADD CONSTRAINT account_member_role_check
  CHECK (role IN ('admin', 'user'));
```

### 4.2 RBAC middleware (Go)

```go
// middleware/rbac.go
package middleware

type Role string

const (
    RoleAdmin Role = "admin"
    RoleUser  Role = "user"
)

// RequireRole is middleware, not a per-handler check. The distinction
// matters: a per-handler `if role != admin` is one forgotten line away
// from an authz hole. Middleware applied at the route-group level makes
// the default deny, and forgetting to add a handler to the group means
// the route simply doesn't exist — a loud failure, not a silent leak.
func RequireRole(required Role) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            principal, ok := PrincipalFrom(r.Context())
            if !ok {
                writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "sign in required")
                return
            }
            if principal.Role != required {
                // 403, not 404: the resource exists, this caller can't have it.
                // (404-to-hide-existence is only worth it when the resource ID
                // itself is a secret — not the case for a known admin route.)
                writeError(w, http.StatusForbidden, "FORBIDDEN", "insufficient role")
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

Mounted as a group, so the default is deny:

```go
adminRouter := r.PathPrefix("/api/v1/admin").Subrouter()
adminRouter.Use(middleware.RequireRole(middleware.RoleAdmin))
adminRouter.HandleFunc("/accounts", handleListAccounts)
adminRouter.HandleFunc("/crawl-health", handleCrawlHealth)
```

### 4.3 The two session-context helpers

```go
// db/context.go
// WithAccount mirrors your existing TS packages/db/src/context.ts helper.
// SET LOCAL (not SET) is load-bearing: LOCAL scopes the setting to the
// current transaction, so it cannot leak to the next request that borrows
// this pooled connection. A plain SET would persist on the connection and
// silently hand one user's tenant context to the next user — the exact
// class of bug connection pooling makes possible and easy to miss in
// testing (it only shows up under concurrency).
func WithAccount(ctx context.Context, pool *pgxpool.Pool, accountID string, fn func(pgx.Tx) error) error {
    tx, err := pool.Begin(ctx)
    if err != nil { return err }
    defer tx.Rollback(ctx)

    if _, err := tx.Exec(ctx, "SELECT set_config('app.current_account_id', $1, true)", accountID); err != nil {
        return err
    }
    if err := fn(tx); err != nil { return err }
    return tx.Commit(ctx)
}

// WithAdminSession sets the SECOND, separate flag from migration 0021.
// Deliberately a different function, not a boolean parameter on
// WithAccount — so every admin-privileged read is grep-able in one search,
// and nobody accidentally passes `isAdmin: true` through three layers of
// call stack.
func WithAdminSession(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
    tx, err := pool.Begin(ctx)
    if err != nil { return err }
    defer tx.Rollback(ctx)

    if _, err := tx.Exec(ctx, "SELECT set_config('app.is_admin_session', 'true', true)"); err != nil {
        return err
    }
    if err := fn(tx); err != nil { return err }
    return tx.Commit(ctx)
}
```

## 5. Test Cases (this is the acceptance bar, not a nice-to-have)

### Go unit tests
```
TestRequireRole_AdminPasses
TestRequireRole_UserGets403
TestRequireRole_NoSessionGets401
TestWithAccount_SetsLocalNotGlobal        // assert the setting is gone after commit
TestWithAdminSession_DoesNotSetAccountID  // the two flags must be independent
```

### Integration tests (real Postgres — follow your existing `rls.test.ts` pattern)
```
TestRLS_UserCannotReadOtherAccountApplyActions
TestRLS_TamperedAccountIdInBodyIsIgnored     // AC3
TestRLS_AdminSessionReadsAcrossAccounts
TestRLS_ContextDoesNotLeakAcrossPooledConnections  // the SET LOCAL test — run concurrently
```

### E2E (Playwright)
```
admin logs in → sees /admin route → user logs in → /admin returns 403
```

---

## 6. Known gap to close in this feature

The audit found Google OAuth (both sign-in and Gmail-link) is **code-complete but explicitly documented in your own source as never verified against real Google credentials**. F1 isn't done until you've run a real round trip with real credentials — because an auth flow that's never been tested against the real IdP is, practically speaking, untested. Budget a half-day for: create a real Google Cloud project, configure OAuth consent screen + redirect URIs, run the flow, fix whatever breaks (there's almost always something — redirect URI mismatch, scope approval, consent screen verification state).

---

## 7. What you'll learn building this

- **Session-based auth vs JWT, argued properly.** You're using server-side sessions with an opaque token — not JWT. Know *why* this is often the better choice: instant revocation (delete the row), no token-size bloat, no "how do I invalidate a JWT before expiry" problem. JWT's advantage is statelessness at scale (no DB lookup per request) — a tradeoff you don't need at <500 users. **This exact comparison is one of the most common backend interview questions there is.** You'll be able to answer it from having made the decision, not from a blog post.
- **Argon2id vs bcrypt vs scrypt** — why Argon2id is the current OWASP recommendation (memory-hard, resists GPU/ASIC attacks in a way bcrypt doesn't), and what the three tuning params (memory, iterations, parallelism) actually trade off.
- **Timing attacks and user enumeration** — your existing code equalizes failed-login timing. Understand why: without it, "user not found" returns faster than "wrong password," letting an attacker enumerate valid emails. A subtle, real vulnerability class.
- **OAuth2 + PKCE** — specifically *why* PKCE exists (it protects public clients that can't keep a secret — originally mobile apps — from authorization-code interception). You're implementing it, so learn the actual attack it prevents, not just the flow diagram.
- **`SET LOCAL` and connection pooling** — the bug class here (session state leaking across pooled connections) is a genuinely nasty, concurrency-only, hard-to-test failure mode. Having written the test that catches it is a strong story.
- **Middleware-as-default-deny vs per-handler checks** — an architecture-level security principle that generalizes far beyond this codebase.

---

## 8. Definition of Done

- [ ] Migration 0024 applied, role enum collapsed
- [ ] `RequireRole` middleware mounted on all `/api/v1/admin/*` routes
- [ ] `WithAccount` + `WithAdminSession` helpers implemented in Go, mirroring the existing TS versions
- [ ] All tests in §5 passing, including the concurrent pooled-connection test
- [ ] Google OAuth verified against real credentials (§6)
- [ ] Lint + typecheck + tests green in pre-commit hook

---

Next spec: **F3 — Company List Ingestion** (upload → LLM parse → `target_company` rows).
