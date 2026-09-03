# JobSwitch AI — Architecture Decision Record

## Provenance

The README states this codebase implements "the 20 decisions" of an
Architecture Decision Record. That document does not exist in this
repository or anywhere accessible to this session (confirmed via full git
history — see `docs/CURRENT_STATE.md`). What follows is a reconstruction of
the decisions that **are** evidenced by shipped code — comments cite
specific decision numbers (`D-01`, `D-03`, etc.) and section numbers (`§6`,
`§7`, `§13`, `§17`, `§29`) directly, and those numbers are preserved
verbatim below because the comments in the code already reference them; renumbering them here would make the code comments point at the wrong thing.

**Decision numbers with no evidence anywhere in the code are not
reconstructed.** Of the "20 decisions" the README claims, this audit found
direct evidence for nine (D-01, D-03, D-04, D-05, D-09, D-13, D-14, D-17,
D-20). The other eleven numbers (D-02, D-06 through D-08, D-10 through
D-12, D-15, D-16, D-18, D-19) are not filled in with invented content — they
are simply unknown. If a future document needs those numbers, they should
be treated as gaps, not assumed to be trivial or already covered.

New decisions below continue the numbering from D-21, decided in this pass
rather than recovered.

---

## Recovered decisions (already implemented)

### D-01 — Company-centric, shared ingestion

One fetch per company serves every candidate. Cost scales with the number
of companies in the index, not `companies × candidates`. This is the reason
Layer 1 (the job index) has no tenant column at all — it is genuinely
shared data, not per-user data that happens to overlap. Adding a new ATS is
one adapter file implementing `AtsAdapter` plus one line in `registry.ts`'s
`ADAPTERS` array — the ingestion pipeline (`packages/ingest/src/run.ts`)
never changes per platform.

**Status:** implemented, Phase 2–3. Three adapters exist (Greenhouse,
Lever, Ashby); three more are named V1 scope (SmartRecruiters, Workable,
Workday).

### D-03 / D-04 — Job identity is strict; grouping is advisory and reversible

A posting's identity is `(career_source_id, source_job_id)` and nothing
else — never a fuzzy match, never a merge. Two ATS platforms listing what a
human would call "the same job" produce two separate `job_posting` rows.
Similarity-based grouping (`job_group` / `job_group_link`) only ever *links*
rows for presentation and notification-suppression purposes; it can be
undone with nothing lost, because no row's own data ever depended on the
link. The thresholds are deliberately conservative (0.75 same-source
repost, 0.80 cross-source) because a missed link is a visible, shrug-worthy
duplicate card, while a wrong link silently hides a posting from a
candidate who needed to see it — the failure modes are not symmetric, and
the design is biased toward the recoverable one.

**Status:** implemented, Phase 2, in `packages/ingest/src/grouping.ts`.

### D-05 — The absence guard

A posting closes only after two consecutive successful runs fail to see it
again. An empty result set from a source that currently has open postings
never triggers closure at all — it's recorded as a suppressed run instead.
This exists because a single bad response (a board mid-migration, a CDN
serving a stub, a silent API contract change) must not be able to look
identical to "this company stopped hiring" and silently empty a real
company's listings overnight.

**Status:** implemented, Phase 2, in `packages/ingest/src/run.ts`
(`closeAbsent`).

### D-09 — Explanations cache against a specific job version

`job_posting_version` is append-only, one row per meaningful content
change (keyed by a content fingerprint insensitive to whitespace/formatting
churn). A future match explanation is meant to be cached against a specific
version id, not against the posting as a mutable whole — so a genuine
content change correctly invalidates a cached explanation, while a
whitespace-only re-scrape does not trigger a wasted re-generation. This is
the schema decision that makes Phase 5's cost model tractable: an
explanation is only regenerated when the thing it explains actually
changed.

**Status:** the versioning half is implemented (Phase 2). The
explanation-caching half is not — there is no `explanation` table yet
(Phase 5).

