# Ephemeral resume retention (ADR D-31)

An explicit "active job search" toggle. While off, every piece of
résumé-derived, employer-specific data this product touched is hard-deleted
— not soft-deleted, not queued for deletion, deleted in the same
transaction that turns the toggle off. Extends `docs/PRD.md` §30's framing
("the fact that a candidate is job hunting is itself sensitive") from an
auth-error-message detail into a real data-lifecycle guarantee. Built
Phase 5.1.

## The principled line

*Does this row name or imply a specific employer/posting engaged with via
this product, during an active search? If yes → purge on stop. If no (it
only describes the candidate, not who they contacted) → retain.*

| Purges | Retains |
|---|---|
| `resume_upload`, `resume_source`, `resume_artifact`, `job_application`, `job_match`, `match_explanation`, `profile_embedding`'s **`resume`** kind only (and `outreach_draft`, once it exists — Phase 5.4/Wave C) | `candidate_profile`, `profile_skill`, `profile_experience` (the candidate's own biography, not "search activity via this product"), `profile_embedding`'s **`desired_role`** kind (derived from that same retained biography), `job_search_session` itself (metadata *about* the search, needed for "resume later" to mean anything) |

`jd_extraction` is unaffected either way — Layer-1-shared, keyed by
`job_posting_version`, not personal data, entirely outside this mechanic.

## Why `resume_upload` is a separate table, not columns on `candidate_profile`

`candidate_profile` deliberately has **no DELETE policy** (see
`specs/profile-and-provenance.md`) — rows are only ever upserted. Splitting
résumé storage into its own table means the purge can be a plain `DELETE
FROM resume_upload WHERE account_id = $1` without touching that existing,
tested invariant. Phase 4 originally put `resume_filename`/`resume_text`/
`resume_uploaded_at` directly on `candidate_profile`; Phase 5.1 split them
out specifically for this reason.

## Schema

`packages/db/migrations/0009_provenance_and_retention.sql`:

```sql
job_search_session (
  account_id, status CHECK (active|stopped), started_at, stopped_at,
  stop_reason CHECK (user_action|scheduled_sweep_inactivity)
)
-- partial unique index: at most one ACTIVE session per account
-- append-only history (mirrors scrape_run/audit_log), not a boolean

resume_upload (
  account_id PK, filename, raw_text, uploaded_at
)
```

## Purge trigger

Two, for different failure modes — not redundant:

1. **Explicit stop (primary, built)**: `POST /api/v1/job-search/stop`.
   `packages/db/src/repositories/jobSearch.ts`'s `stopJobSearch` — one
   transaction, hard `DELETE` across every table in `PURGE_TABLES`, under
   the account's own `withAccount`/`app_web` context. Synchronous, not
   queued: "boom, gone" is a claim about *when*, and an async purge could
   only honestly say "stopping…" while the data might still exist. Data
   volume (one account, ~6 tables) is trivially small — async buys
   nothing.

