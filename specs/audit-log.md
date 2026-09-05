# Audit log

Append-only record of security-relevant account activity. Layer 4, the one
tenant-scoped table that exists purely as a record, never read back by any
route yet. Built Phase 1 — it's also the RLS *template* every tenant-scoped
table since has copied exactly (`packages/db/migrations/
0004_audit_log_rls.sql`'s own header comment says so directly).

## Schema

```sql
audit_log (
  id, account_id, actor_user_id, action, target, metadata jsonb,
  ip_address, user_agent, created_at
)
```

RLS: `SELECT`/`INSERT` policies scoped to `account_id =
app_current_account_id()`. **No `UPDATE` or `DELETE` policy exists at
all** — not an oversight, the mechanism by which "append-only" is a
database-enforced property rather than a convention `app_web`'s code
happens to follow. `GRANT SELECT, INSERT ON audit_log TO app_web` only;
there is no grant that could make an update or delete succeed even if
application code tried.

## What gets written

`action` is a closed TypeScript union (`packages/core/src/audit.ts`), not
a free string — a typo becomes a compile error instead of an unqueryable
row:

```ts
type AuditAction =
  | 'user.signed_up' | 'user.signed_in' | 'user.signed_in_oauth'
  | 'user.signed_out' | 'user.sign_in_failed'
  | 'password.reset_requested' | 'password.reset_completed'
  | 'session.revoked' | 'session.revoked_all' | 'account.created';
```

**Only seven of these ten are actually written anywhere.** Every auth flow
in `apps/web/src/services/auth.ts` (see `specs/auth-and-identity.md`)
writes one of: `user.signed_up`, `user.signed_in`, `user.signed_in_oauth`,
`user.signed_out`, `user.sign_in_failed`, `password.reset_requested`,
`password.reset_completed`. **`session.revoked`, `session.revoked_all`,
and `account.created` are declared in the type but no code path writes
them** — `logout` revokes a session without a dedicated audit action for
it (it writes `user.signed_out` instead), and account creation is folded
into `user.signed_up`. Worth resolving one way or the other before this
type grows further: either wire these three in, or remove them so the
type doesn't imply coverage that doesn't exist.

## Write discipline: best-effort, never blocking

`apps/web/src/services/auth.ts`'s local `audit()` helper wraps every call.
The comment on it is direct: *"an audit write must never be the reason a
user cannot sign in."* Concretely, a login/signup/reset call site's audit
write happens **after** its own transaction commits, in a separate
`withAccount` call — if the audit insert itself fails (a connection blip,
for instance), the auth operation the user actually cares about has
already succeeded and is not rolled back by it. This is a deliberate
asymmetry: correctness of the auth action is guaranteed; completeness of
the audit trail is best-effort.

## Reading it back

`packages/db/src/repositories/audit.ts`'s `listAuditEntries` exists
(ordered `created_at DESC`, capped at 200 rows) but **no route calls it**.
There is no "activity log" or "security" page anywhere in `apps/web` yet —
the audit log is currently write-only from the product's perspective. A
real consumer (an account-security UI, or an internal ops view) is
unbuilt.

## Tenant isolation

Proven directly, not just by the general RLS template it defines — see
`packages/db/test/rls.test.ts`'s `describe('row-level security')` block:
a tenant sees only its own rows; an unscoped query (no `app.
current_account_id` set) returns zero rows, not every tenant's; a tenant
cannot insert a row attributed to another account (the `WITH CHECK` half);
the tenant context does not leak across pooled connections, and is
released even when the callback throws; and the append-only property
itself — a direct `UPDATE`/`DELETE` against `audit_log` as `app_web` fails
regardless of tenant context, because no policy permits either operation
at all.

## Known gaps

- `session.revoked` / `session.revoked_all` / `account.created` are
  unused — see above.
- No route or UI reads the audit log back.
- No retention policy — rows accumulate indefinitely. Unlike
  `specs/ephemeral-retention.md`'s résumé data, audit entries are
  explicitly framed as security history, not personal data subject to the
  same purge mechanic; whether they need their own retention cap (and, if
  the account itself is ever deleted, what happens to its audit trail) is
  undecided.

## Tests

| Suite | File | Proves |
|---|---|---|
| vitest | `packages/db/test/rls.test.ts` (9) | RLS isolation, unscoped-query safety, cross-tenant insert rejection, connection-context non-leakage, append-only enforcement |
| vitest | `apps/web/test/auth.test.ts` | Individual auth flows write the audit entry they claim to (e.g. "writes an audit entry scoped to the new account") |
