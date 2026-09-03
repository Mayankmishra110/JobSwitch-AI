# Current State Architecture

**What this document is:** a factual reconstruction of what exists in this
repository right now (through the Phase 4 commit, `da38b69`), written by
reading the code — not by consulting a prior specification, because none
exists. See the note on provenance below.

**What this document is not:** a description of intended or desired
architecture. Where current behavior looks like a gap or a wrong call, it is
noted inline, but not fixed here. See `GAP_ANALYSIS.md` for the comparison
against a proposed target, and `docs/PRD.md` / `docs/ADR.md` for what is
being decided going forward.

## Provenance note

The README cites a "Product Definition" and an "Architecture Decision
Record" as the design authority behind this code (comments throughout
reference "ADR D-01" through "D-20" and "PRD §30" and "§17"). Neither
document exists in this repository or anywhere this session has access to.
Full git history was checked — they were never committed. The citations are
real in the sense that the code consistently behaves as if such decisions
were made (the numbering is internally consistent across Phases 1–3, which
were built by an earlier session), but the documents themselves are missing.
Phase 4 (candidate profile) was built by a later session with no such
document at all, working from the layer diagram and existing patterns.

---

## 1. Repository structure

pnpm workspace monorepo, one deployable image with three entrypoints.

```
apps/
  web/         Fastify HTTP API + server-rendered auth pages (the deployable)
  worker/      Queue worker process (same image, different entrypoint)
  scheduler/   Singleton scheduler process (same image, different entrypoint)
packages/
  core/        Domain types, zod input schemas, error taxonomy - no I/O
  db/          Postgres access: pool, migrations, RLS context, repositories
  ingest/      ATS adapter contract + adapters, normalization, run pipeline
docs/
  DEPLOYMENT.md   Deployment runbook (target: CDN + 1 VPS + managed Postgres)
```

`core` has no dependency on `db` or `ingest`. `db` depends on `core` only.
`ingest` depends on `db` and `core`. `apps/*` depend on all three. This is a
strict layering, not enforced by tooling (no dependency-cruiser / boundary
lint config exists) — it holds today by convention.

## 2. Database schema

Postgres 16 + pgvector. Seven migrations, applied in order, checksummed
(`packages/db/src/migrate.ts` — editing an applied file throws rather than
silently drifting).

| # | File | Adds |
|---|---|---|
| 0001 | `extensions_roles.sql` | `vector`, `pgcrypto` extensions; 4 roles (`app_web`, `app_ingest`, `app_matcher`, migration owner); `app_current_account_id()` RLS helper |
| 0002 | `identity.sql` | `account`, `app_user`, `user_credential`, `account_member`, `oauth_identity` — Layer 0, not tenant-scoped |
| 0003 | `sessions.sql` | `user_session`, `password_reset_token` — hashed-token-only, Layer 0 |
| 0004 | `audit_log_rls.sql` | `audit_log` — first tenant-scoped table, the RLS template every later table follows |
| 0005 | `job_index.sql` | `ats_platform`, `company`, `career_source`, `job_posting`, `job_posting_version`, `job_posting_location`, `job_group`, `job_group_link`, `scrape_run` — Layer 1, shared, no tenant column |
| 0006 | `job_queue.sql` | `job_queue` — Postgres-backed work queue |
| 0007 | `personal_profile.sql` | `candidate_profile`, `profile_skill`, `profile_experience` — Layer 2, tenant-scoped |

**`vector` extension is enabled but unused.** No table has a `vector` column
anywhere in the schema. `job_posting_version` has no embedding column;
`candidate_profile` has no embedding column. Embedding readiness is: the
extension is installed, and nothing else.

### 2.1 Database roles and grants

| Role | Bypasses RLS? | Grants |
|---|---|---|
| Migration owner | Yes (table owner) | DDL on everything; used only for `pnpm migrate` |
| `app_web` | No | Full CRUD on Layer 0 (identity, sessions), Layer 2 (`candidate_profile`, `profile_skill`, `profile_experience` — no DELETE on `candidate_profile`), Layer 4 (`audit_log`, INSERT/SELECT only); SELECT-only on Layer 1 (job index); SELECT+INSERT on `job_queue` |
| `app_ingest` | No | Full CRUD on Layer 1 (job index) and `job_queue`; **zero grants on any tenant table** — cannot read `app_user`, `user_credential`, `candidate_profile`, anything |
| `app_matcher` | **Yes** (`ALTER ROLE app_matcher BYPASSRLS`) | SELECT on Layer 1 only, currently. No grant yet on `candidate_profile` / `profile_skill` / `profile_experience` — a Phase 5 matcher cannot read profile data without a new grant added deliberately |