### D-13 — Postgres-backed queue, not Redis; per-account iteration for batch matching

At the traffic this product actually has (hundreds of ingestion jobs/day,
well under Postgres's `FOR UPDATE SKIP LOCKED` ceiling), a broker is a cost
and an operational surface with no corresponding benefit. The same section
also covers how a future batch matcher (`app_matcher`, which holds
`BYPASSRLS`) is meant to operate: **iterating accounts explicitly, one
tenant context at a time**, rather than issuing cross-tenant queries — so
that bypassing RLS for legitimate batch-processing reasons never becomes an
accidental cross-tenant read.

**Status:** the queue is implemented (Phase 2). The per-account matcher
iteration pattern is specified but not yet built (Phase 5) — `app_matcher`
currently has no grant on any Layer 2 table at all.

### D-14 — Four database roles; RLS via a session-local context function

`app_web`, `app_ingest`, `app_matcher`, and the migration-owner role, each
with different grants. `app_current_account_id()` reads
`current_setting('app.current_account_id', true)`, returning `NULL` (not an
error) when unset — the safety property is that an unscoped query returns
zero rows rather than every tenant's rows. `withAccount()` sets this via
`SET LOCAL` inside a transaction specifically because pooled connections
are reused across requests, and a plain `SET` would leak one candidate's
tenant context to whoever the connection serves next.

**Status:** implemented, Phase 1, extended to every Layer 2 table since.
Proven by `packages/db/test/rls.test.ts` and `packages/db/test/profile.test.ts`.

### D-17 — Tenant scoping is always on `account_id`, never `user_id`

Every Layer 2–4 table references `account`, not `app_user`, so that
organizations (many users, one tenant) can be introduced later without
reshaping a single table. At present this is unexercised — every account
has exactly one member — but the schema already pays for it.

**Status:** implemented consistently, Phases 1–4.

### D-20 — Unverified integrations must say so, loudly, everywhere

Every ATS adapter's field mapping is written from documentation, not
observation (this build environment has no outbound network access). Each
adapter fails loudly (`AdapterShapeError`) on an unexpected shape rather
than silently returning nothing, specifically so a documentation/reality
mismatch surfaces as a failed, recorded run — not as an index that quietly
stops growing. A `capture` CLI exists to replace synthetic fixtures with
real captured payloads once a networked environment is available. The same
honesty standard applies to the 40 seeded company board tokens (guessed
from URL-slug conventions, `seed:verify` exists to check them) and, per
this document's own provenance section, to the ADR and PRD themselves.

**Status:** implemented as a pattern across all three adapters, Phase 2–3.

---

## §6 / §7 / §17 / §29 / §30 — cross-referenced from `docs/PRD.md`

These section numbers are cited directly in shipped code comments
(`registry.ts`, `greenhouse.ts`, `0005_job_index.sql`,
Phase 2 commit message, `errors.ts`) and are recorded as PRD content in
`docs/PRD.md` §6, §7, §17, §29, §30 rather than duplicated here, since they
are product decisions, not technical ones.

---

## New decisions (this pass — locked going forward, not yet built unless noted)

### D-21 — Matching pipeline shape

```
Verified Candidate Profile
          ↓
Hard Constraints        (deterministic: location, work-mode, comp floor, must-have skills)
          ↓
Cheap Job Filtering      (SQL, no embeddings: eliminate the obviously-wrong majority first)
          ↓
Embedding Retrieval      (pgvector similarity search over the survivors only)
          ↓
Multi-dimensional Ranking (combine embedding similarity with structured signals)
          ↓
LLM Explanation           (only for postings that made the final ranked set)
          ↓
Persisted Match
```

The ordering is deliberate and cost-driven: hard constraints and cheap SQL
filtering happen **before** any embedding or LLM call, so the expensive
steps only ever run against a small, pre-qualified candidate set — not
every open posting in the index. This directly continues D-01's cost
philosophy (shared, amortized ingestion cost) into the matching stage
(narrowed, amortized inference cost).

**Status:** design only. Not built. Depends on D-22 (below) being resolved
first — see `docs/GAP_ANALYSIS.md`'s closing question.

### D-22 — AI fact safety (candidate-fact provenance)

Every field derived from or shown about a candidate is tagged as exactly
one of `verified_fact`, `preference`, `ai_inference`, or `generated_text`
(defined in `docs/PRD.md` §5). A match explanation must be able to state
which kind of fact it used, and an `ai_inference` or `generated_text` value
must never be presented to an ATS, an employer, or anywhere outside the
candidate's own view as if it were a `verified_fact`. This is a hard
constraint on Phase 5's design, not a suggestion: an explanation that says
"4 years of Python" without being able to say *whether that came from the
resume or was guessed* is not trustworthy, and this product's whole premise
is matching that explains itself.

**Status:** decided, not implemented. `candidate_profile`,
`profile_skill`, and `profile_experience` currently have no provenance
column at all (see `docs/GAP_ANALYSIS.md`). This is the migration that
should land before Phase 5 matching code, not after.

### D-23 — Browser extension boundary (V2, design-level only)

A browser extension is in scope (§V2, `docs/PRD.md`) for assisted autofill
on ATS application pages the API cannot reach server-side (many ATS
application forms require a real browser session and are not designed to
be filled programmatically from a backend). The boundary, decided now so
it isn't improvised later:

- The extension is a **thin, revocable client**. It never stores
  long-lived credentials of its own — it authenticates against the
  existing session model (D-14/`user_session`), scoped and revocable the
  same way any other session is.
- The extension receives a **prepared application package** (an L3
  concept, Phase 7) — data the web app has already assembled and the
  candidate has already reviewed — not raw profile data it queries and
  assembles itself. This keeps the fact-safety boundary (D-22) enforced
  server-side, not duplicated in extension code.
- The extension fills forms; it does not decide what to submit or when.
  Submission is a candidate action, consistent with the PRD's non-goal
  ("not an auto-apply bot").

**Status:** boundary decided. No implementation, no manifest, no build
target exists yet. This is deliberately minimal — enough to not build the
API or the L3 schema in a way that would make an extension awkward later,
not a full extension design.

### D-24 — Cost constraints (consolidated)

Restating what several earlier decisions already implied, as one explicit
constraint set for Phase 5 planning:

- Ingestion cost scales with companies, not candidates (D-01).
- No message broker; Postgres does the queue's job at this traffic level
  (D-13).
- `docs/DEPLOYMENT.md` — written before this audit, independently —
  already budgets "the embedding model" onto the **same single VPS** as the
  API and workers, alongside managed Postgres as the one paid-for
  component. Read together with D-21's pipeline ordering: **no new managed
  service should be required to ship Phase 5.** An embedding model choice
  that requires its own hosted service (rather than running in-process or
  as a local model on the existing VPS, or being a metered API call kept
  small by D-21's pre-filtering) breaks this constraint and should be
  flagged, not assumed acceptable.

**Status:** constraint recorded; not yet tested against a real embedding
model choice, since that choice hasn't been made.

### D-25 — Deployment strategy (formalizing an existing document)

`docs/DEPLOYMENT.md` already specifies the target: static frontend on a
CDN (arrives Phase 6, per its own note), one small VPS running `web` +
`worker` + `scheduler` (all three already exist as of Phase 2) plus, per
that document, the Phase 5 embedding model, and managed Postgres with
pgvector as the one component worth paying a managed-service premium for.
Nothing is deployed anywhere today (confirmed in both that document and the
README). No conflict was found between that document and anything decided
in this pass — it's referenced here rather than duplicated, and formally
adopted as locked rather than merely aspirational.

**Status:** documented (pre-existing), not yet executed.
