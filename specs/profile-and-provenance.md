# Candidate profile and fact provenance

The first tenant-owned data in the system (Layer 2): a candidate's
headline, summary, skills, work history, and search preferences. Built
Phase 4 (flat schema, no provenance) and revised in Phase 5.1 (provenance
columns added, D-22).

## Schema

`packages/db/migrations/0007_personal_profile.sql` +
`0009_provenance_and_retention.sql`:

```
candidate_profile   — one row per account (account_id is the PK, not a
                       separate id: the 1:1 relationship is exact)
profile_skill        — many per account, case-insensitive unique
profile_experience    — many per account, work history entries
```

All three are RLS-protected (`account_id = app_current_account_id()`),
following the `0004_audit_log_rls.sql` template every tenant table since
has copied exactly. `candidate_profile` has **no DELETE policy** —
deliberately, rows are only ever upserted, never deleted by the app
(deletion happens only via `account` cascade). This is why résumé storage
was split into its own table rather than columns on `candidate_profile` —
see `specs/ephemeral-retention.md`.

## Fact provenance (ADR D-22 / D-22a)

Every fact in a profile is exactly one of five kinds:

```ts
type FactProvenance =
  | 'verified_fact'   // extracted from a document the candidate supplied
  | 'self_asserted'   // the candidate typed it about themselves (D-22a —
                       //    added after the original four; a hand-typed
                       //    headline is neither "extracted" nor "a
                       //    preference," it needed its own name)
  | 'preference'       // a search criterion, not a fact about the past
  | 'ai_inference'      // derived by a model, not stated
  | 'generated_text';   // model-written prose
```

`candidate_profile` carries a `*_provenance` column for its four ambiguous
fields (`headline`, `summary`, `current_title`, `years_experience`) — the
rest are provenance-by-construction and just documented as such
(`desired_titles` is always `preference`, `resume_text` — now on
`resume_upload`, see the retention spec — is always `verified_fact`).
`profile_skill` and `profile_experience` each carry their own `provenance`
column, plus `profile_skill` gets `evidence_ref` (free text, e.g.
`'resume:experience[0].bullets[2]'`) and `confidence` (required, via a
CHECK constraint, whenever `provenance = 'ai_inference'`).

**Why this exists**: a Phase 5 match explanation or a Phase 5.4 résumé
edit has to be able to say *which kind* of fact it used. "Matched on 4
years Python (verified from your resume)" and "matched on 4 years Python
(the model guessed)" are different claims, and this product's premise —
matching that explains itself — depends on being able to tell the
candidate which one it's making. `services/matcher`'s repository layer
(`specs/matching-pipeline.md`) reads these columns but doesn't yet *use*
provenance in scoring — that's Phase 5.4 territory, once explanations
exist to cite it.

`app_matcher` was granted `SELECT` on all three profile tables in the same
migration that added provenance (0009) — the first grant on any Layer 2
table for that role.

## API surface

`apps/web/src/routes/profile.ts`, all requiring auth, all scoping to
`request.principal.accountId` inside `withAccount`:

```
GET    /api/v1/profile                       -> { profile, skills, experience }
PUT    /api/v1/profile                        upsert core fields (omitted field = unchanged)
PUT    /api/v1/profile/skills                 replace whole list, case-insensitive dedup
POST   /api/v1/profile/experience             add one entry
PATCH  /api/v1/profile/experience/:id         update fields sent; isCurrent:true clears endDate
DELETE /api/v1/profile/experience/:id         remove; malformed/absent id -> 404, not 500
```

## Known gaps

- **No way to clear a field once set.** `upsertProfile` treats an omitted
  field as "leave it alone" — there is no explicit-null semantics yet to
  blank out a `headline`.
- **No UI.** API surface only, consistent with every phase before the
  dashboard (Phase 6).
- **`upsertProfile`'s read-then-write is not race-free** across concurrent
  requests on the same account — acceptable at "one person, one browser
  tab," unlike the job queue, which is why that path uses `FOR UPDATE SKIP
  LOCKED` and this one does not.

## Tests

| Suite | File | Proves |
|---|---|---|
| vitest | `packages/db/test/profile.test.ts` (16) | RLS isolation, upsert semantics, DB-constraint defense-in-depth (e.g. `ai_inference` requiring `confidence`) |
| vitest | `apps/web/test/profile.test.ts` (13) | Route wiring, validation, 404 handling, cross-tenant isolation at the route layer |