The `app_ingest` isolation (no grant at all on tenant tables) is the one
property enforced by an actual test
(`packages/db/test/rls.test.ts` → "app_ingest has no access to tenant tables
at all").

## 3. Tenancy and RLS

- **Tenant root is `account`, not `app_user`.** `account.type` is `'personal'`
  or `'organization'`; at present every signup creates exactly one personal
  account with one `account_member` row, `role = 'owner'`. Multi-user
  organizations are schema-ready (the membership table already supports
  many-to-many) but nothing in the product exercises that yet — no invite
  flow, no role-gated UI.
- **RLS begins at Layer 2** (`audit_log` in Phase 1, extended to
  `candidate_profile` / `profile_skill` / `profile_experience` in Phase 4).
  Layer 0 (identity, sessions) and Layer 1 (job index) are **not**
  RLS-protected — Layer 0 because tenancy isn't known yet at that point in a
  request, Layer 1 because it's genuinely shared, not tenant data.
- **Context propagation**: `withAccount(pool, accountId, fn)` opens a
  transaction, runs `SELECT set_config('app.current_account_id', $1, true)`
  (transaction-scoped via the `true` / `SET LOCAL` semantics), then runs
  `fn`. `withoutTenantContext(pool, fn)` runs with no account context — legal
  only for Layer 0 work. There is no lint or type-level enforcement that a
  Layer 2+ repository call happens inside `withAccount`; it is a naming/code-
  review convention only.
- **Policy shape per table**: `USING (account_id = app_current_account_id())`
  for SELECT, `WITH CHECK (...)` for INSERT, and for mutable tables
  (`candidate_profile`, `profile_experience`) also for UPDATE. `profile_skill`
  and `profile_experience` additionally have a DELETE policy;
  `candidate_profile` does not (rows are only ever upserted, never deleted by
  the app — deletion happens only via `account` cascade).
- **What is actually tested**: cross-tenant read isolation, cross-tenant
  write rejection (INSERT `WITH CHECK` throws), that an unscoped query
  returns zero rows rather than every tenant's rows, that the tenant context
  does not leak across pooled connections, and that it's released on error.
  This is proven for `audit_log` (Phase 1) and the three Phase 4 profile
  tables — not for anything a future phase adds; each new tenant table needs
  its own RLS test.

## 4. User / profile relationships

```
app_user  1───1  account_member  1───1  account  1───1  candidate_profile
   │  (id)          (user_id,          (account_id)      (account_id, PK)
   │                 role='owner')
   │
   └── user_credential (1:1, password hash)
   └── oauth_identity (1:many, Google only)
   └── user_session (1:many)

account  1───many  profile_skill        (account_id FK, unique on (account_id, lower(skill)))
account  1───many  profile_experience   (account_id FK)
```

- `candidate_profile.account_id` is the **primary key**, not a separate `id`
  — enforced 1:1 with `account`, not with `app_user`. In an organization
  account (schema-ready but unused), this means one shared profile per
  account, not one per member — that has never been decided one way or the
  other; it's just what falls out of scoping everything to `account_id`
  consistently with Layers 2–4.
- **No provenance/verification tracking anywhere in `candidate_profile`,
  `profile_skill`, or `profile_experience`.** Every field is a flat nullable
  column. There is no way to distinguish "the user typed this," "this was
  extracted from an uploaded resume," "this is a stated preference for job
  search," or "this text was AI-generated." `headline`, `summary`,
  `currentTitle`, `desiredTitles` (a preference), `desiredSalaryMin` (a
  preference), and `resumeText` (extracted content) all live at the same
  flat level with the same guarantees (none). This is the most direct place
  Phase 4's implementation has no way to express the
  `verified_fact → preference → AI inference → generated text` distinction —
  because that distinction was introduced after Phase 4 was built, not
  before.
- **Resumes are text-only.** `resume_filename` and `resume_text` exist;
  there is no object storage integration, no binary retention, and no
  extraction pipeline (`setResume()` takes already-extracted text as a
  parameter — nothing in this repo produces that text). `docs/DEPLOYMENT.md`
  (written earlier, and actually committed) explicitly says object storage
  is "not needed until Phase 4 (résumés)" — i.e., the deployment runbook
  anticipated Phase 4 needing file storage, and Phase 4 as actually built
  does not have it.

## 5. Company → career source → ATS → job relationships

```
ats_platform (7 seeded rows: greenhouse, lever, ashby, smartrecruiters,
              workable, workday, custom — only the first 3 have adapters)
    ↑ FK
career_source ──→ company (many:1)
    │  (ats_type, board_identifier) unique
    │  status: active | degraded | disabled
    │  consecutive_failures, next_run_at (drives the scheduler)
    ↓ 1:many
job_posting ──→ company (denormalized FK, also many:1)
    │  identity = (career_source_id, source_job_id), never anything else
    │  absent_run_count, closed_at, reopened_at, is_repost
    ↓ 1:many, append-only
job_posting_version
    │  content_fingerprint unique per posting
    │  current_version_id back-reference from job_posting
    ↓ 1:many
job_posting_location

job_posting ──→ job_group_link (0:1) ──→ job_group ──→ representative_posting_id
    (advisory link only; never merges rows; reversible)

career_source ──→ scrape_run (1:many, append-only run log)
```

- **Identity is strict**: `(career_source_id, source_job_id)` uniquely
  identifies a posting. Two ATS platforms both listing the same real-world
  job produce two `job_posting` rows, optionally linked via `job_group` —
  never merged.
- **Grouping** (`packages/ingest/src/grouping.ts`) only runs on newly created
  postings, using title normalization + Jaccard-with-length-penalty text
  similarity, at two thresholds (0.75 same-source repost, 0.80 cross-source).
  Below threshold → no link, by design (a missed link is a visible
  duplicate; a wrong link silently hides a posting).
- **Absence handling** (`packages/ingest/src/run.ts`): a posting closes only
  after being absent from **two consecutive successful runs**, and an empty
  result set is never trusted to mean "close everything" if the source
  currently has open postings — that gets reported as a suppressed run
  instead. This is the one invariant with an explicit "the guard that
  matters" callout in the Phase 2 commit message.
- **Cadence tiers** (`hot` / `standard` / `cold`) exist as a `company` column
  and are read by nothing yet — `findDueSources` uses `next_run_at`
  directly; tier-based interval selection is not implemented, only the
  column is there for it.

## 6. ATS adapter interface (`packages/ingest/src/adapter.ts`)

```ts
interface AtsAdapter {
  atsType: string;
  capabilities: SourceCapabilities;   // structuredLocation, structuredSalary, department, directApplyUrl, autofillable
  detect(careerUrl: string): DetectResult | null;
  fetch(ctx: FetchContext): Promise<FetchResult>;   // raw records, unknown[]
  normalize(raw: unknown): NormalizedPostingInput;  // pure, no I/O
}
```

Three implementations exist: `greenhouse.ts`, `lever.ts`, `ashby.ts`,
registered in `registry.ts` as a flat array (`ADAPTERS`), looked up by
`atsType`. **None of the three has ever been run against a live board** — the
build/dev environment used for all of Phases 1–4 blocks outbound network
access. All three fixtures are hand-constructed from each platform's
documented response shape, not captured. A `capture` CLI exists
(`pnpm --filter @jobswitch/ingest capture -- <ats> <token>`) to close this
gap on a networked machine, but has never been run for real.

`fetch()` throws `AdapterShapeError` on any response that doesn't match the
expected zod schema — deliberately, so a platform's shape change surfaces as
a failed run rather than an index that silently empties (this is the same
"D-05 guard" property described in §5 above, enforced per-adapter).

## 7. Queue and scheduler

- **`job_queue`** (Postgres table, `packages/db/src/repositories/queue.ts`):
  `FOR UPDATE SKIP LOCKED` claim, exponential backoff with jitter on
  retry, dead-letter after `max_attempts` (default 5), a visibility timeout
  for orphan reclaim, and a dedup key unique among live (`pending`/`running`)
  rows only.
- **Scheduler** (`apps/scheduler/src/main.ts`): a single long-running loop,
  ticking every `SCHEDULER_TICK_MS` (default 60s), guarded by a Postgres
  session-scoped advisory lock so a second instance started during a deploy
  exits immediately rather than double-enqueueing. `enqueueDueSources()`
  finds sources whose `next_run_at` has passed and enqueues one
  `ingest.source` job per source, with a dedup key of
  `ingest.source:<sourceId>:<currentHour>` — belt-and-suspenders against the
  advisory lock.
- **Worker** (`apps/worker/src/worker.ts`): generic — takes a
  `Record<queueName, handler>` map, currently just `{ 'ingest.source':
  handleIngestSource }`. Claims up to 10 jobs per loop iteration, sleeps
  when idle, never crashes the process on a handler error (retries or dead-
  letters instead) or on a database outage (backs off and retries the loop).
- Only one queue name exists today: `ingest.source`. No queue for resume
  parsing, embedding generation, or match computation exists yet — those
  would be new queue names + new handlers registered in the worker's handler
  map, not a new subsystem.

## 8. API surface (`apps/web`)

Fastify. Session auth via a signed httpOnly cookie
(`js_session`, cross-checked against `user_session.token_hash`, SHA-256 of
the raw token — the raw value never touches the database).
`request.principal` (`{ userId, accountId, role, sessionId }`) is attached
on every request by a `preHandler` hook, `null` if no valid session; routes
opt into requiring it via `app.requireAuth` (401 JSON) or `app.requirePage`
(redirect to `/login`).

| Route | Auth | Layer touched |
|---|---|---|
| `GET /healthz`, `GET /readyz` | none | — |
| `GET /`, `GET /app` | page guard | Layer 0 (renders a placeholder dashboard) |
| `GET /login`, `/signup`, `/forgot-password`, `/reset-password` (pages) | none | Layer 0 |
| `POST /auth/signup`, `/auth/login`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password` | none / session | Layer 0 |
| `GET /auth/google`, `/auth/google/callback` | none (config-gated) | Layer 0 |
| `GET /api/v1/me` | required | Layer 0 |
| `GET /api/v1/profile` | required | Layer 2 |
| `PUT /api/v1/profile` | required | Layer 2 |
| `PUT /api/v1/profile/skills` | required | Layer 2 |
| `POST /api/v1/profile/experience` | required | Layer 2 |
| `PATCH /api/v1/profile/experience/:id` | required | Layer 2 |
| `DELETE /api/v1/profile/experience/:id` | required | Layer 2 |

No route exists yet for: browsing/searching the job index, resume upload,
viewing a match, applying to anything, or any organization/multi-member
flow. The dashboard at `GET /app` is a placeholder from Phase 1
(`views/pages.ts`), never replaced.

## 9. Tests

223 tests, all requiring a real Postgres connection for the `db` and `web`
suites (`ingest`'s adapter tests are pure/offline; `run.test.ts` needs
Postgres too). No mocking of Postgres anywhere — the stated project
philosophy (README) is that RLS correctness cannot be verified against a
fake.

| Suite | File | Count | What it proves |
|---|---|---|---|
| db | `rls.test.ts` | 9 | `audit_log` tenant isolation, `app_ingest` zero tenant access |
| db | `queue.test.ts` | 16 | Claim/complete/fail/dead-letter/dedup/visibility-timeout semantics |
| db | `migrate.test.ts` | 3 | Migration runner (checksum drift detection, idempotent apply) |
| db | `profile.test.ts` | 17 | `candidate_profile`/`profile_skill`/`profile_experience` RLS + repository behavior + DB-constraint defense-in-depth |
| ingest | `normalize.test.ts` | 27 | Title/location/HTML/fingerprint utilities |
| ingest | `greenhouse.test.ts` | 27 | Detect/fetch/normalize against a synthetic fixture |
| ingest | `lever.test.ts` | 27 | Same, Lever |
| ingest | `ashby.test.ts` | 28 | Same, Ashby (incl. structured salary) |
| ingest | `run.test.ts` | 23 | Full ingestion pipeline against real Postgres (upsert, versioning, grouping, absence handling) |
| web | `auth.test.ts` | 30 | Signup/login/logout/password reset/OAuth-gating, real Fastify + Argon2 |
| web | `profile.test.ts` | 13 | Route wiring, validation, 404 handling, cross-tenant isolation at the route layer |
| web | `rate-limit.test.ts` | 3 | Rate limiter behavior |

CI (`.github/workflows/ci.yml`) runs `pnpm build && pnpm typecheck && pnpm
test` against a `pgvector/pgvector:pg16` service container on every push to
`main` and every PR. No deploy step exists in CI — nothing is deployed
anywhere (confirmed in both README and `docs/DEPLOYMENT.md`).

## 10. Environment / configuration

`apps/web/src/config.ts` — zod-validated at boot, fails fast on invalid
config rather than at first use. Notable: `SESSION_SECRET` must be ≥32
chars; Google OAuth is all-or-nothing (any one of the three vars present
without the others leaves it disabled, not half-configured); rate limiting
is a single boolean gate used to keep most of the test suite fast while a
dedicated suite asserts the limits are real.

Four separate `DATABASE_URL*` variables exist by design, one per role:
`DATABASE_URL` (app_web-granted, used by the running app),
`DATABASE_URL_MIGRATE` (owner, DDL rights, used only by `pnpm migrate`),
`DATABASE_URL_INGEST` (app_ingest-granted, used by worker + scheduler). A
fourth, `app_matcher`-granted, does not exist yet in `.env.example` — Phase
5 will need one.

No `OBJECT_STORE_*`, embedding-provider, or LLM-provider variables exist
anywhere in `.env.example` or the config schemas. Nothing in the codebase
currently expects to make an external AI API call.
