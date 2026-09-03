# JobSwitch AI

Job discovery from company career pages, AI matching that explains itself, and
an application workspace that gets you from "this looks right" to "submitted"
without retyping your life story.

**Status: Phase 3 complete** — foundation, identity and tenancy (Phase 1), the
shared job index, work queue and scheduler (Phase 2), plus Lever and Ashby
adapters alongside Greenhouse. AI matching begins in Phase 5.

Design documents:

- Product Definition — scope, layers, MVP/V1/V2 boundaries
- Architecture Decision Record — the 20 decisions this code implements

---

## What is built

| Area | Delivered |
|---|---|
| Monorepo | pnpm workspaces, TypeScript strict, one deployable |
| Database | Postgres 16 + pgvector, SQL migrations, 4 roles, RLS |
| Tenancy | `account` / `app_user` / `account_member` — scoping on `account_id` from day one |
| Auth | Email + password (Argon2id), sessions, password reset, Google OAuth (config-gated) |
| Audit | Append-only, tenant-scoped, enforced by RLS policy rather than convention |
| Job index | Layer 1: companies, career sources, postings, versions, locations, groups |
| Ingestion | Adapter contract + Greenhouse, Lever, Ashby; normalization, versioning, closing |
| Queue | Postgres-backed, `FOR UPDATE SKIP LOCKED`, retries, backoff, dead letter |
| Processes | `web`, `worker`, `scheduler` — one image, three entrypoints |
| Tests | 193 tests against real Postgres — no mocks for the parts that matter |
| Ops | Dockerfile, compose, CI with a real database, health and readiness endpoints |

## Architecture in one paragraph

One repository, one database, three processes (`web`, `worker`, `scheduler` —
all three exist as of Phase 2). Layer 1 is the shared, tenant-free job index; layers
2–4 are strictly tenant-scoped and protected by Postgres row-level security.
Four database roles with different grants, the important one being that the
ingestion role has **no grant at all** on tenant tables: adapters process
untrusted third-party content and must not be able to reach a résumé even if
fully compromised.

### The layer boundary

```
L0  identity      app_user, user_credential, user_session, oauth_identity
                  not tenant-scoped - authentication precedes tenancy
L1  job index     company, career_source, job_posting, versions, groups  ← Phase 2
                  shared, no tenant column, written only by app_ingest
L2  personal      profiles, matches, explanations   (Phase 4-5)   RLS
L3  application   drafts, answers, packages         (Phase 7)     RLS
L4  career OS     audit_log, notifications          RLS
```

## Running the pipeline locally

```bash
pnpm migrate
pnpm --filter @jobswitch/db seed      # 30 companies (tokens unverified - see below)

pnpm --filter @jobswitch/scheduler dev   # enqueues due sources every minute
pnpm --filter @jobswitch/worker dev      # claims and runs them
```

Ingestion is company-centric and shared: one fetch per company serves every
user, so cost scales with the number of companies rather than users x companies
(ADR D-01).

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
| `pnpm --filter @jobswitch/db seed` | Seed the company index |
| `pnpm --filter @jobswitch/db seed:verify` | Probe seeded board tokens (needs network) |
| `pnpm --filter @jobswitch/ingest capture` | Capture a real ATS payload as a fixture |
| `pnpm --filter @jobswitch/worker dev` | Run the queue worker |
| `pnpm --filter @jobswitch/scheduler dev` | Run the scheduler |

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

## Known gaps at the end of Phase 3

- **None of the three adapters has ever seen a real response.** The build
  environment blocks all outbound hosts, so every field mapping comes from
  documentation and every test fixture is synthetic, not captured. ADR D-20
  asks for stored real payloads. Close the gap per adapter with:

  ```bash
  pnpm --filter @jobswitch/ingest capture -- greenhouse <board-token>
  pnpm --filter @jobswitch/ingest capture -- lever <site-token>
  pnpm --filter @jobswitch/ingest capture -- ashby <board-name>
  ```

  then re-run the adapter tests against the captured file. Each parser fails
  loudly on an unexpected shape rather than silently returning nothing, so a
  mismatch surfaces as a failed run and a degraded source - not as an index
  that quietly empties.

- **The 40 seeded board tokens are unverified guesses.** Company names and
  domains are real; the tokens follow each platform's usual slug convention
  and some will be wrong. A wrong token 404s, fails the run, and degrades the
  source after three attempts. Verify them with:

  ```bash
  pnpm --filter @jobswitch/db seed:verify -- --disable-failures
  ```

- **Ashby's compensation mapping is a documentation guess.** `includeCompensation=true`
  is assumed to return a `summaryComponents` array on `compensation`, of which
  only the first tier is read. A board with no compensation configured
  correctly yields `salaryMin/Max: null`; if real data nests the field
  differently, the schema fails loudly like everywhere else - worth watching
  for specifically once a real board is captured.
- **SmartRecruiters, Workable and Workday are V1.**
- **No embeddings or matching yet.** Phase 5.
