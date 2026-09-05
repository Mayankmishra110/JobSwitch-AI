# Job ingestion

The shared, tenant-free job index (Layer 1): companies, their career
sources, the postings on each, versioned over time. Built Phase 2 (index,
queue, scheduler, Greenhouse adapter) and Phase 3 (Lever, Ashby adapters).

## Why shared, not per-user

`packages/db/migrations/0005_job_index.sql`: no `account_id` column
anywhere in Layer 1. One fetch per company serves every candidate — cost
scales with companies, not `companies × candidates` (ADR D-01). This is
also the cost boundary that makes the eventual matching pipeline
affordable: embeddings and LLM calls only ever need to happen once per
job-posting-version, not once per (candidate, posting) pair for the
shared-content half.

## Schema

```
ats_platform (7 seeded: greenhouse, lever, ashby, smartrecruiters,
              workable, workday, custom — only the first 3 have adapters)
company ──< career_source ──< job_posting ──< job_posting_version (append-only)
                                    │              └─ job_posting_location
                                    └─< job_group_link >── job_group
career_source ──< scrape_run (append-only run log)
```

- **Identity**: `(career_source_id, source_job_id)`, nothing else. Two
  platforms listing "the same" real job produce two rows, optionally
  linked via `job_group` — never merged (ADR D-03/D-04).
- **Versions**: append-only, one row per meaningful content change (keyed
  by a fingerprint insensitive to whitespace/formatting churn). This is
  what lets a Phase 5 embedding or explanation cache correctly against
  "this exact version" rather than "this posting as of whenever" (ADR
  D-09) — `job_posting_version.embedding` (added migration 0010) and
  `match_explanation` (migration 0011) both key off this table's `id`.
- **Absence handling**: a posting closes only after two consecutive
  successful runs miss it. An empty result set from a source that
  currently has open postings never closes anything — reported as a
  suppressed run instead (ADR D-05, the one guard with its own "the guard
  that matters" callout in the Phase 2 commit).
- **Cadence tiers** (`hot`/`standard`/`cold`) exist as a column; nothing
  reads them yet — scheduling is flat `next_run_at` today. Real future
  work, not a current bug.

## ATS adapter contract

`packages/ingest/src/adapter.ts`:

```ts
interface AtsAdapter {
  atsType: string;
  capabilities: SourceCapabilities;
  detect(careerUrl: string): DetectResult | null;
  fetch(ctx: FetchContext): Promise<FetchResult>;   // raw records, unknown[]
  normalize(raw: unknown): NormalizedPostingInput;  // pure, no I/O
}
```

Adding a platform is one file implementing this interface plus one line in
`registry.ts`'s `ADAPTERS` array — `packages/ingest/src/run.ts`'s pipeline
never changes per platform. `fetch()` throws `AdapterShapeError` on any
response that doesn't match the expected zod schema, deliberately — a
platform's shape change must surface as a failed, recorded run, never as
an index that silently stops growing (same D-05 principle, enforced
per-adapter).

Three adapters exist: `greenhouse.ts`, `lever.ts`, `ashby.ts`.
**None has ever been run against a live board** — every fixture is
hand-constructed from documentation, not captured, because this build
environment has no outbound network access. `pnpm --filter
@jobswitch/ingest capture -- <ats> <token>` exists specifically to close
this gap on a networked machine; it has never been run.

## Queue and scheduler

`packages/db/migrations/0006_job_queue.sql` + `packages/db/src/
repositories/queue.ts`: a plain Postgres table, `FOR UPDATE SKIP LOCKED`
claim, exponential backoff with jitter, dead-letter after `max_attempts`
(default 5), visibility-timeout-based orphan reclaim, dedup key unique
among live (`pending`/`running`) rows only.

`apps/scheduler`: one long-running loop, ticking every
`SCHEDULER_TICK_MS`, guarded by a Postgres session-scoped advisory lock so
a second instance started during a deploy exits immediately rather than
double-enqueueing. `enqueueDueSources()` finds sources whose
`next_run_at` has passed, enqueues `ingest.source` jobs with a dedup key
of `ingest.source:<sourceId>:<currentHour>` as a second, independent guard.

`apps/worker`: a generic `Worker` class taking a `{queueName: handler}`
map — currently just `{'ingest.source': handleIngestSource}`. This design
is why `services/matcher`'s eventual worker can share the exact same
`job_queue` table with new queue names (`embed.job_version`,
`match.account`, ...) and no coordination beyond that — see
`specs/architecture.md`'s note on the two-pool design and
`specs/matching-pipeline.md`.

## Seed data

`packages/db/src/seed/companies.ts`: 40 companies with **unverified**
board tokens, guessed from URL-slug conventions. `pnpm --filter
@jobswitch/db seed:verify` probes them; a wrong token 404s, fails the run,
and degrades the source after three attempts (loud failure, not silent).

## Tests

| Suite | File | Proves |
|---|---|---|
| vitest | `packages/ingest/test/normalize.test.ts` (27) | Title/location/HTML/fingerprint utilities |
| vitest | `packages/ingest/test/{greenhouse,lever,ashby}.test.ts` (27+27+28) | Each adapter's detect/fetch/normalize against its synthetic fixture |
| vitest | `packages/ingest/test/run.test.ts` (23) | Full pipeline against real Postgres: upsert, versioning, grouping, absence handling |
| vitest | `packages/db/test/queue.test.ts` (16) | Claim/complete/fail/dead-letter/dedup/visibility-timeout semantics |
