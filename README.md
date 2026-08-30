# JobSwitch AI

Job discovery from company career pages, AI matching that explains itself, and
an application workspace that gets you from "this looks right" to "submitted"
without retyping your life story.

**Status: Phase 1 complete** — foundation, identity, tenancy and the security
model. Job ingestion begins in Phase 2.

Design documents:

- Product Definition — scope, layers, MVP/V1/V2 boundaries
- Architecture Decision Record — the 20 decisions this code implements

---

## What Phase 1 contains

| Area | Delivered |
|---|---|
| Monorepo | pnpm workspaces, TypeScript strict, one deployable |
| Database | Postgres 16 + pgvector, SQL migrations, 4 roles, RLS |
| Tenancy | `account` / `app_user` / `account_member` — scoping on `account_id` from day one |
| Auth | Email + password (Argon2id), sessions, password reset, Google OAuth (config-gated) |
| Audit | Append-only, tenant-scoped, enforced by RLS policy rather than convention |
| Tests | 45 tests against real Postgres — no mocks for the parts that matter |
| Ops | Dockerfile, compose, CI with a real database, health and readiness endpoints |

## Architecture in one paragraph

One repository, one database, three processes (`web`, `worker`, `scheduler` —
only `web` exists so far). Layer 1 is the shared, tenant-free job index; layers
2–4 are strictly tenant-scoped and protected by Postgres row-level security.
Four database roles with different grants, the important one being that the
ingestion role has **no grant at all** on tenant tables: adapters process
untrusted third-party content and must not be able to reach a résumé even if
fully compromised.

### The layer boundary

```
L0  identity      app_user, user_credential, user_session, oauth_identity
                  not tenant-scoped - authentication precedes tenancy
L1  job index     shared, no tenant column          (Phase 2)
L2  personal      profiles, matches, explanations   (Phase 4-5)   RLS
L3  application   drafts, answers, packages         (Phase 7)     RLS
L4  career OS     audit_log, notifications          RLS  ← audit_log exists now
```

## Local development

Requires Node 22+, pnpm 10+, and Postgres 16 with pgvector.

```bash
pnpm install
docker compose up -d postgres        # or use a local Postgres 16 + pgvector

cp .env.example .env                 # then edit SESSION_SECRET
```

Create the application role. **Do not run the app as the database owner** — the
owner bypasses RLS, so tenant isolation would silently stop applying:

```sql
CREATE ROLE app_web_local LOGIN PASSWORD 'changeme';
GRANT app_web TO app_web_local;      -- app_web is created by migration 0001
```

Then:

```bash
pnpm migrate                         # uses DATABASE_URL_MIGRATE
pnpm dev                             # http://localhost:3000
```

## Tests

```bash
pnpm test
```

Tests run against a **real** Postgres, not a mock. Tenant isolation cannot be
verified against a fake — the whole property under test is how Postgres behaves
when a policy is in place and a role is not the owner.

The suite that matters most is `packages/db/test/rls.test.ts`. It connects as
`app_web` (not the owner) and proves that a tenant sees only its own rows, that
a query with no tenant context returns nothing rather than everything, that one
tenant cannot insert a row attributed to another, that the context does not
leak across pooled connections, and that the ingestion role cannot read user
data at all.

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | Run the web app with reload |
| `pnpm build` | Compile all packages |
| `pnpm typecheck` | Types only, no emit |
| `pnpm test` | Everything, against real Postgres |
| `pnpm migrate` | Apply pending migrations |
| `pnpm migrate:status` | Show applied and pending |

## Adding a migration

Add a numbered `.sql` file to `packages/db/migrations/`. Applied files are
checksummed — editing one that has already run is rejected rather than silently
producing environments whose schemas differ while both claim to be current.

Every new tenant-scoped table follows `0004_audit_log_rls.sql`: an `account_id`
column, `ENABLE ROW LEVEL SECURITY`, a policy for `SELECT` **and** a
`WITH CHECK` policy for `INSERT`, then grants. Omitting the `WITH CHECK` half
protects reads while leaving writes open, which is the easy mistake.

## Health endpoints

- `GET /healthz` — liveness. Touches nothing, so a database blip does not get a
  healthy process killed.
- `GET /readyz` — readiness. Checks the database and reports pending
  migrations; returns 503 when the schema is behind.

## Known gaps at the end of Phase 1

Stated plainly so nothing here reads as more finished than it is.

- **Google OAuth is implemented but not verified end to end.** No real
  credentials existed in the build environment. State/PKCE handling and the
  id_token claim checks are written and the flow is config-gated, but the live
  round trip is untested. Treat the first run against real credentials as the
  actual verification.
- **Email is not really sent.** `MAIL_TRANSPORT=log` writes reset links to the
  application log. A real provider is Phase 8.
- **Auth pages are server-rendered from the API process.** The architecture puts
  a static frontend on a CDN; that split arrives in Phase 6 when there is a
  dashboard worth building. Nothing here blocks it — sessions are a cookie on
  the registrable domain.
- **Nothing is deployed.** The Dockerfile, compose file and CI are written and
  the app has been smoke-tested over real HTTP, but no VPS, domain or managed
  database exists yet. See `docs/DEPLOYMENT.md`.
- **Rate limiting is per-process, in memory.** Correct for one VPS; it weakens
  the moment a second web process exists.
