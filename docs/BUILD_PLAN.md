# JobSwitch AI — Polyglot, Kubernetes-Native, Multi-Agent Build Plan

> **Provenance**: written during a plan-mode session on 2026-09-05, originally
> saved outside the repo. Copied in here verbatim (unedited below the line)
> specifically so it survives as part of the project rather than depending on
> an ephemeral local file a fresh session wouldn't know to look for.
>
> **Status as of 2026-09-06**: Phase 5.0 (infra — deliberately skipped for
> now, needs real cloud accounts this session cannot provision), 5.5
> (events/SSE), and 6+ (dashboard, application workspace, email) have
> **not started**. Phases 5.1, 5.2, 5.3, and now **5.4 are done** — ahead
> of what this plan's own text below still describes as pending in a few
> places. Read `specs/README.md` first for the accurate,
> continuously-maintained picture of what's actually built; treat this
> document as the target architecture and the phase sequence, not as a
> live status report. Specific corrections to what's below:
> - **5.4 is done**: `packages/resume-core` (extracted from `Mayankbuilt`'s
>   `nipun` pipeline, byte-exact, 32 tests against a real resume fixture —
>   deliberately dropped `registry.ts`'s bundled-variant lookup, since this
>   product stores a candidate's template per-account in `resume_source`,
>   not as a compile-time bundle of one person's resumes), `apps/tailor`
>   (new Fastify service — parse/validate-nouns/reinject/compile, real
>   local `pdflatex` compilation verified end to end, 12 tests), and
>   LangGraph in `services/ai` (Graph B replaces the Phase 5.3 plain chain
>   behind the existing `/v1/match/explain` route with zero contract
>   changes; Graph A is the new `POST /v1/tailor/resume`). A real bug was
>   found and fixed by testing Graph A against the real `apps/tailor`
>   service: `fabrication_check` was checking a proposed edit against the
>   *already-spliced* document, making the check tautological — fixed to
>   check against the original. See `specs/resume-tailoring.md`.
> - **5.1 is done, including the scheduled sweep**: `0009_provenance_and_
>   retention.sql` shipped combining D-22 (provenance) and D-31 (retention)
>   exactly as planned. `POST /api/v1/job-search/{start,stop,status}` exist
>   and are tested. The dormancy sweep went to `cmd/worker`, not
>   `apps/scheduler` as this plan originally assumed — `apps/scheduler` runs
>   as `app_ingest`, which structurally cannot do this cross-tenant query
>   safely; the sweep needs a `BYPASSRLS` role, which `cmd/worker` has. It's
>   now real: `internal/worker/schedule.go`'s `RunScheduledTasks` runs
>   alongside `cmd/worker`'s queue-claim loop (its own advisory lock, `pg_
>   try_advisory_lock`, distinct from `apps/scheduler`'s), computing matches
>   for every active job search (`MATCH_TICK_MS`, default 5min) then
>   sweeping sessions dormant past `DORMANT_SESSION_STALE_DAYS` (default 90)
>   — same hard-delete purge `stopJobSearch` does, `stop_reason =
>   'scheduled_sweep_inactivity'`. Needed a new migration
>   (`0015_matcher_dormancy_sweep_grants.sql` + `0016_matcher_purge_needs_
>   select_too.sql`) granting `app_matcher` access to `job_search_session`
>   and the purge tables it didn't already hold — caught by the integration
>   test actually running the sweep against real Postgres, not by
>   inspection; see `specs/ephemeral-retention.md`.
> - **5.2 is done, minus k8s deployment** (blocked on 5.0/infra, not on
>   code): `services/backend` exists (`cmd/api`, `cmd/worker` — no
>   `cmd/mcp`/`cmd/backfill` yet), hard-constraint prefilter, structured-
>   only ranking, `job_match` write path, all tested against real Postgres
>   including a cross-tenant leakage test. D-32's `EXPLAIN ANALYZE` artifact
>   was **not** produced — see gaps below.
> - **5.3 is done**, including the two pieces this note previously flagged
>   as outstanding: `packages/ingest/src/run.ts` now enqueues
>   `embed.job_version` (inside the same transaction as `upsertPosting`,
>   dedup-keyed on the version id) whenever a version is newly created or
>   changed, and `internal/repo.HybridRetrieve` wires real Stage 2 hybrid
>   retrieval (pgvector cosine RRF + normalized `ts_rank_cd`) into
>   `internal/match/match.go`, which now uses `rank.DefaultWeights()`
>   instead of the retired `structuredOnlyWeights`. Proven against real
>   Postgres with real seeded embeddings, no fakes — see
>   `specs/matching-pipeline.md`'s Stage 2 section and
>   `TestRunForAccountUsesHybridRetrieval`. `services/ai` (FastAPI,
>   `uv`-managed) ships real `fastembed` embeddings and a plain sequential
>   explain chain (not LangGraph — that's still 5.4, as planned).
>   **Live-verified against a real Groq key** — caught and fixed a real bug
>   (a deprecated hardcoded model id) in the process; see
>   `specs/embeddings-and-explanation.md`. **`embed.profile` is also now
>   built** (`internal/worker/embed_profile.go`, registered in
>   `cmd/worker`): computes `profile_embedding`'s `resume` kind
>   (`resume_upload.raw_text`, migration 0013's new `app_matcher` grant)
>   and `desired_role` kind (`current_title` + `desired_titles` +
>   `profile_skill`, the same fields the Stage 1 keyword floor already
>   uses), skipping the actual AI call when `source_hash` shows the text
>   hasn't changed. Enqueued unconditionally from
>   `jobSearchRepo.startJobSearch` (resume) and `profileRepo.upsertProfile`/
>   `replaceSkills` (desired_role) — `packages/core/src/profile.ts`'s
>   `EMBED_PROFILE_QUEUE`. `stopJobSearch` now also purges
>   `profile_embedding`'s `resume` kind specifically (migration 0014's new
>   `app_web` grant), leaving `desired_role` intact since it's derived from
>   retained biography, not search activity. Live-verified against the real
>   `services/ai` process for both kinds — see
>   `specs/matching-pipeline.md`'s `embed.profile` section. **Stage 4
>   (`/v1/match/explain`) is wired too**: `internal/match.RunForAccount`
>   enqueues `explain.match` for the top 20 matches of each run (real money
>   per LLM call, so never all of them), `cmd/worker` claims and answers
>   for real, caching by `(account_id, job_posting_version_id)` per D-09 so
>   an unchanged version never pays for a second call. Live-verified
>   through a real Groq call via the same route already verified above —
>   see `specs/matching-pipeline.md`'s `explain.match` section. Only the
>   plain chain; Graph B (LangGraph) replacing it is still 5.4.
> - **A cross-language queue interop test was added and passes**: Go's
>   `Claim()` running concurrently against a literal copy of `queue.ts`'s
>   own claim SQL, both racing the same `job_queue` rows — see
>   `specs/matching-pipeline.md`.
> - **`go test ./...` is now safe to run as-is.** It wasn't: Go runs each
>   package's tests as a separate process, in parallel by default, and four
>   packages here (`session`, `queue`, `match`, `worker`) do broad, unscoped
>   cleanup against the one shared test Postgres — reproduced as real,
>   intermittent failures, confirmed to vanish under `-p 1`. Fixed properly
>   rather than documented as a flag to remember: `internal/testutil.
>   WithSerializedDBAccess` (a blocking `pg_advisory_lock`) plus a `TestMain`
>   in each of those four packages, mirroring `packages/db/vitest.config.ts`'s
>   own `fileParallelism: false` (same problem, TS side) and `apps/
>   scheduler`'s advisory-lock pattern (this is that pattern's blocking
>   sibling).
> - **Not done, not started**: D-32's benchmark artifact, `resume-core`
>   extraction, `apps/tailor`, Graph A/B (LangGraph), NATS, the SSE bridge,
>   the dashboard, k8s manifests, multi-arch builds, Gmail integration,
>   Oracle/Hetzner provisioning.
> - **`docs/ADR.md` still only has D-01 through D-25.** D-22a and D-26
>   through D-32 exist only in this document, not yet formally merged into
>   `docs/ADR.md`'s numbered decision log as the original plan intended.
>   That merge is real remaining work, not done implicitly by this copy.
>
> ---
>
> The rest of this file is the plan as originally written, unedited.

## Context

Mayank is an SSE (2+ YOE) at WebKnot Technologies targeting SDE2 frontend/
fullstack roles at Indian product companies, 18–50 LPA. This project has two
equally-weighted goals, restated by him explicitly: (a) actually help him
switch jobs, and (b) be a maximum-breadth, defensible **learning vehicle** —
"cover TS/React/Next.js, Go, Python/FastAPI, LangGraph, MCP, event-driven
architecture, real-time events, search query optimization, Kubernetes,
deployment/DB orchestration... become a competent AI full-stack engineer /
SDE2 profile... prepare for my interview using the code and components."

**Time is explicitly not a constraint. Cost is: free if possible, ≤ ~₹500–
1000/month otherwise**, while nonetheless being usable by ~5,000 registered
users with light, bursty, non-concurrent usage (stated assumption, pending
correction — a user checks matches once a day, tailors a resume
occasionally; this is not 5,000 concurrent connections, which no budget in
this range supports). "Should be perfect... amazing engineering decisions
and tradeoffs taken with due research" — every major choice below is decided
with an explicit alternative comparison, including calling out where the
more-impressive-sounding option is the wrong one for this workload.

**Three repos already exist and this plan integrates them, not rebuilds
them** (unchanged from earlier analysis):

1. `Job switch AI` — pnpm TS monorepo, Postgres 16 + pgvector, 223 passing
   tests, Phases 1–4 done (identity/tenancy/RLS, job ingestion via
   Greenhouse/Lever/Ashby adapters, Postgres queue with `FOR UPDATE SKIP
   LOCKED`, candidate profile). Committed but unpushed.
   `docs/{CURRENT_STATE,GAP_ANALYSIS,PRD,ADR}.md` already written in a prior
   audit this session — ADR D-01 through D-25 already exist; this plan
   continues that numbering with **D-26 through D-32**.
2. `Mayankbuilt` — deployed Next.js site containing **nipun**, a resume-
   tailoring pipeline. Its *template* path (byte-exact LaTeX span-splicing
   against Mayank's own two `.tex` resumes — verified to be his real current
   resumes, WebKnot/Cenomi/KAVACH all present — with a working fabrication
   detector) is genuinely excellent and directly reusable. Its *uploaded*
   path is broken in four independent ways and is **not** ported.
3. `Naukri` — a personal Playwright automation script. Stays personal.

**Decisions locked** (do not relitigate; each has a full rationale in its
numbered section below):

1. New backend = **Go**. AI/ML = **FastAPI (Python) + LangGraph**. Existing
   TS ingestion, `packages/db`, `packages/core` stay (strangler pattern).
2. Vector store = **pgvector**, HNSW — no Chroma, no new datastore.
3. Email outreach = **draft → human review → one-click send**, enforced as a
   **database CHECK constraint**, via **Gmail API + OAuth** (attaches PDFs,
   sends genuinely as him).
4. **React Native dropped → PWA + Capacitor.** Directly reuses a pattern he
   already shipped in production (Cenomi Plus @ WebKnot → Play Store/App
   Store via Capacitor) — real interview story, no new mobile framework to
   learn from zero.
5. **Kubernetes: single-node k3s**, hand-written manifests + Kustomize (not
   Helm — see D-29). Real primitives, not a toy, not obscured by templating.
6. **Hosting: Oracle Cloud Always Free (4 OCPU / 24GB ARM Ampere, ₹0)**,
   primary. **Hetzner CX22 (~₹420/mo, x86_64)** fallback if Oracle capacity
   is unavailable in-region — this forces genuine **multi-arch image builds**
   from day one (D-30), not an afterthought.
7. Postgres = **self-hosted in k3s** (`StatefulSet` + PVC) — required
   regardless of cost, because migration `0001` does `CREATE ROLE`/`ALTER
   ROLE ... BYPASSRLS`/`REVOKE ALL ON SCHEMA public`, which needs superuser
   and rules out managed Postgres. This **supersedes** the managed-Postgres
   half of existing decision D-25 — flagged explicitly, not silently dropped.
8. **Ephemeral resume retention** (D-31): an explicit "active job search"
   toggle; while off, all résumé-derived, employer-specific data is hard-
   deleted. A genuine extension of the already-locked PRD §30 privacy
   framing, not a bolt-on.
9. Event bus = **NATS JetStream** (D-26) — not Kafka (too heavy for this
   workload and box), not Redis (D-13 already rejected Redis at this scale
   for the queue; reintroducing it just for events would contradict that
   reasoning without a new argument). Complements, does not replace, the
   existing `job_queue`.
10. Real-time delivery = **SSE**, not WebSocket (D-26) — the actual need is
    unidirectional server→client progress push; SSE gets cookie auth for
    free and composes with the existing single-origin, no-CORS design.
11. LLM keys already available: Groq (nipun's default), Gemini, OpenAI.
12. The uploaded-resume flow from nipun is **not** ported — only the
    template/span-splicing path is extracted.

---

## Architecture

**One repository, four languages (TS, Go, Python, LaTeX/Rust via tectonic),
one Postgres, one k3s cluster.**

```
jobswitch-ai/
  apps/                              # pnpm workspace — TypeScript
    web/          KEEP   Fastify: auth pages, session issuance, /api/v1/profile,
                          NEW: SSE bridge at /api/v1/events/stream
    worker/       KEEP   ingest.source handler (+ enqueues embed jobs)
    scheduler/    KEEP   advisory-locked ticker (+ enqueues match.account,
                          NEW: dormant-job-search sweep, D-31)
    tailor/       NEW    stateless LaTeX span-surgery HTTP service (Fastify)
                          + tectonic compile (D-30)
    dashboard/    NEW    Next.js App Router UI, PWA manifest + service worker,
                          Capacitor wrapper for Android/iOS (D: item 4)
  packages/
    core/ db/ ingest/    KEEP
    resume-core/  NEW    extracted pure nipun modules (parser/reinject/etc.)
  services/                          # NOT in pnpm workspace
    matcher/      NEW    Go — one image, 3 entrypoints (api/worker/mcp)
      cmd/{api,worker,mcp,backfill}/main.go
      internal/{config,db,httpx,session,repo,match,rank,clients,handlers,events}/
    ai/           NEW    FastAPI — embeddings (fastembed) + LangGraph agents,
                          stateless, no DB
      app/{main,config,models,routers,llm,embed,graphs}/
  k8s/                               # NEW — replaces deploy/ Caddy+Compose plan
    base/         Kustomize base manifests, one dir per component
    overlays/prod/
    overlays/dev-k3d/   local manifest testing before touching the real box
  contracts/       shared JSON request/response fixtures, cross-language tests
  docs/            CURRENT_STATE.md, GAP_ANALYSIS.md, PRD.md, ADR.md (extend to D-32)
```

**Database role strategy — two pgx pools in Go, no new role** (unchanged
reasoning from earlier analysis): `BYPASSRLS` is a role *attribute*, not
inherited via `GRANT` membership — mixing both privileges into one pooled
role via `SET ROLE` is the exact misconfiguration `docs/DEPLOYMENT.md` warns
about. Keep separate:
- **Web pool** (`DATABASE_URL`, `app_web`, RLS enforced): every request-path
  query, inside `WithAccount(ctx, tx, accountID)` running `SELECT
  set_config('app.current_account_id',$1,true)` as the tx's first
  statement — mirrors `packages/db/src/context.ts` exactly.
- **Matcher pool** (`DATABASE_URL_MATCHER`, `app_matcher`, `BYPASSRLS`): only
  `cmd/worker`, only inside a per-account loop (ADR D-13). Discipline
  enforced in code (explicit `WHERE account_id=$1` on every query) plus a
  **cross-tenant leakage test**: seed two accounts, run one match pass,
  assert zero cross-account writes.

---

## D-26 — Event bus: NATS JetStream + SSE, not Kafka/WebSocket

**NATS JetStream**, single-replica `StatefulSet` in `jobswitch-data`, PVC-
backed. Honest comparison:

| Option | Tempting because | Wrong here because |
|---|---|---|
| Kafka | Most interview-recognizable; partitions/consumer-groups are real concepts | Needs a JVM + ZooKeeper/KRaft, realistic min footprint 1–2GB+ heap before doing anything — disproportionate on a shared 24GB box already running Postgres, an embedding model, and ~9 other pods, to demonstrate concepts a lighter tool demonstrates just as well. Kafka's real differentiators (multi-DC replication, log compaction, sustained multi-GB/s) are unused capability here — same shape of mistake D-13 already avoided by rejecting Redis for the queue. |
| Redis Streams | Simple, familiar name | Would be a *second* message-passing system next to `job_queue`, directly contradicting D-13's standing, reasoned rejection of Redis at this traffic level — without a new argument to justify reversing it. |
| **NATS JetStream** | — | Single static binary (~15–20MB idle), core pub/sub *and* durable streams/consumers in one process, first-class Go/Python/Node clients (a real fit for this exact stack), request-reply built in. Right-sized and still genuinely production-grade. |

**What moves to NATS vs. what stays in `job_queue`** — boundary is "who's
doing the work and how many parties care," not a replacement:
- **Stays in `job_queue`** (unchanged, proven, 16 tests): same-language,
  same-service, single-consumer internal task claiming — its actual shape.
- **Moves to NATS**: (1) **fan-out** — one fact, multiple independent
  consumers (`match.computed` read by the SSE bridge *and* later a
  notification service *and* later analytics — `job_queue`'s claim
  semantics assume exactly one winner per row, not N independent readers);
  (2) **cross-service, cross-language handoff** — web(Node)→matcher(Go)→
  ai(Python)→tailor(Node). Using `job_queue` here would mean every new
  polyglot service needs its own Postgres role/pool/RLS plumbing just to
  poll for work that isn't tenant data. JetStream's durable pull consumers
  give the same ack/nak/redelivery semantics uniformly, without that
  plumbing, across three languages.

**Real-time delivery: SSE**, one bridge (`GET /api/v1/events/stream` in
`apps/web`), subscribing to that account's NATS subject
(`account.<id>.>`) and relaying to the browser. Not WebSocket: the actual
need is unidirectional server→client progress push (nothing bidirectional
exists anywhere in this product). SSE wins decisively here: `EventSource` is
a plain GET, so it **carries the existing `js_session` cookie automatically**
through the same `requireAuth` preHandler already in place — WebSocket can't
send custom headers in-browser, so you'd fake the same cookie auth with more
code. Built-in reconnect. The one real caveat (HTTP/1.1's ~6-connections-per-
origin cap) is already mitigated by k3s's bundled Traefik terminating HTTP/2
by default — and Traefik forwards proxied chunks as they arrive with **zero
extra Ingress annotations** (unlike nginx, which needs `proxy_buffering off`).

### Domain event catalog

| Event | Publisher | Consumer(s) | Fires when |
|---|---|---|---|
| `job.posting.created` | `apps/worker` | matcher-worker (enqueue embedding) | new `job_posting` row commits |
| `job_version.embedded` | matcher-worker | ops telemetry (optional) | `job_posting_version.embedding` written |
| `match.computed` | matcher-worker | web SSE bridge | a `job_match` set for an account finishes |
| `application.status_changed` | web | web SSE bridge, `audit_log` | `job_application.status` updates |
| `resume.tailoring.proposed` | tailor (Graph A `finalize`) | web SSE bridge | proposed changes ready for review |
| `resume.tailoring.compiled` | tailor (post-approval compile) | web SSE bridge | `resume_artifact` PDF written |
| `outreach.draft.created` | matcher (via `app_web` pool) | web SSE bridge | `outreach_draft` commits |
| `job_search.stopped` | web (stop endpoint) | web SSE bridge (confirmation) | **after** D-31's purge transaction commits, never before |

**Load-bearing payload rule**: every event touching résumé-adjacent data
carries `account_id` + a row reference **never the content itself**. If
`resume.tailoring.proposed` embedded raw resume text by value, that text now
has a second home inside JetStream's own retention window, and D-31's purge
guarantee would need to chase copies through the event bus too. Pass-by-
reference keeps the purge boundary exactly at the tables named in D-31.

---

## D-27 — LangGraph orchestration in `services/ai`

Replaces a naive linear `extract-jd → rewrite → validate` chain — but that
chain **ships first, as a real milestone (Phase 5.3), before the graph
version (Phase 5.4)**. This isn't hedging: it guarantees a working, cheaper
baseline exists at every point, and the LangGraph version becomes a
deliberate, separately-explainable upgrade ("here's the naive version, here's
what broke without the graph, here's the fix") — better interview material
than a graph with no baseline to compare against.

### Graph A — Resume tailoring

```
extract_jd → load_candidate_facts → plan_edits → provenance_gate → apply_splice → fabrication_check
                                          ▲                                            │
                                          └──────── (fail, retries left, max 2) ────────┘
                                                                │
                                                    (fail, retries exhausted)
                                                                ▼
                                                     flag_for_manual_review
                                          (pass) → finalize → [resume.tailoring.proposed]
```

- **`load_candidate_facts`** — calls back to matcher's `app_web`-pool API;
  every fact returns as `{value, provenance}`. This is where D-22 becomes
  structural: the schema itself cannot represent a fact without its tag.
- **`plan_edits`** — LLM proposes `{field, new_text, source_fact_ids}` —
  every edit must **cite** the fact(s) behind it.
- **`provenance_gate`** — **plain code, not an LLM call.** Strips any edit
  citing a missing fact or one tagged `ai_inference`. This is D-22's actual
  enforcement mechanism — a deterministic function in the graph, not a
  system-prompt line the model could ignore.
- **`apply_splice`** → `fabrication_check` — call `packages/resume-core`'s
  `parser.ts`/`reinject.ts` (byte-exact) then `properNouns.ts`.
- **The real loop**: on failure with retries left, route back to
  `plan_edits` carrying the specific failure as feedback — bounded by
  `retry_count` in graph state (max 2), so this can't become an unbounded
  cost/latency risk (ties to D-24). On exhaustion: return the **original,
  unmodified template** plus what couldn't be safely tailored and why — it
  never ships a partially-fabricated edit, even under retry pressure.
- **PDF compilation is deliberately not a graph node** — it's a plain
  function call after candidate approval, outside the graph. Not every step
  needs to be a node; compilation is deterministic execution with no
  decision point.
- **Checkpointing**: LangGraph's in-memory checkpointer, scoped to one
  request — not a persistent Postgres checkpointer, consistent with "`ai` is
  stateless, no DB."

### Graph B — Match explanation

```
load_match_context → draft_explanation → self_critique → provenance_gate
                            ▲                                    │
                            └──── (unsupported claims, retries left) ──┘
                                                    │
                                    (final) → finalize_explanation → [match_explanation persisted]
```

- **`self_critique`** is genuine: a second pass outputs `{claim, supported,
  matching_fact_id | null}` per sentence — real traceability checking, not
  restated confidence.
- **`provenance_gate`** strips unsupported claims. **Deliberate asymmetry
  with Graph A**: on final failure here, ship the shorter, fully-supported
  explanation rather than blocking entirely — because Graph A edits a
  document that might be **submitted verbatim to an employer** (block on
  doubt), while Graph B produces **read-only UI copy** (a shorter honest
  explanation beats no explanation). State this distinction explicitly if
  asked — it shows risk-per-surface reasoning, not one rule applied by habit.

### Contract sequencing

Single-response first (`POST /v1/tailor/resume`, `POST /v1/match/explain` —
`ai` runs `graph.invoke()`, returns the final result) — this must work end-
to-end before anything streams. **Then**, as a phase-2 enhancement: streaming
variants (`/stream`, NDJSON over `graph.astream()`, one line per **node**
transition, not per-token — the product need is progress visibility, not a
typewriter effect). The full chain is genuinely three hops: FastAPI streams
→ Go matcher consumes and republishes each transition as a small NATS event
→ web's SSE bridge relays to the browser. This is the most architecturally
interesting *and* most moving-parts-heavy piece in the system — build it
after the synchronous version works, so a demo always has a fallback.

---

## Migrations (three waves, following `0007_personal_profile.sql`'s exact
RLS/grant template)

**Wave A — `0008_tailoring_and_pipeline.sql`**
- `resume_source(account_id, variant_id, label, pdf_base_name, tex, sha256,
  ...)` — PK `(account_id, variant_id)`.
- `job_application(..., job_posting_id NULLABLE, manual_company,
  manual_title, manual_jd_text, status CHECK IN (found, tailoring, tailored,
  applied, responded, interview, offer, rejected, withdrawn), ...)` —
  `job_posting_id` nullable **on purpose**, a pasted JD must work before
  ingestion/matching exist.
- `application_event(..., from_status, to_status, note, occurred_at)` —
  append-only, mirrors `scrape_run`.
- `resume_artifact(..., status CHECK IN (proposed, compiled, failed),
  proposed_changes jsonb, flags jsonb, accepted jsonb, tex, pdf_bytes bytea,
  pdf_sha256, compile_error, ...)`. `pdf_bytes bytea`, not S3 — ~100KB/PDF,
  no new managed service (D-24). **This table is a D-31 purge target.**
- `jd_extraction(job_posting_version_id PK, extraction jsonb, model,
  prompt_version, ...)` — Layer-1-shared cache (not personal data, outside
  D-31's purge mechanic entirely), keyed on version per D-09.

**Wave B — `0009_provenance_and_retention.sql`** (before any matcher/tailor
code — GAP_ANALYSIS's own conclusion; combined with retention since both
touch the same existing table in one migration):

- **Provenance (D-22)**: `CREATE TYPE fact_provenance AS ENUM
  (verified_fact, self_asserted, preference, ai_inference, generated_text)` —
  five values (added `self_asserted` for hand-typed fields that are neither
  extracted-from-document nor a preference; record as D-22a). Add columns to
  `candidate_profile` (4 ambiguous fields), `profile_skill` (+
  `evidence_ref`, `confidence`, `CHECK (provenance <> 'ai_inference' OR
  confidence IS NOT NULL)`), `profile_experience` (+ `evidence_ref`). Grant
  `app_matcher` SELECT on all three.
- **Ephemeral retention (D-31)** — see full design below — is implemented in
  this same file: `job_search_session` (new table), `resume_upload` (new
  table, **split off** `candidate_profile`'s existing `resume_filename`/
  `resume_text`/`resume_uploaded_at` columns from migration `0007`). **This
  requires a code change, not just SQL**: `packages/db/src/repositories/
  profile.ts`'s existing `setResume()` (built in Phase 4) currently writes
  those three columns directly on `candidate_profile` — it must be
  refactored to write `resume_upload` instead, gated on an active
  `job_search_session`. `packages/core/src/profile.ts`'s `CandidateProfile`
  type loses those three fields.

**Wave B, continued — `0010_embeddings.sql`** and **`0011_matching.sql`**
(unchanged from earlier analysis): `job_posting_version` gains `embedding
vector(384)`, `embedding_model`, `embedded_at`, plus a generated+stored
`search_tsv tsvector` + GIN index; HNSW index (`m=16, ef_construction=64`,
justified over IVFFlat because the index grows continuously by design —
IVFFlat needs training on a populated table and degrades as it grows).
Column-level `GRANT UPDATE (embedding, embedding_model, embedded_at)` to
`app_matcher` — writes vectors, cannot touch job content. `profile_embedding`
table, PK `(account_id, kind)`. Embedding model: **`BAAI/bge-small-en-
v1.5`** (384-dim) via **`fastembed`** (ONNX Runtime, no PyTorch — ~200MB vs
~2GB, fits the box; verified `onnxruntime` CPU and `tokenizers` both publish
`aarch64` wheels — see D-30). `job_match`/`match_explanation` tables per
D-09's version-keyed caching; column-level `GRANT UPDATE (dismissed_at)` to
`app_web` on `job_match` — dismiss, never rescore.

**Wave C — `0012_outreach.sql`**: `outreach_contact`, `outreach_draft(...,
status CHECK IN (draft, approved, sent, failed, discarded), facts_used
jsonb, approved_at, sent_at, provider_message_id, ...)`. Load-bearing:
```sql
CONSTRAINT outreach_sent_implies_approved CHECK (sent_at IS NULL OR approved_at IS NOT NULL),
CONSTRAINT outreach_sent_needs_receipt CHECK (status <> 'sent' OR (sent_at IS NOT NULL AND provider_message_id IS NOT NULL))
```
"Never auto-send" becomes something the database refuses to represent, not
just app logic. `POST /outreach/:id/send` is a compare-and-set (`WHERE
status='approved' ... RETURNING id`, zero rows ⇒ 409). `email_credential`
(new table, not `oauth_identity`) holds the Gmail refresh token, `pgcrypto`-
encrypted. **This table is a D-31 purge target** (it's employer-outreach
content).

> **Note**: as actually built, `0012` was used for a different, smaller fix
> (`app_matcher`'s missing grant on `job_application`) discovered while
> building Phase 5.2 — see `specs/matching-pipeline.md`. The outreach
> migration described here will need the next free number (`0013` or later)
> when Wave C is actually built, not `0012`.

---

## The matching pipeline (Go)

```
Hard constraints (SQL, cheap)  →  Hybrid retrieval (pgvector + tsvector, RRF)
     →  Ranking (pure Go, no DB)  →  LLM explanation (async, top 20 only, LangGraph B)
     →  Persisted match
```

**Stage 1** — single CTE: `closed_at IS NULL`, seen ≤30 days, location/work-
mode match, `salary_max IS NULL OR salary_max >= floor` (NULL never fails —
most rows are NULL since only Ashby emits structured salary), keyword floor
via `search_tsv`, dedupe via `job_group` representative-only, exclude
dismissed/tracked. 25k rows → expected 200–2000 survivors; everything
expensive runs only on these.

**Stage 2** — vector search twice (resume vector, desired-role vector)
against the prefiltered CTE, fused with the BM25 rank via **Reciprocal Rank
Fusion** (`Σ 1/(60+rank_i)`) — sidesteps calibrating `ts_rank_cd` and cosine
distance against each other, which live on incomparable scales.

**Stage 3** — pure Go `rank` package, DB-free, table-driven tests:
```go
type Signals struct {
    Vector, Keyword, SkillOverlap, Seniority, Location, Freshness float64
    Comp *float64 // nil = unknown; must not silently become zero
}
func Score(s Signals, w Weights) (total float64, breakdown map[string]float64)
```

**Stage 4** — LangGraph B explanation, top 20/account/run only, cached by
`(account_id, job_posting_version_id)` per D-09.

### D-32 — Search query optimization, as a demonstrable artifact (not padding)

1. **Committed `EXPLAIN (ANALYZE, BUFFERS)` write-up**, naive vector-then-
   filter vs. the prefilter-then-vector-search shape above, against a seeded
   5–20k synthetic dataset. **The genuinely non-obvious point to document**:
   once the CTE has cut the candidate set to a few hundred/thousand rows,
   Postgres's planner will likely pick a sequential scan + exact sort over
   the HNSW index for that final ordering — and that's *correct*, not a
   missed optimization. HNSW's approximate-index advantage only matters over
   large N; an exact brute-force sort over an already-small, already-
   qualified set is both faster and gives exact (not approximate) top-K.
   Documenting the planner choosing `Seq Scan` over `Index Scan`, and why
   that's right, is a stronger artifact than "we added an index."
2. **RRF, named explicitly**, over hand-tuned score blending — sidesteps
   calibration entirely by using only each ranker's ordering.
3. **HNSW parameters benchmarked, not defaulted** — a small recall@10-vs-
   latency table at `ef_search` = 40/100/200 against the seeded dataset.
4. **Partial/covering indexes chosen from evidence** — a partial index on
   the prefilter's hot WHERE clause (mirrors `job_queue`'s existing partial-
   index pattern); add `INCLUDE` columns only if `EXPLAIN BUFFERS` actually
   shows heap fetches dominating. "Profile first, don't index-guess."
5. **Materialized views — the honest "not yet" call**: define the prefilter
   as a plain `VIEW` now (flipping to `MATERIALIZED VIEW` + scheduler-driven
   `REFRESH` later is then a one-line change), consistent with D-13's
   traffic-level reasoning for rejecting premature infrastructure. `job_match`
   rows, computed once per batch and read many times, **already are** the
   cache — an app-level LRU or Redis on top would be redundant.

---

## D-31 — Ephemeral resume retention

Extends D-22 (fact provenance) and PRD §30 ("the fact that a candidate is
job hunting is itself sensitive") — not a bolt-on. **The principled line**:
*does this row name or imply a specific employer/posting engaged with via
this product, during an active search? If yes → purge on stop. If no (it
only describes the candidate, not who they contacted) → retain.*

### Schema

- **`job_search_session`** (new) — `account_id`, `status CHECK IN (active,
  stopped)`, `started_at`, `stopped_at`, `stop_reason CHECK IN (user_action,
  scheduled_sweep_inactivity)`. Partial unique index `(account_id) WHERE
  status='active'`. Append-only history (mirrors `scrape_run`/`audit_log`'s
  existing taste for inspectable state transitions), not a single boolean.
- **`resume_upload`** (new, split off `candidate_profile`) — `account_id`
  PK, `raw_text`, `filename`, `uploaded_at`. **Why split rather than `UPDATE`
  in place**: `candidate_profile` has **no DELETE policy at all**,
  deliberately (`CURRENT_STATE.md`: "rows are only ever upserted, never
  deleted"). A dedicated table means the purge is a plain `DELETE FROM
  resume_upload WHERE account_id=$1`, without touching that existing,
  tested, documented invariant.
- **`resume_source` is also purged**, and this is a deliberate call, not the
  obvious one: a LaTeX resume source, as tailoring actually needs it, is not
  "just formatting" — it's real work history/dates/contact details marked up
  in LaTeX. Sensitivity is about content, not encoding. (A genuinely lower-
  sensitivity "stripped structural skeleton" — no name, no employer, no
  dates — is a real V2 idea for an opt-in "remember my formatting," but
  building it now to soften this UX cost would be exactly the scope creep
  this pivot said to avoid.)

### What purges vs. persists

| Purge (hard `DELETE`) | Retain |
|---|---|
| `resume_upload`, `resume_source`, `resume_artifact` (arguably the single most sensitive artifact — ties identity+content+employer+date in one file), `job_application`, `job_match`, `match_explanation`, `outreach_draft` | `candidate_profile` (minus the 3 resume columns), `profile_skill`, `profile_experience` (self-disclosed biography, not "search activity via this product"), `job_search_session` itself (metadata *about* the search, needed for "resume later" to mean anything) |

`jd_extraction` is unaffected either way — Layer-1-shared, keyed by
`job_posting_version`, not personal data, outside this mechanic entirely.

### Purge trigger — both, for different failure modes, not redundant

1. **Explicit stop (primary)**: `POST /api/v1/job-search/stop`, synchronous
   hard `DELETE` across all purge tables **in one transaction** under the
   account's own `withAccount`/`app_web` context — only after commit,
   publish `job_search.stopped`. Synchronous, not queued, because "boom,
   gone" is a claim about *when*: an async purge could only honestly say
   "stopping…" while data might still exist. Data volume (one account, ~7
   tables) is trivially small — async buys nothing here.
2. **Scheduled sweep (safety net)**, extending `apps/scheduler` with a
   second periodic task — finds sessions dormant >90 days (confirm against
   `DEPLOYMENT.md`'s DPDP checklist), auto-stops + purges. Needed because
   relying solely on explicit action means an abandoned account keeps its
   résumé indefinitely — the same instinct as D-05's absence guard and §29's
   silent-breakage framing, applied to retention. Extends the existing
   scheduler (its advisory-lock singleton already prevents double-runs)
   rather than a separate k8s `CronJob`, which would reintroduce the exact
   race that guard exists to prevent.

   > **As actually built**: this ended up NOT extending `apps/scheduler` —
   > see the status note at the top of this file. `apps/scheduler` runs as
   > `app_ingest`, which cannot safely run this cross-tenant query. The
   > sweep function (`findDormantActiveSessions`) exists and is tested but
   > is wired to `services/backend/cmd/worker` instead, once that binary
   > runs on a schedule.

**Hard delete, no soft-delete.** One honest caveat, named rather than
hidden: a purged résumé can still exist in a pre-purge Postgres backup
snapshot for as long as that snapshot is retained — which is exactly why the
backup `CronJob` (below) needs an explicit, short retention cap.

---

## D-29 — Kubernetes: single-node k3s

### Manifests: hand-written + Kustomize, not Helm

Helm's real value (parameterizing one chart across multiple clusters/
environments, or distributing to others) doesn't apply — there's one
production cluster. Helm's templating would **obscure** the raw manifest
shapes that are the actual learning target and interview-discussable
artifact; you can't demonstrate real K8s knowledge from `helm install`
against someone else's chart. Kustomize patches real YAML — what's in the
repo is what's running.

### Namespaces

Two, deliberately not twelve: `jobswitch` (all stateless Deployments — web,
worker, scheduler, matcher-api/worker/mcp, ai, tailor) and `jobswitch-data`
(Postgres, NATS) — separating stateful infra from stateless workloads is a
real production pattern (different upgrade cadence, backup concerns, tighter
`NetworkPolicy` scoping). A namespace-per-service would be over-segmentation
for one operator with no multi-team RBAC need.

### Manifest inventory

| Component | Kind | Notes |
|---|---|---|
| web, worker, scheduler | Deployment+Service+ConfigMap | One Node image, three Deployments differing only in `command` — mirrors the existing "one image, three entrypoints" pattern exactly. `web`: 2 replicas (real rolling-deploy demo). |
| matcher-api, matcher-worker, matcher-mcp | 3× Deployment+Service, **one Go image** | Same "one image, N entrypoints" pattern, deliberately extended. `matcher-mcp`: ClusterIP only, **no Ingress path** — trusted internal caller only; public exposure is a separate future decision. |
| ai | Deployment+Service+ConfigMap | Heaviest single pod (loaded embedding model + Python runtime). |
| tailor | Deployment+Service | Needs `tectonic`, not full `texlive` — see D-30. |
| **postgres** | **StatefulSet+PVC**, not plain Deployment | Stable pod identity/DNS even at replica=1; a single-writer stateful DB on a `ReadWriteOnce` PVC is essentially never a plain `Deployment` in real usage. Using `Deployment` here would be the actual anti-pattern. |
| nats | StatefulSet+PVC | Single replica — genuinely single-node cluster, no second node for NATS to span. |
| Secrets | Plain `Secret` objects, applied out-of-band, never committed | 4× `DATABASE_URL*`, LLM keys, OAuth creds, `SESSION_SECRET`. Sealed-secrets/SOPS is a legitimate future GitOps upgrade, not required now — don't add a controller to solve a problem already avoided by keeping secrets out of git. |
| Ingress | Traefik (k3s-bundled), path-routed | See routing translation below. |
| cert-manager + `ClusterIssuer` | Standard | Traefik has its own ACME resolver (simpler), but cert-manager is the broadly-transferable skill used at real companies — worth the extra manifest for the learning goal. |
| HPA | 1, on `matcher-api` only | See below. |

**Storage class**: k3s's bundled `local-path-provisioner` — PV tied to node
disk, correct for a genuinely single-node cluster. State plainly: PVC
durability = disk durability, no failover node. This is exactly why the
backup `CronJob` (pg_dump → free object storage, retention-capped) is **non-
negotiable**, and why the cap matters for D-31's purge guarantee to actually
hold over time.

**Routing**: the existing single-origin, path-routed, single-`js_session`-
cookie design translates mechanically — each old Caddy path directive
becomes a Traefik `Ingress` path rule, all behind one Ingress host. Whichever
service validates the session cookie keeps doing so unchanged; this is a
mechanical port of reverse-proxy rules, not an auth redesign. New paths
(`/api/v1/events/stream` → web's SSE bridge) slot into the same model, no
new CORS story.

### Resource sizing (24GB / 4 OCPU ARM box)

Sums to well under capacity deliberately — gives the HPA somewhere real to
scale into, and slack for Ampere free-tier burst variance:

| Component | Request | Limit | Replicas |
|---|---|---|---|
| postgres | 512Mi/0.5 | 1.5Gi/1 | 1 |
| nats | 128Mi/0.1 | 512Mi/0.5 | 1 |
| web | 128Mi/0.1 | 512Mi/0.5 | 2 |
| worker | 128Mi/0.1 | 384Mi/0.3 | 1–2 |
| scheduler | 64Mi/0.05 | 256Mi/0.2 | 1 |
| matcher-api | low CPU request (deliberate, HPA headroom) | 256Mi/0.5 | 2 (HPA 2→4) |
| matcher-worker | 128Mi/0.2 | 512Mi/1 | **1, fixed** |
| matcher-mcp | 32Mi/0.05 | 128Mi/0.2 | 1 |
| ai | 512Mi/0.5 | 1.5Gi/1 | 1 |
| tailor | 128Mi/0.1 | 512Mi/0.5 | 1–2 |
| **Total at limits** | | **~7.3GB/~5.7 CPU** | of 24GB/4 OCPU (+~1GB k3s system overhead) |

`matcher-worker` is **fixed at 1 replica, deliberately**: D-13's per-account
`BYPASSRLS` iteration is sequential by design specifically so bypassing RLS
never accidentally becomes cross-tenant. Multiple replicas would need a
work-splitting scheme (account-range partition, or an advisory lock like the
scheduler's) that doesn't exist yet — named as explicit future work.

**HPA — honest answer**: at ~5,000 registered/non-concurrent/bursty traffic,
sustained CPU pressure triggering organic scale-out is genuinely unlikely
almost everywhere — say so plainly. One legitimate place: **`matcher-api`**,
`minReplicas=2, maxReplicas=4`, ~65% CPU target — a nightly `matcher-worker`
batch finishing (and, later, triggering notifications) is a real correlated-
burst pattern right after. **Why `maxReplicas=4` specifically, not a round
number**: Postgres `max_connections=100` default; every replica of every
service holds its own pool. Keeping per-pod pools small (5–10 conns) and
capping at 4 keeps `pool_size × maxReplicas × service_count` comfortably
under 100 — genuinely good interview material ("why 4, not 10"). Explicitly
**not** on web (2 static replicas is the honest availability answer), worker/
scheduler/matcher-worker (queue-drain/singleton patterns don't scale
linearly without work-partitioning — a KEDA problem, out of scope, not
silently unaddressed), ai/tailor (fixed per-pod costs — model load, LaTeX
warm-up — make reactive scaling distortive), postgres/nats (stateful).

---

## D-30 — arm64 / multi-arch build strategy

**Genuine multi-arch images** (`docker buildx build --platform
linux/amd64,linux/arm64 --push`), pushed to `ghcr.io` (free). **Why not
arm64-only**, given the primary target is ARM: the stated fallback, Hetzner
CX22, is **x86_64** (Hetzner's CX line is Intel Xeon; ARM is the separate CAX
family) — an arm64-only image would silently fail (`exec format error`) on
the fallback. Build genuinely multi-arch from day one so the fallback stays
viable without a rebuild scramble under pressure.

**CI reality**: GitHub free-tier Actions runners are amd64-only, so the
arm64 leg cross-builds via `buildx`+QEMU emulation (native arm64 runners
exist but are paid-tier, conflicting with the cost ceiling) — budget for
slower arm64 builds, especially on `ai`.

**Per-language friction, checked not assumed**:
- **Node** — none; `node:22-slim` already publishes `linux/arm64/v8`.
- **Go** — easiest by far: `GOARCH=arm64 GOOS=linux go build` cross-compiles
  trivially, zero runtime dependency risk.
- **Python (`fastembed`)** — verified: `onnxruntime` (CPU, not the GPU
  variant, which has real aarch64 gaps but isn't needed here) publishes
  `manylinux_2_28_aarch64` wheels; `tokenizers` (Rust/pyo3) also ships
  aarch64 wheels. Plain `pip install` should resolve cleanly. **The real
  friction is different**: `fastembed` downloads model weights (~130MB) at
  first use unless pre-cached — must be **baked into the image at build
  time** (`RUN python -c "from fastembed import TextEmbedding;
  TextEmbedding('BAAI/bge-small-en-v1.5')"` as a build layer), so a cold pod
  restart doesn't depend on an outbound download succeeding — same "silent
  breakage" failure mode PRD §29 already names, just at the infra layer.
  **Do an arm64 `buildx` smoke test of this exact bake-in as literally one
  of the first `ai`-service tasks** — cheap to catch on day one, a scramble
  to discover at deploy time.
- **LaTeX (`apps/tailor`)** — use **`tectonic`** (Rust, self-contained,
  fetches only needed packages) **over** a full `texlive` install: smaller,
  arm64-friendly, and already the right call on image-size grounds alone.

---

## nipun extraction: extract the TS modules, don't port to Python, don't call
the deployed service

**Extract → `packages/resume-core`** (pure: `types.ts`, `parser.ts`,
`reinject.ts`, `latexSafety.ts`, `properNouns.ts`, `registry.ts`), served by
**`apps/tailor`**, a stateless Fastify service Go/the LangGraph calls over
HTTP.

- *Not* ported to Python: `parser.ts`/`reinject.ts`'s offset arithmetic
  (brace-matching, right-to-left splicing, `verifyKeepIntegrity`'s delta-
  tracking re-walk) is not translatable prose — it must be exactly right or
  a PDF sent to a real employer is silently corrupt. **No existing test
  suite to port parity against** (`scripts/test-resume-pipeline.ts` is
  manual, not automated). Real correctness trap: JS string indices are
  UTF-16 code units, Python's are code points — an LLM emitting an em-dash
  or smart quote diverges the two implementations silently. Port +
  parity-oracle cost: 8–12h vs. 2–3h extraction.
- *Not* called via the deployed Mayankbuilt service: its `/api/*` routes
  have no auth (middleware exempts them), persist nothing, hardcode two
  variants, and would couple this tool's uptime to the portfolio site.

`apps/tailor` routes: `POST /v1/parse {tex} -> {fields[], structured}`,
`POST /v1/validate-nouns {tex, changes[]} -> {flags[]}`, `POST /v1/reinject
{tex, accepted[]} -> {tex, applied[], skipped[], integrityOk}`.

---

## Tracker, outreach, and the Go API surface

```
GET/POST   /api/v1/matches, /matches/:id/{dismiss,track}
POST/GET   /api/v1/applications, /applications/:id, PATCH .../:id
POST       /api/v1/applications/:id/tailor          -> 202 {queueJobId}
GET        /api/v1/artifacts/:id
POST       /api/v1/artifacts/:id/compile             {accepted[]} -> 202
GET        /api/v1/artifacts/:id/pdf
POST       /api/v1/applications/:id/outreach          -> 202
GET/PATCH  /api/v1/outreach, /outreach/:id
POST       /api/v1/outreach/:id/approve
POST       /api/v1/outreach/:id/send                  -> compare-and-set, 409 if not approved
POST       /api/v1/job-search/stop                    -> D-31 purge transaction
GET        /api/v1/events/stream                       -> SSE bridge (D-26)
```
`PATCH /applications/:id` writes `job_application` + `application_event` in
one transaction. **Gmail API**: reuses `google-oauth.ts`'s PKCE flow +
`gmail.send` scope, refresh token in `email_credential` (pgcrypto-
encrypted), Testing publishing mode (Mayank as sole test user, no
verification review needed). Attaches `resume_artifact.pdf_bytes` as a MIME
part.

---

## Dashboard (Next.js + PWA + Capacitor) — 5 screens, zero auth code

Traefik path-routing gives one origin — the dashboard just redirects
unauthenticated users to `/login` and reads the same `js_session` cookie.

1. `/pipeline` — table grouped by status, inline status change, notes.
2. `/applications/[id]` — JD text, signal breakdown, tailor → **diff review
   UI** (per-field accept/reject, proper-noun flags block compile — port
   this one piece out of `ResumeOptimizerTool.tsx`, not the surrounding
   ~900 lines), **live progress via SSE** during tailoring/compiling
   (D-26/D-27's streaming contract), download, draft outreach + review panel.
3. `/matches` — ranked feed, explanation with provenance badges, per-signal
   bars, Dismiss/Track.
4. `/profile` — thin proxy to `PUT /api/v1/profile*`, plus the job-search
   active/stop toggle (D-31) front and center.
5. `/login` — a redirect.

**PWA first** (manifest, service worker, offline shell) — **Capacitor
Android/iOS shells wrap the working PWA as the final packaging step**,
reusing the exact production pattern already shipped at Cenomi Plus/WebKnot,
not a new one learned from scratch.

---

## MCP server (Go, `cmd/mcp`, stdio, `mark3labs/mcp-go`)

Removes dashboard work — search/filters/bulk-edit/company-admin are ~8h of
Next.js that never gets built if Claude can drive the API instead.

Tools: `search_jobs`, `get_match`, `list_pipeline`/`update_application`,
`tailor_resume` (proposed changes only, never compiles), `draft_outreach`
(draft only, never sends), `add_company(careerUrl)` (runs `detectAdapter` +
inserts `career_source` — the highest-leverage tool, only alternative to
raw `psql`).

**Hard rule: no MCP tool sends email or submits an application** — mirrors
decision 3 and PRD §30 directly. Auth via `personal_access_token` (same
`sha256→bytea` scheme as sessions) — MCP binary runs on Mayank's laptop,
calls the API over TLS, no DB port exposed.

---

## Go session-middleware checklist (the highest-risk single integration)

- Cookie holds the **raw** base64url token (43 chars, unsigned) — do not
  unsign in Go.
- `sha256.Sum256([]byte(cookieValue))` — hash the **cookie string**, not
  decoded bytes. Pass raw `[]byte` to pgx → `bytea`, no hex-encoding.
- Reproduce the join exactly: `user_session → app_user (deleted_at IS NULL)
  → account (deleted_at IS NULL) → account_member`, `revoked_at IS NULL AND
  expires_at > now()`. Role comes **live** from `account_member` every
  request, never cached.
- `date` columns: TS pool deliberately keeps `date` as wire string
  (`YYYY-MM-DD`) — match with `to_char(...)` + scan into `string`, don't
  fight pgx's `time.Time` default.
- A committed cross-language fixture
  (`packages/db/test/fixtures/session-tokens.json`, `{rawToken, sha256Hex}`
  pairs) asserted by **both** the vitest and Go suites — highest-leverage
  guard against the most likely catastrophic bug.

> **Done** — see `specs/session-auth.md`. All of the above was verified,
> not just followed.

---

## Testing strategy across four languages

"No mocks for Postgres" (223 existing tests prove this works) + "mocks are
mandatory for paid, nondeterministic LLM calls" — the inverse mistake is
equally wrong.

- **TS**: existing suite unchanged + `resume-core` golden tests (byte-
  identical output, corrupted-output detection — this suite has never
  existed) + `apps/tailor` route tests.
- **Go**: `testing`+`testify`+pgx against the same `pgvector/pgvector:pg16`
  CI container. Must-have: cross-language session-token fixture; cross-
  tenant leakage test on the matcher pool; date round-trip under two `TZ`
  values; queue-interop test (TS worker + Go worker on the same `job_queue`
  concurrently, assert no double-claim); `rank` package table-driven tests.
- **Python**: `pytest` + `FakeLLM` implementing the same protocol + recorded
  fixtures; contract tests asserting malformed LLM output **raises**, never
  passes through; real embedding assertions (`cosine(resume, matching_jd) >
  cosine(resume, unrelated_jd)` as a model-swap regression test); one
  `@pytest.mark.live` suite, skipped by default. **LangGraph-specific**: a
  test driving Graph A's retry loop with a mocked LLM that fails
  provenance-gate twice then succeeds, asserting bounded retries and correct
  `flag_for_manual_review` fallback; a Graph B test asserting an unsupported
  claim is actually stripped, not just flagged.
- **k8s**: `kubeconform`/`kustomize build | kubeconform` in CI validating
  every manifest against the k8s schema before it ever touches the cluster;
  a `dev-k3d` overlay for local apply-and-smoke-test before prod.
- **Cross-service**: `contracts/` dir of committed request/response JSON,
  validated by all languages' type systems.
- **One end-to-end smoke test** (run by the deploy pipeline): login → set
  profile → start job search → paste JD → tailor → approve → compile →
  assert `%PDF` >20KB → create application → draft outreach → assert
  `POST /send` 409s while unapproved → **stop job search → assert all 7
  purge tables are empty for that account** (D-31's actual guarantee,
  tested, not asserted in prose only).
- **CI**: extend `.github/workflows/ci.yml` with `test-go`, `test-py`,
  `contracts`, `k8s-validate` jobs sharing the pgvector service container,
  plus a `deploy` job building multi-arch images and running migrations as
  a discrete pre-deploy step.

> **Partially done**: Go tests exist (using plain `testing`, not `testify` —
> a deliberate deviation, no dependency needed for what these tests do),
> against real Postgres, including the cross-tenant leakage test and a
> genuine queue-interop test (see status note at top). Python tests exist
> with `FakeLLM` + live verification. TS `resume-core` golden tests, k8s
> validation, `contracts/`, and CI extension are all **not started**.

---

## Revised build sequence (no deadline — sized for dependency order, not a schedule)

| Phase | Contents | Size | Why this order |
|---|---|---|---|
| **5.0 — Infra walking skeleton** | Provision Oracle ARM (confirm Hetzner x86 fallback path works too — forces the multi-arch pipeline regardless, D-30). k3s + Traefik + `local-path-provisioner` + `metrics-server` confirmed. Multi-arch `buildx` proven end-to-end on the **existing** Node image → `ghcr.io`. Postgres `StatefulSet`+PVC, existing migrations applied. Namespaces + base Kustomize structure, even with 3 services, so every later addition is "add a manifest." Ingress routing for existing routes, login tested through real Traefik. Backup `CronJob` + **actual restore test**. | M | Retire infra/arm64/Traefik/cookie-routing risk early and cheap, on synthetic data — not saved for the end where a surprise is expensive. |
| **5.1 — Provenance + ephemeral retention schema** | `0009` (D-22 + D-31 combined, per the reasoning above). Stop endpoint + purge transaction. Scheduler dormancy sweep. Embedding column + HNSW index added (unpopulated). RLS + purge-correctness tests for every new table. `setResume()`/`CandidateProfile` refactor for the `resume_upload` split. | M | Every downstream feature needs "is there currently a résumé for this account" as a real precondition; must exist before matching/tailoring are built, not retrofitted after. |
| **5.2 — Go matcher skeleton + non-AI pipeline** | `services/backend` (3 entrypoints, one image). `app_matcher` grants. Hard-constraint prefilter + cheap filtering (D-32's `EXPLAIN ANALYZE` artifact produced here). `job_match` write path. `matcher-api` deployed to k3s. Structured-signal-only ranking (no embeddings/LLM yet). | L | Ships an end-to-end real match list before any AI dependency — de-risks DB/RLS/grant plumbing in isolation. |
| **5.3 — `services/ai`: embeddings + plain sequential chain** | `ai` skeleton, `fastembed` integration, **arm64 buildx smoke test done first** (D-30's flagged risk). Embedding retrieval wired into 5.2. Hybrid retrieval (GIN+RRF). Simple sequential LLM chain for explanation — **not LangGraph yet**. | L | Proves the Go↔FastAPI contract and real cost/latency at the simpler baseline before adding graph complexity on top of an unproven foundation. |
| **5.4 — LangGraph upgrade + resume tailoring** | Replace 5.3's chain with Graph B. `packages/resume-core` extraction (can start in parallel). `apps/tailor` + `resume_source`/`resume_artifact` (D-31-aware). Graph A (full conditional loop) against `resume-core`. | **XL** | The single largest, most novel chunk of new work — new service, new pure-function package, two real graphs. Size it honestly. |
| **5.5 — Event bus + real-time UI** | NATS deployed. D-26/D-27's event catalog wired from real publishers. SSE bridge + `EventSource`. Streaming tailor/explain variants. `matcher-api` HPA added **here**, once real load-shape data exists to size thresholds against. | M | Deliberately after matcher/ai/tailor work synchronously — don't stand up event plumbing before there's anything real to publish. |
| **6 — Frontend + PWA/Capacitor** | Dashboard on CDN. PWA built first; Capacitor wraps it last. SSE-driven live progress bars — the visible payoff for 5.4/5.5. | L | |
| **7 — Application workspace** | Sits on the retention-aware `job_application` table from 5.1. | — |
| **8 — Real email** | Wire `job_search.stopped`/`match.computed` to email now that both the event bus and Gmail integration exist. | — |

---

## Verification (after each phase)

- **5.0**: full login/session round-trip through real HTTPS/Traefik on the
  actual cluster; restore a backup and confirm it boots a working DB.
- **5.1**: create a session, upload a resume, confirm it's queryable; call
  stop; assert all 7 purge tables are empty and `job_search_session` shows
  `stopped`/`user_action`.
- **5.2**: seed two accounts with different profiles, run matching for
  both, confirm feeds differ and the cross-tenant leakage test passes.
- **5.3**: `EXPLAIN ANALYZE` artifact captured and committed; embedding
  cosine-similarity regression test passes.
- **5.4**: curl the full tailor loop — paste JD, propose, approve, compile,
  download, confirm byte-identical outside accepted spans; deliberately
  trigger the fabrication detector and confirm the retry loop + exhaustion
  fallback both work.
- **5.5**: open two browser tabs, trigger a match run, confirm both receive
  the SSE event live.
- **Final**: full test suite (TS+Go+Python+k8s-validate) green in one CI
  run; deploy smoke script green against the live cluster; a real Gmail
  send to a test address, confirmed in Sent + attachment opens.

## Critical files

- `packages/db/migrations/0007_personal_profile.sql` — RLS/grant template
  every new migration must copy exactly; also the file whose `resume_*`
  columns `0009` splits out.
- `packages/db/src/repositories/sessions.ts` + `context.ts` — exact
  validation SQL, `hashToken` contract, `set_config` semantics the Go
  session middleware and `WithAccount` must reproduce.
- `packages/db/src/repositories/queue.ts` — claim/backoff/dedup semantics
  the Go worker must match to safely share `job_queue`.
- `packages/db/src/repositories/profile.ts` — `setResume()`, the function
  Phase 5.1 refactors for the `resume_upload` split.
- `packages/db/src/pool.ts` — the `DATE`-as-wire-string decision.
- `Mayankbuilt/src/lib/resume/reinject.ts` + `parser.ts` — the byte-
  exactness guarantee moving into `packages/resume-core`.
- `docs/GAP_ANALYSIS.md`, `docs/ADR.md` (D-01–D-25 exist) — extend with
  D-22a and D-26–D-32 from this plan; `docs/DEPLOYMENT.md` needs its
  managed-Postgres section marked superseded by D-29, not silently
  contradicted.
