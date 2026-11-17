# Matching pipeline (`services/backend`)

A new Go service computing per-account job matches. Phase 5.2 shipped the
**structured-only** half of the pipeline — hard constraints, SQL
prefiltering, and a pure-Go ranking function. Phase 5.3 added retrieval
(`services/ai`'s real embeddings, plus the hybrid retrieval wired into this
service below), the `embed.job_version`/`embed.profile` enqueue points, and
now Stage 4: `explain.match`, calling `services/ai`'s already-built plain
sequential explain chain for the top matches of each run. LangGraph's
Graph B (self-critique, provenance-gate retry loop) upgrading that same
call is still Phase 5.4, as planned — this wiring is the synchronous
baseline the plan itself says should exist first.

## Why Go, why a separate module

`go.mod` at `services/backend/go.mod` — not part of the pnpm workspace.
Decision, not default: the candidate wanted Go and Python represented in
the stack (see `docs/PRD.md`'s framing), and the matching/ranking hot path
is the natural fit for it — concurrent, CPU-bound scoring over a
prefiltered candidate set, no dependency on TS-specific tooling.
Strangler pattern: the working TS ingestion layer (`specs/ingestion.md`)
was deliberately **not** rewritten.

## Pipeline shape

```
Hard constraints (SQL, cheap)  →  Hybrid retrieval (pgvector + tsvector, RRF)  →  Structured ranking (pure Go)  →  Persisted job_match  →  LLM explanation (top 20/run, async)
```

### Stage 1 — hard-constraint prefilter (`internal/repo.PrefilterCandidates`)

One CTE against `job_posting`/`job_posting_version`/`job_posting_location`:

- `closed_at IS NULL AND last_seen_at > now() - interval '30 days'`
- **Location/work-mode**: skipped entirely when the candidate gave neither
  a desired location nor a specific (non-`"any"`) work mode. Otherwise a
  posting must match a desired city or be remote while the candidate
  accepts remote/any. **Conservative by design, and named as a revisitable
  product call in the code comment**: a candidate who names cities without
  opting into remote is assumed to want those cities specifically, not
  "those cities, or remote as a bonus."
- **Comp floor**: `salary_max IS NULL OR salary_max >= floor` — NULL never
  fails. Most postings have no structured salary (only the Ashby adapter
  emits one), so a NULL floor also means no constraint at all.
- **Keyword floor**: `desired_titles` + `profile_skill` joined into one
  `websearch_to_tsquery` string (`"term1 OR term2 OR ..."`), matched
  against `job_posting_version.search_tsv` (a generated/stored column
  added in migration 0010, already populated for every posting regardless
  of embedding status). Skipped when the candidate has given nothing to
  search for.
- **Dedup**: excludes any posting that is a `job_group_link` member but
  not its group's `representative_posting_id` — the same "one card per
  group" rule everywhere else in the product.
- **Excludes**: anything already `dismissed_at IS NOT NULL` in `job_match`
  for this account, and anything already in `job_application` for this
  account.
- `LIMIT 2000` — a safety cap on Stage 3's in-process cost, not an
  expected steady-state truncation (the plan's own estimate is
  200–2000 survivors from a 25k-posting index).

### Stage 2 — hybrid retrieval (`internal/repo.HybridRetrieve`)

Scores every Stage 1 survivor for semantic and lexical relevance against
one account's query embeddings (`profile_embedding`, migration 0010) and
keyword floor (the same `buildKeywordFloor` string Stage 1 already
searched with).

**Vector** is Reciprocal Rank Fusion, named explicitly per D-32 rather than
hand-blending cosine distances: up to two independent rankings — by cosine
distance (`<=>`) to the resume embedding, and to the desired-role
embedding — are combined as `Σ 1/(60+rank_i)`, summed over whichever of
the two the account actually has a query vector for. The fused score is
normalized against the maximum achievable with however many of those two
rankers actually ran, so an account with only one kind of query embedding
is judged on the same `[0, 1]` scale as one with both, rather than being
structurally capped below it.

**Keyword** stays a separate, independently-weighted signal rather than
being folded into that same RRF sum — this is the actual reason D-32 names
RRF at all: `ts_rank_cd` and cosine distance live on incomparable scales,
and forcing them into one blended number would mean silently deciding how
many keyword-rank positions equal one embedding-rank position. Postgres's
own normalization option `32` (`rank/(rank+1)`) bounds `ts_rank_cd` to
`[0, 1)` without that guess; combining it with `Vector` at genuinely
different scales is `rank.Score`'s job (a renormalized weighted average —
this codebase's already-established way to combine signals of different
kinds), not `HybridRetrieve`'s.