2. **Scheduled sweep (safety net, built Phase 5.3)**: lives in
   `services/backend/cmd/worker`, not `apps/scheduler` — finding every
   dormant session is a cross-tenant query by nature, which only returns
   correct results under a `BYPASSRLS` role with no tenant context set,
   and `apps/scheduler` connects as `app_ingest`, which has zero grant on
   tenant tables by design and must stay that way. `internal/worker/
   schedule.go`'s `RunScheduledTasks` runs as a goroutine alongside
   `cmd/worker`'s queue-claim loop, guarded by its own session-scoped
   advisory lock (`scheduledTasksAdvisoryLock`, distinct from `apps/
   scheduler`'s own lock id — a second replica that fails to acquire it
   returns immediately rather than exiting the process, since this
   binary's primary job, claiming from `job_queue`, must keep running
   regardless). Each tick (`MATCH_TICK_MS`, default 5 minutes):
   `repo.ActiveJobSearchAccountIDs` → `match.RunForAccount` per account,
   then `repo.FindDormantActiveSessions(staleDays)` (Go port of
   `jobSearch.ts`'s own query — same WHERE clause) →
   `repo.SweepDormantSession` per dormant account, which stops the session
   (`stop_reason = 'scheduled_sweep_inactivity'`) and hard-deletes the same
   purge tables `stopJobSearch` does, including the kind-scoped
   `profile_embedding` delete, all in one transaction. Needed its own
   grants — `app_matcher` had never touched `job_search_session`, and only
   had `SELECT` (not `DELETE`) on several purge tables; migrations `0015`
   and `0016` close that gap (`0016` specifically because Postgres requires
   `SELECT` on any column a `DELETE`'s `WHERE` clause reads, which `0015`
   missed for `resume_source`/`resume_artifact` — caught by the
   integration test actually running the sweep, not by inspection).

## `PURGE_TABLES` — a list that must grow with the schema

```ts
const PURGE_TABLES = [
  'resume_upload', 'resume_source', 'resume_artifact',
  'job_application', 'job_match', 'match_explanation',
] as const;
```

Every migration that adds a new purge-eligible table must add it here **in
the same migration** — this list existing out of sync with the schema is
exactly the kind of silent gap D-31 exists to prevent. When `job_match`/
`match_explanation` were added (migration 0011), this list was extended in
the same PR, and the purge test was extended to seed and verify a real row
in each rather than trusting the table name alone.

Two grants exist purely to make this purge possible for `app_web`:
`job_match_tenant_purge` and `match_explanation_tenant_purge` are RLS
DELETE policies scoped to `account_id = app_current_account_id()`, plus a
table-level `GRANT DELETE` — `app_web` otherwise only has `UPDATE
(dismissed_at)` on `job_match` (it can dismiss a match, never rescore one).
The DELETE grant is the one exception, and RLS still confines it to the
caller's own account — not a broadened blanket grant.

**`profile_embedding` is deliberately NOT in `PURGE_TABLES`**, even though
its `resume` kind purges on every stop (Phase 5.3, closing the gap this
section used to flag: "wiring it is Phase 5.3 work, done alongside the
embedding worker that populates it"). Every `PURGE_TABLES` entry is a
blanket `DELETE FROM table WHERE account_id = $1`; `profile_embedding`
can't use that shape because its `desired_role` kind is derived from
`candidate_profile`/`profile_skill` — retained biography, not search
content — and must survive a stop exactly like those tables do. So
`jobSearchRepo.stopJobSearch` runs one more, kind-scoped statement right
after the loop: `DELETE FROM profile_embedding WHERE account_id = $1 AND
kind = 'resume'`, and reports `'profile_embedding'` in `purgedTables`
alongside everything else. This needed its own grant too — migration 0014
gives `app_web` `DELETE` on `profile_embedding` (the RLS policy already
existed from migration 0010; a policy with no table-level privilege still
fails closed, the same lesson `job_match`/`match_explanation`'s grants
above already encode).

## Hard delete, no soft delete — one named caveat

A purged résumé can still exist in a pre-purge Postgres backup snapshot for
as long as that snapshot is retained. This is exactly why the eventual
backup job (Phase 5.0, not yet built) needs an explicit, short retention
cap — the purge guarantee is only as strong as the backup policy around it.

## API

```
POST /api/v1/job-search/start   { filename, rawText }  -> { session, resume }
     (idempotent while already active: updates the resume, doesn't error
      or create a second session)
POST /api/v1/job-search/stop    -> { session, purgedTables } | 404 if none active
GET  /api/v1/job-search/status  -> { active, session, resume }
```

## Tests

| Suite | File | Proves |
|---|---|---|
| vitest | `packages/db/test/jobSearch.test.ts` (10) | RLS isolation; the purge actually deletes rows (verified via the RLS-bypassing owner pool, not just "the app can't see it"); `candidate_profile`/`profile_skill`/`profile_experience` **and `profile_embedding`'s `desired_role` kind** explicitly survive a purge while its `resume` kind is deleted; dormancy detection at a backdated `started_at`; `startJobSearch` enqueues exactly one `embed.profile` (kind `resume`) job even across a repeated "already active" call |
| vitest | `apps/web/test/jobSearch.test.ts` (7) | Route wiring, 404 on stop-with-nothing-active, cross-tenant isolation at the route layer |
| go test | `services/backend/internal/worker/schedule_test.go` | `FindDormantActiveSessions`/`SweepDormantSession` against real Postgres: dormant vs. fresh vs. already-stopped sessions correctly distinguished, purge tables actually emptied while `candidate_profile` and `profile_embedding`'s `desired_role` kind survive, a second sweep of an already-stopped session is a benign no-op; `RunScheduledTasks` yields immediately when another instance already holds its advisory lock |
