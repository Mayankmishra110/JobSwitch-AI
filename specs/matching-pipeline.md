# Matching pipeline (`services/matcher`)

A new Go service computing per-account job matches. Phase 5.2 ships the
**structured-only** half of the pipeline — hard constraints, SQL
prefiltering, and a pure-Go ranking function — with no embeddings and no
LLM calls yet. Phase 5.3 adds retrieval (`services/ai`, not yet built);
Phase 5.4 adds LLM explanations.

## Why Go, why a separate module

`go.mod` at `services/matcher/go.mod` — not part of the pnpm workspace.
Decision, not default: the candidate wanted Go and Python represented in
the stack (see `docs/PRD.md`'s framing), and the matching/ranking hot path
is the natural fit for it — concurrent, CPU-bound scoring over a
prefiltered candidate set, no dependency on TS-specific tooling.
Strangler pattern: the working TS ingestion layer (`specs/ingestion.md`)
was deliberately **not** rewritten.

## Pipeline shape

```
Hard constraints (SQL, cheap)  →  [Phase 5.3: hybrid retrieval]  →  Structured ranking (pure Go)  →  Persisted job_match
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

### Stage 2 — retrieval (NOT YET BUILT)

Phase 5.3: vector search (resume embedding + desired-role embedding, both
against the prefiltered CTE) fused with the keyword rank via Reciprocal
Rank Fusion. Until then, `rank.Signals.Vector` and `.Keyword` are always
`0`.

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

**Phase 5.2 uses `structuredOnlyWeights`, not `rank.DefaultWeights()`** —
`internal/match/match.go`:

```go
var structuredOnlyWeights = rank.Weights{
    Skill: 0.45, Seniority: 0.25, Location: 0.15, Comp: 0.05, Freshness: 0.10,
}
```

`DefaultWeights()` allocates 40% of total weight to Vector+Keyword.
Passing it here — with every `Signals.Vector`/`.Keyword` hardcoded to
`0` — would silently under-score every single candidate by that 40%,
since `Score`'s renormalization only excludes a dimension when its
*weight* is zero, not when its *value* happens to be zero. This exact
failure mode is what `rank/rank_test.go`'s
`TestScore/before_Phase_5.3,_Vector_and_Keyword_are_always_0` exists to
name explicitly.

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

`matcher_version` (currently `1`, `match.MatcherVersion`) is bumped
whenever the ranking formula changes materially — every prior `job_match`
row becomes recognizably stale without a data migration.

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

**Not yet wired to anything that runs on a schedule.** `cmd/worker` (the
binary that would call `repo.ActiveJobSearchAccountIDs` then
`RunForAccount` per account, per ADR D-13's per-account BYPASSRLS
iteration pattern) does not exist yet. `RunForAccount` today is called
only from tests.

## Two real bugs, found by testing against real Postgres

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

## Tests

| Suite | File | Proves |
|---|---|---|
| Go | `internal/rank/rank_test.go` | Weighted scoring, nil-Comp exclusion, the "structured-only weights must not silently sink the score" property |
| Go | `internal/match/seniority_test.go` | Word-pattern detection matches TS's priority order; adjacency scoring |
| Go | `internal/match/signals_test.go` | Each signal function's edge cases (no skills, unknown comp, future timestamps, no location preference) |
| Go | `internal/match/match_integration_test.go` | Full pipeline against real Postgres: correct match on location+skills, closed/stale postings excluded, **cross-tenant isolation** (two accounts, two profiles, assert zero cross-account `job_match` writes and each account's own match is exactly right), a profile-less account doesn't crash |
| Go | `internal/session/*` | See `specs/session-auth.md` |

## Known gaps / what's explicitly deferred

- **`cmd/worker` doesn't exist.** `RunForAccount` has no scheduled caller.
- **No embeddings, no LLM.** `Vector`/`Keyword` are always `0`; no
  `match_explanation` rows are ever written yet.
- **`cmd/mcp` doesn't exist.** Planned (later phase): search/filter/track
  tools over the Go API, explicitly forbidden from sending email or
  submitting applications.
- **Not deployed anywhere.** `cmd/api` builds and runs locally
  (`/healthz`, `/readyz`, one smoke-test authenticated route); no
  container image, no k8s manifest yet.
- **`internal/repo.UpsertMatches` pipelines one `INSERT` per row via
  `pgx.Batch`.** Correct at Phase 5.2's hundreds-to-low-thousands scale;
  a single multi-row `VALUES` statement would cut round trips further,
  left as a documented option for when real batch-worker latency numbers
  justify it.