**Unknown data scores neutral (`0.5`), never `0`** — matching every other
"not yet known" signal in this pipeline (`LocationScore`,
`SeniorityScore`'s either-side-unknown case): a posting whose version has
no embedding yet (`embed.job_version` hasn't reached it), or an account
with no query embedding at all (a résumé/profile whose `embed.profile`
job hasn't run yet, or an account that hasn't triggered one at all - see
the `embed.profile` section below), must not be penalized for a fact
nobody has computed. This is also what makes `rank.DefaultWeights()` safe
to use unconditionally now (see below) — a `0.5` contributes its neutral
share instead of dragging the total down by Vector/Keyword's combined 40%
share the way a hardcoded `0` would.

### Stage 3 — ranking (`internal/rank` + `internal/match`)

`internal/rank.Score(signals, weights)` is pure, DB-free, and generic —
weighted average, renormalized over only the signals actually present:

```go
type Signals struct {
    Vector, Keyword, SkillOverlap, Seniority, Location, Freshness float64
    Comp *float64  // nil = unknown, excluded from the average entirely —
                    // NEVER defaulted to 0, which would penalize every
                    // posting that simply didn't disclose a range
}
```

**`internal/match/match.go` now uses `rank.DefaultWeights()`** — Phase
5.2's `structuredOnlyWeights` (which zeroed `Weights.Vector`/`.Keyword`
outright) has been removed now that Stage 2 gives those two dimensions a
real value on every run, never a hardcoded `0`. `DefaultWeights()`
allocates 40% of total weight to Vector+Keyword; that would have silently
under-scored every candidate by that share back when the values were
unconditionally `0` (`Score`'s renormalization only excludes a dimension
when its *weight* is zero, not when its *value* happens to be zero) — the
exact failure mode `rank/rank_test.go`'s
`TestScore/before_Phase_5.3,_Vector_and_Keyword_are_always_0` still exists
to name explicitly, as a regression guard on `rank.Score`'s own pure
arithmetic, not on `match.go`'s current behavior. It stays safe today
specifically because Stage 2's "unknown" fallback is the neutral `0.5`
described above, not `0`.

#### The four structured signals, and their honest scope

| Signal | Function | What it actually measures |
|---|---|---|
| `SkillOverlap` | `SkillOverlapScore` | Fraction of the candidate's listed skills found as a case-insensitive substring of the posting's description text. No skills listed → `0.5` (neutral — an empty profile isn't a mismatch). Real semantic overlap (synonyms, related tech) is Phase 5.3's embedding territory; this is deliberately literal. |
| `Seniority` | `SeniorityScore` + `seniority.go` | Compares the candidate's *implied* level (from `current_title`/`desired_titles`, run through the same word-pattern list `packages/ingest/src/normalize.ts` uses to detect a posting's own `job_posting.seniority` at ingestion time — so both sides come from one vocabulary) against the posting's already-detected level. Exact match `1.0`, adjacent (rank distance ≤1 on a 0–5 scale: intern/entry/junior → senior/lead/staff/manager → principal) `0.6`, far apart `0.2`, either side unknown `0.5`. |
| `Location` | `LocationScore` | Deliberately coarse: every candidate posting already passed Stage 1's hard location filter, so a survivor's constraint (if any) is *known* satisfied. `1.0` if the candidate had a location preference (already verified true by the SQL), `0.5` if they had none at all (this dimension carries no information for them — not "perfectly satisfied," which would unfairly inflate their score relative to someone whose real preference was matched). A genuinely differentiated signal (exact city vs. remote-as-fallback) is real future work. |
| `Comp` | `CompScore` | `nil` whenever either the candidate's floor or the posting's max is unknown. Otherwise rewards headroom above the floor, linearly, capped at `1.0` once the posting's max reaches 2× the floor. Not a precision instrument — no currency conversion, no percentile modeling. |
| `Freshness` | `FreshnessScore` | `exp(-daysSinceFirstSeen / 14)` — the plan's own formula verbatim. |

### Persisting: `internal/repo.UpsertMatches`

`INSERT ... ON CONFLICT (account_id, job_posting_id) DO UPDATE`, pipelined
via `pgx.Batch`. **Never touches `dismissed_at`** — a dismissed posting is
already excluded by Stage 1's own `NOT EXISTS` clause, so this function is
never even called for one. That's a property of the query shape, not a
special case in the upsert code.

`matcher_version` (currently `2`, `match.MatcherVersion`) is bumped
whenever the ranking formula changes materially — every prior `job_match`
row becomes recognizably stale without a data migration. Bumped from `1`
to `2` when Stage 2 hybrid retrieval went in: Vector/Keyword flipping from
hardcoded `0` to real values under `rank.DefaultWeights()`'s nonzero
weight for them changes the score for every existing row, not just new
ones.

## Orchestration: `internal/match.RunForAccount`

```go
func RunForAccount(ctx, matcherPool, accountID string) (RunResult, error)
```

Loads facts → prefilters → scores each candidate → upserts. Read side
exclusively via the **Matcher pool** (`app_matcher`, `BYPASSRLS`) — never
the Web pool, and every query in `internal/repo` filters by `account_id`
explicitly, since RLS provides no backstop for a bypassing role. This
discipline is the entire tenant-isolation guarantee for this code path,
and it's proven, not assumed — see the cross-tenant test below.

**Now wired to a real schedule.** `internal/worker/schedule.go`'s
`RunScheduledTasks` calls `repo.ActiveJobSearchAccountIDs` then
`RunForAccount` per account, per ADR D-13's per-account BYPASSRLS
iteration pattern, every `MATCH_TICK_MS` (default 5 minutes) - see
`specs/ephemeral-retention.md` for the scheduler itself. `RunForAccount`
also enqueues Stage 4 (`explain.match`, top 20 by score) after
`UpsertMatches` commits - see that section below.

## Four real bugs, found by testing against real Postgres

### 1. `app_matcher` had no grant on `job_application`

Migration 0008 (Phase 5.1, before `app_matcher` was a table consumer at
all) granted `job_application` to `app_web` only. Stage 1's "exclude
already-tracked postings" `NOT EXISTS` needs `SELECT` for whatever role
runs the query. First integration test run: `permission denied for table
job_application`. Fixed with `packages/db/migrations/
0012_matcher_reads_applications.sql` — `SELECT` only, deliberately: the
matcher reads applications to avoid duplicating a candidate's own tracked
pipeline, never to create/edit/delete one.

### 2. `BYPASSRLS` does not propagate through `GRANT` membership

The bigger one. `internal/db/pool.go`'s own doc comment already warned
that mixing web+matcher privilege into one pooled role via `SET ROLE`
would risk exactly this misconfiguration — and then the test suite's
*first* attempt at provisioning an `app_matcher_test` role hit it anyway:

```sql
CREATE ROLE app_matcher_test LOGIN PASSWORD '...';
GRANT app_matcher TO app_matcher_test;
-- rolbypassrls for app_matcher_test is still FALSE here.
```

Postgres deliberately excludes role *attributes* (`LOGIN`, `SUPERUSER`,
`BYPASSRLS`, ...) from what `INHERIT` role membership grants — unlike
table privileges, which do inherit. Confirmed empirically:

```sql
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('app_matcher','app_matcher_test');
--      rolname      | rolbypassrls
-- app_matcher        | t
-- app_matcher_test   | f
```

Every write through the "matcher" role failed with "new row violates
row-level security policy" until the test setup added the role's own
explicit grant:

```sql
ALTER ROLE app_matcher_test BYPASSRLS;
```

This would have broken **production** identically — `docs/DEPLOYMENT.md`'s
`app_matcher_prod` provisioning step is now corrected with the same
`ALTER ROLE`, plus a verification query (`rolbypassrls` should read `TRUE`
for this one role, the inverse of every other role's check). `.env.example`
gained `DATABASE_URL_MATCHER`, the fourth role URL predicted back in the
original `docs/CURRENT_STATE.md` audit.

### 3. `go test ./...` raced its own shared Postgres database

Go runs each package's tests as a separate OS process, in parallel by
default (`-p`, defaulting to `GOMAXPROCS`) — but `internal/session`,
`internal/queue`, `internal/match`, and `internal/worker` all do broad,
unscoped cleanup (`DELETE FROM <table>`, not scoped to one test's own rows)
against the *same* real Postgres database, and running two of those
packages' tests concurrently means one's cleanup can delete rows another
is mid-assertion on. Surfaced as real, intermittently-failing tests
(`TestResolveValidSession`, `TestHandleEmbedProfileEndToEnd`) under a plain
`go test ./...`; confirmed as a parallelism issue, not a logic bug, by
re-running with `-p 1` (forces sequential package execution) and getting a
clean pass. Fixed structurally rather than left as "remember to pass
`-p 1`": `internal/testutil.WithSerializedDBAccess` takes a blocking
`pg_advisory_lock` for the duration of a package's test run, and each of
those four packages now has a one-line `TestMain` calling it. Exact same
problem as `packages/db/vitest.config.ts`'s `fileParallelism: false` on the
TS side ("Serial is correct here, not a workaround"), and the same
advisory-lock idiom `apps/scheduler` and `internal/worker/schedule.go`
already use for their own singleton guards — a blocking lock rather than
`pg_try_advisory_lock`, since a test package should wait its turn rather
than skip its run.

### 4. `app_matcher` had no grant for the dormancy sweep, twice over

Once `internal/worker/schedule.go`'s scheduled sweep existed to actually
call `FindDormantActiveSessions`/`SweepDormantSession` against a real
`app_matcher` role, it failed immediately: `job_search_session` had only
ever been granted to `app_web` (migration 0009, before `app_matcher` read
it at all) — same shape of gap as bug 1 above. Fixed with `0015_matcher_
dormancy_sweep_grants.sql` (`SELECT, UPDATE` on `job_search_session`;
`DELETE` on whichever purge-target tables `app_matcher` didn't already
hold it on). That migration alone wasn't enough: the sweep still failed
purging `resume_source`/`resume_artifact` with "permission denied," because
Postgres requires `SELECT` on any column a `DELETE`'s `WHERE` clause reads
(here, `account_id`) *in addition to* `DELETE` itself —
`resume_upload`/`job_application`/`match_explanation` didn't hit this
because each already had `SELECT` from an earlier migration (0013, 0012,
0011), but `resume_source`/`resume_artifact` never had any `app_matcher`
grant before 0015. Closed by `0016_matcher_purge_needs_select_too.sql`.
Both caught by `schedule_test.go`'s integration test actually running the
sweep end to end against real Postgres, not by reading the grant list.

## Tests

| Suite | File | Proves |
|---|---|---|
| Go | `internal/rank/rank_test.go` | Weighted scoring, nil-Comp exclusion, the "structured-only weights must not silently sink the score" property |
| Go | `internal/match/seniority_test.go` | Word-pattern detection matches TS's priority order; adjacency scoring |
| Go | `internal/match/signals_test.go` | Each signal function's edge cases (no skills, unknown comp, future timestamps, no location preference) |
| Go | `internal/match/match_integration_test.go` | Full pipeline against real Postgres: correct match on location+skills, closed/stale postings excluded, **cross-tenant isolation** (two accounts, two profiles, assert zero cross-account `job_match` writes and each account's own match is exactly right), a profile-less account doesn't crash, (`TestRunForAccountUsesHybridRetrieval`) **Stage 2 itself**: a real seeded `profile_embedding` + two real `job_posting_version.embedding` values, no fakes, asserting RRF ranks the cosine-identical posting above the orthogonal one and neither falls back to the neutral `0.5` default, and (`TestRunForAccountEnqueuesExplainMatchCappedAtTop20`) **Stage 4's cap**: 25 matches enqueue exactly 20 `explain.match` jobs |
| Go | `internal/worker/explain_test.go` | **Full loop, real LLM call**: real posting + real profile, real `services/ai` call, real Groq response, valid evidence JSON, and a second call against the same pair hits the D-09 cache instead of calling the LLM again; plus a no-live-service cache-hit test and a payload-validation test |
| Go | `internal/queue/queue_test.go` | Claim/complete/fail/backoff/dedup semantics; concurrent-claim race safety; **cross-language interop** against a literal copy of `queue.ts`'s own SQL |
| Go | `internal/clients/ai_test.go` | Request shape, header, error mapping (fake HTTP server) + a real call against the live `services/ai` process |
| Go | `internal/worker/embed_test.go` | **Full loop, no fakes**: real posting → real embedding call → real vector read back from Postgres |
| Go | `internal/worker/embed_profile_test.go` | Same, both `profile_embedding` kinds, plus (no live service needed) nothing-to-embed is a no-op and an unchanged `source_hash` skips the AI call - both proven by pointing the client at an unreachable address and confirming no error and no wrong write |
| Go | `internal/worker/schedule_test.go` | `RunScheduledTasks`'s two halves against real Postgres - see `specs/ephemeral-retention.md` |
| Go | `internal/session/*` | See `specs/session-auth.md` |

Every package above shares one real Postgres database across `go test
./...`'s parallel package processes, so `internal/session`, `internal/
queue`, `internal/match`, and `internal/worker` each carry a `TestMain`
that serializes via `internal/testutil.WithSerializedDBAccess` (bug 3
above) - a plain `go test ./...` is safe to run as-is, no `-p 1` needed.

## The queue and `cmd/worker` (Phase 5.3)

`internal/queue` is a Go port of `packages/db/src/repositories/queue.ts`,
reproduced **statement-for-statement** against the same `job_queue` table
apps/worker already claims from - see `specs/ingestion.md`. Same claim
SQL (`FOR UPDATE SKIP LOCKED`, `attempts` incremented at claim time), same
backoff formula (`min(base * 2^(attempts-1), max)` plus up to 30% jitter),
same dead-letter threshold. Two languages share one queue with zero
coordination beyond the SQL itself.

**Proven, not assumed**: `internal/queue/queue_test.go` includes a
concurrency test (10 goroutines racing for 20 jobs, each claimed exactly
once) and a genuine interop test —`TestClaimInteropWithTSStyleQuery` runs
Go's `Claim()` concurrently against a second query built from the
**literal SQL text** in `queue.ts`'s own `claim()` function, both racing
for the same rows. No job is ever claimed twice across the two query
styles. This is not the same as spawning a real Node process, but it
directly tests the property that actually matters: the two languages'
claim queries are safe to run against the same table at the same time.

`cmd/worker/main.go`: claim → dispatch by queue name → handler → complete
or fail, mirroring `apps/worker`'s own `Worker.execute` shape (unroutable
job → immediate dead-letter, not five wasted retries). Registers three
handlers, plus runs `RunScheduledTasks` (above) as a goroutine alongside
the claim loop:

```go
handlers := map[string]handlerFunc{
    worker.EmbedJobVersionQueue: worker.HandleEmbedJobVersion(matcherPool, aiClient),
    worker.EmbedProfileQueue:    worker.HandleEmbedProfile(matcherPool, aiClient),
    repo.ExplainMatchQueue:      worker.HandleExplainMatch(matcherPool, aiClient),
}
```

### `embed.job_version` — verified genuinely end to end

`internal/worker/embed.go`'s `HandleEmbedJobVersion`: reads a
`job_posting_version`'s title+description (Matcher pool - already granted
`SELECT` on Layer 1 since migration 0005, no new grant needed), calls
`services/ai`'s real `/v1/embed` (`internal/clients/ai.go`), writes the
vector back via the column-level grant migration 0010 gives `app_matcher`
(`UPDATE (embedding, embedding_model, embedded_at)` only).

`internal/worker/embed_test.go`'s `TestHandleEmbedJobVersionEndToEnd` is
the full-loop proof, no fakes anywhere: seeds a real `company` →
`career_source` → `job_posting` → `job_posting_version` chain, calls the
handler against the **real running Python service**, reads the embedding
back from Postgres and confirms `vector_dims(embedding) = 384` and
`embedding_model = 'BAAI/bge-small-en-v1.5'`. Skips itself (doesn't fail)
if `services/ai` isn't running locally.

`internal/clients/ai.go`'s own `TestEmbedAgainstRealAIService` is the same
kind of proof at the client layer alone - Go calling the real Python
process directly, confirming a real 384-dim vector comes back.

### `embed.profile` — the query-side embedding worker

`internal/worker/embed_profile.go`'s `HandleEmbedProfile` computes one of
an account's two `profile_embedding` rows (migration 0010's `kind IN
('resume', 'desired_role')`):

- **`resume`**: `repo.GetResumeText` reads `resume_upload.raw_text`
  (`app_matcher` granted `SELECT` by migration 0013, mirroring 0012's
  grant on `job_application` - the matcher reads it to embed, never
  writes, updates, or deletes it).
- **`desired_role`**: `repo.DesiredRoleText` builds one string from
  `current_title` + `desired_titles` + `profile_skill` - deliberately the
  *same* fields `PrefilterCandidates`'s `buildKeywordFloor` already treats
  as the candidate's role-intent signal, so the embedding and Stage 1's
  keyword floor agree on what "the role this candidate wants" means
  rather than each inventing its own definition.

Either kind can genuinely have nothing to embed yet (no résumé uploaded;
no title, desired titles, or skills given) - the handler returns `nil`
without writing anything, the same "not yet known, not an error" pattern
as `LoadCandidateFacts`'s profile-less account.

**Skip-when-unchanged, not just idempotent-when-rerun**: before calling
`services/ai`, the handler hashes the text (`sha256`) and compares it
against `profile_embedding.source_hash` - a column that existed since
migration 0010 specifically for this (its own doc comment already named
the plan). An unchanged hash skips the AI call entirely rather than
re-embedding identical text. This is *why* the TS producers below can
afford to enqueue unconditionally on every write rather than each
deciding which specific field change is "worth" a re-embed - that
decision happens exactly once, here.

**Producers** (`packages/core/src/profile.ts`'s `EMBED_PROFILE_QUEUE` /
`EmbedProfilePayload`, the same cross-language-by-string-matching contract
`EMBED_JOB_VERSION_QUEUE` already uses):

| Kind | Enqueued from | Dedup key |
|---|---|---|
| `resume` | `jobSearchRepo.startJobSearch`, every call (including "already active, just updating the résumé") | `embed.profile:<accountId>:resume` |
| `desired_role` | `profileRepo.upsertProfile` and `profileRepo.replaceSkills`, every call | `embed.profile:<accountId>:desired_role` |

Both dedup keys collapse repeated rapid writes into one still-pending job
safely, because the payload carries no text of its own (just `accountId`
+ `kind`) - the handler always reads the *current* `resume_upload`/
`candidate_profile`/`profile_skill` state at claim time, so a job that
sat queued through three edits still embeds the latest one, not a stale
snapshot from whichever edit happened to enqueue it.

**Verified genuinely end to end, both kinds, no fakes**:
`internal/worker/embed_profile_test.go`'s `TestHandleEmbedProfileEndToEnd`
seeds a real `resume_upload` and a real `candidate_profile`, calls the
real running Python service for both kinds, and confirms both rows read
back with `vector_dims = 384`, the real model name, and a non-empty
`source_hash`. Skips itself if `services/ai` isn't running locally, same
as the job-version test. Two more tests prove the no-fakes-needed edge
cases directly against Postgres: `TestHandleEmbedProfileNoContentIsANoOp`
(nothing to embed writes nothing, and never even attempts an HTTP call -
proven by pointing the client at an unreachable address) and
`TestHandleEmbedProfileSkipsTheAICallWhenUnchanged` (a matching
`source_hash` already on file means the same unreachable client never
gets called and the row is left untouched).

### D-31's purge, extended: `profile_embedding`'s `resume` kind

`jobSearchRepo.stopJobSearch` (`packages/db/src/repositories/jobSearch.ts`)
now also runs `DELETE FROM profile_embedding WHERE account_id = $1 AND
kind = 'resume'` - closing the gap `0010_embeddings.sql`'s own comment
named ("profile_embedding is ... a purge target under D-31's retention
mechanic once the resume kind is re-embedded per search cycle"). This is
**not** a `PURGE_TABLES` array entry like everything else that table
purges: every other entry is a blanket `DELETE FROM table WHERE
account_id = $1`, but `profile_embedding`'s `desired_role` kind is derived
from `candidate_profile`/`profile_skill` - retained biography, not search
activity - so it survives the purge exactly like those tables do. Needed
its own new grant too: migration 0014 gives `app_web` `DELETE` on
`profile_embedding` (the RLS policy already existed from 0010; RLS and
`GRANT` are independent checks, and a policy with no table privilege
still fails closed). See `specs/ephemeral-retention.md`.

### `explain.match` — Stage 4, the LLM explanation queue

`internal/match.RunForAccount` sorts one run's `job_match` writes by score
descending and enqueues `explain.match` (`internal/repo.ExplainMatchQueue`)
for the top `explainTopN` (20) only — an LLM call per candidate/posting
pair is real, uncapped cost otherwise, and a posting ranked 200th in one
account's feed is unlikely to be shown prominently enough to be worth
explaining. Dedup key is `explain.match:<accountId>:<jobPostingVersionId>`,
the same pair `match_explanation`'s primary key uses (D-09) — a version
already queued or already explained is a safe no-op.

**Why the queue name lives in `internal/repo`, not `internal/worker` like
every other queue name here**: this is the first queue with a Go producer
*and* a Go consumer. `internal/worker` already imports `internal/match`
(`schedule.go` calls `RunForAccount`), so `match` importing `worker` back
for the constant would be a straight import cycle. `repo` is the shared
dependency both already have, so `ExplainMatchQueue` is defined there.

`internal/worker/explain.go`'s `HandleExplainMatch`:

1. **Cache check first** (`repo.HasMatchExplanation`) — D-09 again: an
   existing row for this `(account_id, job_posting_version_id)` pair means
   the version hasn't changed since it was explained, so the handler
   returns `nil` without calling `services/ai` at all.
2. **`repo.GetJobExplanationContext`** joins `job_posting_version ->
   job_posting -> company` for the `{title, company, description}` the
   LLM needs — no new grant required, `company` already carries the same
   Layer 1 `SELECT` grant `job_posting`/`job_posting_version` have had
   since migration 0005.
3. **`explanationFacts`** turns `repo.CandidateFacts` into the
   provenance-tagged list `/v1/match/explain` requires (D-22 made
   structural, same principle as Graph B's eventual `provenance_gate`):
   `current_title` and `years_experience` carry their own real
   `_provenance` columns (`candidate_profile`), each skill carries its own
   real `profile_skill.provenance` (`repo.SkillFact`, new alongside the
   plain `Skills []string` Stage 3 already used, so that existing code
   didn't need to change shape), and `desired_titles` is hardcoded
   `'preference'` — not a guess, but migration 0009's own documented
   invariant for that column (`COMMENT ON COLUMN ... 'Always preference'`).
4. **`ai.Explain`** (`internal/clients/ai.go`) calls the real
   `POST /v1/match/explain`.
5. **`repo.WriteMatchExplanation`** upserts the result — `ON CONFLICT ...
   DO UPDATE`, not `DO NOTHING`, so a queue retry after a partial failure
   is still correct, not just harmless.

No new migration needed: `app_matcher` already held every grant this
touches (`candidate_profile`/`profile_skill` SELECT since 0009,
`match_explanation` SELECT/INSERT/UPDATE since 0011, `company` SELECT
since 0005) - the first Stage 4 integration test to actually run this
found zero missing grants, unlike every earlier stage in this file.

**Verified genuinely end to end, real LLM call included**:
`internal/worker/explain_test.go`'s `TestHandleExplainMatchEndToEnd` seeds
a real posting and a real candidate profile/skill, calls the real running
`services/ai` process (which itself calls a real Groq key), and confirms a
non-empty summary, a real model name, valid JSON evidence, and that a
second call against the same pair hits the D-09 cache instead of calling
the LLM again. `TestHandleExplainMatchSkipsWhenAlreadyCached` proves the
cache path alone, no live service needed, the same "point the client at an
unreachable address" trick `embed_profile_test.go` already uses.
`internal/match/match_integration_test.go`'s
`TestRunForAccountEnqueuesExplainMatchCappedAtTop20` proves the cap itself:
25 matching postings for one account enqueue exactly 20 `explain.match`
jobs, never 25.

## Known gaps / what's explicitly deferred

- **`packages/ingest/src/run.ts` now enqueues `embed.job_version`** inside
  the same transaction as `jobsRepo.upsertPosting`, whenever a version is
  newly created or its content changed (`upserted.versionCreated`) - see
  `run.ts`'s `EMBED_JOB_VERSION_QUEUE`/`EmbedJobVersionPayload` and
  `packages/ingest/test/run.test.ts`'s "embedding enqueue" suite. Dedup key
  is the version id itself, so a re-run within the same hour is a cheap
  no-op rather than a duplicate job. This closes the gap this section used
  to describe ("nothing enqueues onto `embed.job_version` yet").
- **`embed.profile` is now built** (`internal/worker/embed_profile.go`,
  registered in `cmd/worker`'s handler map alongside `embed.job_version`)
  - see the section above. `profile_embedding` now has a real writer for
  both kinds, so `HybridRetrieve`'s Vector signal is genuinely non-neutral
  once an account has gone through a résumé upload and/or a profile/skills
  write *and* `cmd/worker` has actually processed the resulting queue
  jobs. It still reads neutral `0.5` for an account that hasn't done
  either yet, or whose jobs haven't been claimed yet - correct fallback
  behavior, not a bug, just no longer the permanent state it was before
  this closed.
- **`RunForAccount` now wires Stage 2 for real** — `internal/repo.
  HybridRetrieve` (vector RRF + normalized `ts_rank_cd`) replaces the old
  hardcoded `Vector: 0, Keyword: 0`, and `match.go` uses
  `rank.DefaultWeights()` instead of the retired `structuredOnlyWeights`.
  Proven against real Postgres with real seeded embeddings and no fakes:
  `internal/match/match_integration_test.go`'s
  `TestRunForAccountUsesHybridRetrieval`.
- **Closed**: `cmd/worker`'s handler map now has three entries
  (`embed.job_version`, `embed.profile`, `explain.match`), and
  `internal/worker/schedule.go`'s `RunScheduledTasks` runs a periodic
  `ActiveJobSearchAccountIDs` + `RunForAccount` loop alongside the
  queue-claim loop, plus the D-31 dormancy sweep - see
  `specs/ephemeral-retention.md` and this file's "Four real bugs" section
  (bug 4).
- **Closed**: `/v1/match/explain` is now wired to something -
  `RunForAccount` enqueues `explain.match` for the top 20 matches of every
  run, `cmd/worker` claims and answers them for real. See the
  `explain.match` section above. Only the plain sequential chain
  `services/ai` already shipped in Phase 5.3 - LangGraph's Graph B
  (self-critique pass, bounded retry on an unsupported claim) replacing it
  is still Phase 5.4, unstarted.
- **`cmd/mcp` doesn't exist.** Planned (later phase): search/filter/track
  tools over the Go API, explicitly forbidden from sending email or
  submitting applications.
- **Not deployed anywhere.** `cmd/api` and `cmd/worker` both build and run
  locally; no container image, no k8s manifest yet.
- **`internal/repo.UpsertMatches` pipelines one `INSERT` per row via
  `pgx.Batch`.** Correct at Phase 5.2's hundreds-to-low-thousands scale;
  a single multi-row `VALUES` statement would cut round trips further,
  left as a documented option for when real batch-worker latency numbers
  justify it.
