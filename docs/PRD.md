# JobSwitch AI — Product Definition

## Provenance

This document does not recover a prior specification — none exists (see
`docs/CURRENT_STATE.md`). It is written now, from two sources: (1) what the
shipped code already commits to, including specific citations baked into
code comments (`PRD §30`, etc. — preserved verbatim below where evidenced,
because changing them would make the comments lie), and (2) decisions made
explicitly in this conversation. Where a section number below has no
evidence anywhere in the code, it is not invented — it's either omitted or
marked unknown. Section numbers below are a **fresh, self-consistent
numbering starting now**, not a reconstruction of whatever the original
(unrecoverable) document used, except for the handful of `§` numbers already
frozen into shipped comments, which are called out explicitly.

---

## §1. What this product is

Job discovery from company career pages, AI matching that explains itself,
and an application workspace that gets a candidate from "this looks right"
to "submitted" without retyping their work history for every application.
(Verbatim from the README tagline — the one piece of product framing that
has been stable across every phase so far.)

## §2. Who it is for

A job-seeking candidate, not an employer or recruiter. Every design decision
in the code so far is consistent with this: `account.type` defaults to
`'personal'`; `Errors.invalidCredentials()` deliberately returns the same
message for "no such email" and "wrong password" specifically because,
per the code comment, *"the existence of an account is itself sensitive —
it reveals that someone is job hunting"* (`packages/core/src/errors.ts`,
citing **PRD §30** — the one PRD section number that survives in shipped
code). That framing is adopted here as real: **a candidate's job search is
itself sensitive information**, and product decisions should default to
protecting that, not just the data inside it.

Location parsing in `packages/ingest/src/normalize.ts` special-cases Indian
cities (`KNOWN_CITY_COUNTRY`, `CITY_ALIASES`) ahead of any other country.
Taken as evidence, not asserted as a hard requirement: this product is
**India-first**, not India-only.

## §3. Core loop

```
Company career pages  →  Ingestion (Layer 1, shared)  →  Candidate profile (Layer 2)
                                                                    ↓
                                          Matching + explanation (Layer 2, Phase 5)
                                                                    ↓
                                    Application workspace (Layer 3, Phase 7)
```

A candidate builds one profile once. It gets matched against a job index
that is fetched once per company and shared across every candidate — not
re-fetched per user (this is `ADR D-01`, already built, see `docs/ADR.md`).
Every match a candidate sees comes with an explanation of why, not just a
score. Applying reuses profile data rather than asking the candidate to
retype it per application, to the extent each ATS's `capabilities` allow
(`ats_platform.capabilities`, already seeded for 7 platforms as of Phase 3).

## §4. The layer model

Already built exactly as follows (see `docs/CURRENT_STATE.md` §2–§8 for the
as-built detail):

| Layer | Contents | Tenant-scoped? | Status |
|---|---|---|---|
| L0 — identity | `app_user`, credentials, sessions, OAuth | No (RLS begins at L2) | Built, Phase 1 |
| L1 — job index | Companies, sources, postings, versions, groups | No — shared, cost scales with companies not users | Built, Phase 2–3 |
| L2 — personal | Candidate profile, skills, experience, matches, explanations | Yes, RLS | Profile built (Phase 4); matches/explanations not started (Phase 5) |
| L3 — application | Drafts, answers, packages | Yes, RLS | Not started (Phase 7) |
| L4 — career OS | Audit log, notifications | Yes, RLS | Audit built (Phase 1); notifications not started |

## §5. The candidate-fact model (new, this pass — governs all of L2 going forward)

Every piece of data in a candidate's profile is exactly one of four kinds,
and the system must always know which:

1. **`verified_fact`** — extracted from something the candidate provided as
   source material (an uploaded resume, a structured import). The system
   trusts it because it came from the candidate's own document, not because
   an AI asserted it.
2. **`preference`** — a stated search criterion the candidate typed
   directly (desired titles, locations, work mode, salary range). It is not
   a fact about the candidate's past; it's an instruction for matching.
3. **`ai_inference`** — derived by a model from other data (e.g., an
   inferred seniority level, an inferred skill not explicitly listed). Must
   be labeled as inferred wherever shown, and must be excluded from anything
   presented to an ATS as the candidate's own claim.
4. **`generated_text`** — model-written prose (e.g., a drafted summary or
   cover-letter paragraph). Always shown as a draft the candidate can edit
   or reject, never submitted silently on their behalf.

