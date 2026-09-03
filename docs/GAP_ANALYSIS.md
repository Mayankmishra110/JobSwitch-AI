# Gap Analysis: Current Implementation vs. Proposed Target

**Read this framing before the table below, it matters:** there is no
pre-existing "locked" JobSwitch AI product definition. `docs/CURRENT_STATE.md`
established that the PRD/ADR the code cites were never committed anywhere.
So the "Intended design" column here is **not a recovered spec** — it is a
target being proposed and locked-in *now*, informed by (a) what the README
and `docs/DEPLOYMENT.md` already committed to before this audit, (b) the
layer architecture Phases 1–4 already built and would be expensive to
reverse, and (c) the profile-provenance distinction
(`verified_fact → preference → AI inference → generated text`) introduced in
this conversation. Where a row's "Gap" is large, that is not necessarily a
mistake — Phase 4 was built with no such target to aim at.

This document is the basis for `docs/PRD.md` and `docs/ADR.md`, which state
the target design formally once it's agreed.

| Area | Current implementation | Intended design | Gap | Action |
|---|---|---|---|---|
| **Global jobs (Layer 1)** | `company` / `career_source` / `job_posting` / `job_posting_version` / `job_posting_location` / `job_group`. No tenant column. Written only by `app_ingest`. Identity is `(career_source_id, source_job_id)`, never merged, only advisory-grouped. | Same. This layer already matches the "shared, tenant-free, company-centric" model consistently — nothing here contradicts a reasonable target. | None structural. Two real gaps: (1) `vector` extension enabled but `job_posting_version` has no embedding column; (2) cadence tiers (`hot`/`standard`/`cold`) exist as a column but nothing reads them — scheduling is flat `next_run_at` only. | No schema change needed to *keep* this layer. Before Phase 5: add an embedding column + index to `job_posting_version` (see ADR, "matching pipeline"). Cadence-tier scheduling can stay deferred; it doesn't block Phase 5. |
| **ATS adapters** | Adapter contract (`detect`/`fetch`/`normalize`) + Greenhouse/Lever/Ashby, one file each, registered in a flat array. All three untested against a live board — synthetic fixtures only, this environment has no outbound network. | Same architecture. Verification against real boards is an operational task, not a design gap. | Not a design gap. An honesty gap: README already states this plainly (`pnpm ... capture` exists precisely to close it) — nothing further to reconcile. | No action required for Phase 5 to proceed. Verify against live boards when a networked environment is available, independent of any phase. |
| **Profile (Layer 2)** | `candidate_profile` (flat columns: `headline`, `summary`, `currentTitle`, `yearsExperience`, `desiredTitles[]`, `desiredLocations[]`, `desiredWorkMode`, `desiredSalaryMin/Max/Currency`, `resumeFilename`, `resumeText`, `linkedinUrl`/`githubUrl`/`portfolioUrl`) + `profile_skill` + `profile_experience`. **No provenance column anywhere.** | Every fact in the profile is one of exactly four kinds, and the schema should say which: **verified_fact** (extracted from an uploaded resume or a structured source — `profile_experience` rows, parsed skills), **preference** (candidate-stated search criteria — `desiredTitles`, `desiredLocations`, `desiredWorkMode`, `desiredSalary*`), **AI inference** (derived, not stated — e.g. an inferred seniority level or years-of-experience-in-X), **generated text** (model-written prose — e.g. an AI-drafted `summary`, if that ever exists). A match explanation (Phase 5) must be able to say *why* it trusted a fact, which requires knowing which of these four kinds it is. | **This is the largest gap in the codebase.** `desiredTitles` (a preference) and `currentTitle` (arguably a verified_fact once resume parsing exists, today just a free-text field the user typed) sit in the same table with the same guarantee: none. There is no `source` / `provenance` / `confidence` column on `candidate_profile`, `profile_skill`, or `profile_experience`. Nothing currently distinguishes "the user typed this" from "this was extracted" from "this was AI-generated." | **Before Phase 5, not after.** Add provenance to the profile tables (see ADR, "AI fact safety"). This is exactly the kind of change the user flagged as expensive to retrofit once Phase 5 embeds/matches against these fields — do it as a migration now, while only Phase 4's code depends on the current shape. |
| **Resumes** | `resume_filename` + `resume_text` columns exist. No object storage, no upload endpoint, no PDF/DOCX extraction — `setResume()` takes pre-extracted text as a parameter; nothing produces that text. | `docs/DEPLOYMENT.md` (committed *before* this audit, independent of it) already states object storage is needed "not... until Phase 4 (résumés)" — i.e., the deployment plan assumed Phase 4 would need a binary store. | **Documented conflict.** Phase 4 shipped without the object store `DEPLOYMENT.md` anticipated for it. Not a silent gap — it's plainly stated as a known gap in the README — but it is a place where an earlier committed document and Phase 4's actual scope disagree. | Decide explicitly: either (a) treat resume file storage + extraction as a Phase 4.1 / pre-Phase-5 task, or (b) formally push it later and update `DEPLOYMENT.md` to stop implying Phase 4 needs it. Don't leave the disagreement unstated. |
| **Matching** | Not started. No `match` table, no `explanation` table, no embedding anywhere, no `app_matcher`-granted database URL in `.env.example`. | `verified_candidate_profile → hard_constraints → cheap_filtering → embedding_retrieval → multi_dimensional_ranking → llm_explanation → persisted_match`, computed per-account by `app_matcher` (which already has `BYPASSRLS` + `SELECT`-only on Layer 1, and needs new grants on Layer 2). | Everything. This is greenfield. | Design (not build) in a dedicated pass — see `docs/ADR.md`'s "matching pipeline" decision and the schema-readiness question at the end of this document. |
| **Applications (Layer 3)** | Not started. No tables, no routes. | An "application workspace" per the README's own tagline — drafts, answers, packages, with graceful degradation by ATS `autofillable` capability (the capability flags already exist on `ats_platform`, unused beyond storage). | Everything. | Out of scope until Phase 7 per the existing layer diagram; no action needed now. |
| **RLS / tenancy** | RLS from `audit_log` (Phase 1) through the three Phase 4 profile tables. `app_matcher` has `BYPASSRLS` and SELECT-only on Layer 1; no grant yet on any Layer 2 table. `candidate_profile` PK is `account_id`, meaning one profile per **account**, not per **user** — unexercised in practice since every account has exactly one member today, but a real decision once organizations are used. | Same RLS discipline continuing into Layer 2/3 as new tables arrive; `app_matcher` gets explicit, deliberate grants per table when Phase 5 needs to read them (not a blanket grant). The one-profile-per-account question should be answered explicitly rather than left as an accident of how the FK was drawn. | `app_matcher` cannot read `candidate_profile`/`profile_skill`/`profile_experience` today — this blocks Phase 5 trivially (a missing grant, not a redesign). The per-account-vs-per-user profile question is unresolved. | Grant `app_matcher` SELECT on the three profile tables as part of the Phase 5 migration. Explicitly decide (and record in the ADR) whether an organization account will ever have more than one profile; if not, the current 1:1-with-account design is correct as-is and just needs stating. |
| **Queue / async work** | One queue name (`ingest.source`), one handler, in `apps/worker`. Generic `Worker` class supports an arbitrary handler map already. | Phase 5 needs at least: resume extraction (if resolved above), embedding generation (per job version + per profile), and match computation — each as its own queue name / handler, reusing the existing `Worker` and `job_queue` table as-is. | No structural gap — the queue is already generic enough. The gap is that no handlers exist yet. | No schema change to `job_queue` needed. New handlers register the same way `handleIngestSource` does. |
| **Deployment** | Nothing deployed anywhere (README + `DEPLOYMENT.md` agree on this). CI builds/typechecks/tests only. | `DEPLOYMENT.md`'s stated target: static frontend on a CDN, one small VPS for API + workers + (per that doc) "the embedding model from Phase 5," managed Postgres with pgvector. | Consistent — no conflict found. `DEPLOYMENT.md` already anticipated an embedding model running on the same VPS as of Phase 5, which is a real cost/ops constraint worth carrying into the ADR explicitly rather than re-deciding later. | Carry "embedding model must fit on the existing 1-VPS budget, no new managed service" into the ADR as a locked constraint, since it's already implied by a committed document. |

## The one question this whole exercise was for

> Does the existing Phase 2/3/4 schema support the proposed Phase 5 pipeline
> cleanly, or do migrations come first?

**Answer: migrations come first, and there are exactly two of them, both
small.**

1. **Embedding columns on `job_posting_version` (and eventually
   `candidate_profile` or a dedicated `profile_embedding` table).** The
   `vector` extension is already enabled (migration 0001); no table uses it.
   This is additive — a new nullable column plus an index, not a
   restructuring of anything Phase 2 built. Low risk.
2. **Provenance columns on the three Phase 4 profile tables**
   (`verified_fact` / `preference` / `ai_inference` / `generated_text`, or
   equivalent). This is the one that matters more than the embedding column:
   retrofitting it *after* Phase 5 code starts reading and writing
   `candidate_profile` fields without caring where they came from is
   materially more expensive than doing it now, while only Phase 4's own
   code depends on the current flat shape. This is the concrete answer to
   "could guessing here force an expensive schema change" — yes, and this is
   the specific change.

Everything else Phase 5 needs (a queue handler, an `app_matcher` grant, new
`match`/`explanation` tables) is additive and low-risk against the existing
schema. The two items above are the ones worth resolving — as migrations,
reviewed on their own — before any matching code is written.