This distinction exists so a Phase 5 match explanation can say *why* it
trusted a fact — "matched on 4 years Python (verified from your resume)" is
a fundamentally different, more trustworthy claim than "matched on 4 years
Python (the model guessed)," and the product must be able to tell the
candidate which one it's making. **This is not yet implemented** — see
`docs/GAP_ANALYSIS.md`'s "Profile" row and `docs/ADR.md`'s AI-fact-safety
decision. It governs the pre-Phase-5 provenance migration.

## §6. Company discovery (V2 — referenced in shipped code, not built)

`packages/ingest/src/registry.ts` already contains a forward-looking
comment: *"Phase 2 uses [`detectAdapter`] only for seeding. In V2 it becomes
the core of the company discovery subsystem (ADR §6)."* Recorded here as
confirmed scope: V2 includes a way to discover and onboard a company's
career page automatically (candidate-submitted URL, or a crawl) rather than
relying only on a hand-curated seed list (today: 40 companies, unverified
tokens, in `packages/db/src/seed/companies.ts`).

## §7. ATS adapter tiers (already implemented as capability flags)

Each `ats_platform` row carries `capabilities` (`structuredLocation`,
`structuredSalary`, `department`, `directApplyUrl`, `autofillable`).
Greenhouse's adapter comment calls it *"tier A (ADR §7 tier A)"* — a public,
unauthenticated, ToS-clean job board API. Confirmed as a real tiering
concept: **not every ATS is equally safe or complete to build against**, and
the product's degradation behavior (§17 below) exists specifically because
tier-A platforms (Greenhouse, Lever, Ashby — the three built) behave
differently from lower-tier ones (SmartRecruiters, Workable, Workday — V1;
anything requiring scraping or login — later, if ever).

## §17. Graceful degradation by capability (already implemented, formalized here)

The `ats_platform.capabilities.autofillable` flag exists specifically to
drive what a Phase 7 application-workspace UI offers per company: full
autofill where the ATS supports it structurally, an assisted/copy-paste
flow where it doesn't, and a plain "open the application page" fallback
where nothing structured is available. No company name is ever hard-coded
into this decision — it reads the capability flags. This section number
(`§17`) is preserved from the migration comment in
`packages/db/migrations/0005_job_index.sql`, which cites it directly.

## §29. Silent breakage is the primary product risk (already implemented)

`scrape_run` is written on every ingestion attempt, success or failure,
specifically because — per the Phase 2 commit and the migration comment —
*"silent adapter breakage is the most likely way this product quietly
dies."* An index that silently stops growing looks, from a candidate's
side, identical to "there are no new jobs" — which is the worst possible
failure mode for a job-discovery product. This principle should govern
every future phase equally: prefer a loud, recorded failure over a quiet
one, everywhere in the system, not just ingestion.

## §30. Job search privacy (already implemented, see §2)

Restated for emphasis: **the fact that a candidate is job hunting is itself
sensitive**, independent of any data inside their profile. This already
shapes the auth error messages (§2) and should shape every future surface —
notifications, browser extension behavior (V2, below), and anything that
could leak "this person is job hunting" to an employer, a coworker, or
anyone else who is not the candidate.

## MVP / V1 / V2 boundaries (proposed, based on what's built + forward references)

| | Scope |
|---|---|
| **MVP** (Phases 1–8, current trajectory) | Auth + tenancy (1), ingestion + queue (2), 3 ATS adapters (3), candidate profile (4), matching + explanations (5), real frontend on a CDN (6), application workspace with graceful degradation (7), real email (8). Single VPS + managed Postgres, no Redis, no microservices (see ADR). |
| **V1** | SmartRecruiters, Workable, Workday adapters (already named as V1 in `registry.ts`'s comment). Broader curated company index beyond the initial 40. |
| **V2** | Company discovery subsystem (§6) — candidate- or crawl-driven onboarding of new companies, replacing the hand-curated seed list as the primary growth path. A browser extension for assisted autofill on ATS pages the API can't reach directly (see `docs/ADR.md`'s browser-extension-boundary decision — proposed, not yet designed in detail). Organization accounts actually used (schema already supports many-to-many membership; nothing exercises it yet). |

## Non-goals (explicit, to keep scope honest)

- **Not a recruiter/employer product.** No employer-facing surface is
  planned; `account.type = 'organization'` exists for a candidate's own
  team use (e.g., a career coach working multiple accounts), not for
  companies managing postings.
- **Not a general job board.** The index only ever contains companies
  explicitly onboarded (seeded today, discoverable in V2) — this is not a
  scrape-the-internet aggregator.
- **Not an auto-apply bot.** §30 and the four-kind fact model (§5) both
  point the same direction: the product explains and assists, and drafts
  text for review — it does not submit an application without the
  candidate seeing and approving what was submitted, ever.
