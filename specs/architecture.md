# Architecture

## Repository shape

One repository, one Postgres database, growing to four languages
(TypeScript, Go, Python, LaTeX). See `docs/PRD.md` §4 for the product-layer
model (L0–L4); this doc is the implementation shape underneath it.

```
jobswitch-ai/
  apps/                              # pnpm workspace — TypeScript
    web/          Fastify: auth pages, session issuance, /api/v1/profile,
                  /api/v1/job-search/{start,stop,status}
    worker/       Postgres-queue worker: ingest.source handler
    scheduler/    Advisory-locked ticker: enqueues due ATS sources
  packages/
    core/         Domain types, zod schemas, error taxonomy — no I/O
    db/           Postgres pool, migrations, RLS context, repositories
    ingest/       ATS adapter contract + Greenhouse/Lever/Ashby adapters
  services/                          # NOT in the pnpm workspace
    matcher/      Go — matching pipeline (Phase 5.2+)
      cmd/api/       HTTP entrypoint (session validation, /healthz, /readyz)
      cmd/worker/    NOT YET BUILT — will run RunForAccount per active search
      internal/config, db, session, httpx, repo, match, rank
    ai/           Python (uv) — FastAPI, stateless, no DB (Phase 5.3+)
      app/main.py, config, models, embed, llm, explain_service, routers/
      Real fastembed embeddings; LLM explanation chain UNVERIFIED against
      a real provider (no live key in this environment) - see
      specs/embeddings-and-explanation.md. LangGraph not added yet.
  docs/           PRD, ADR, CURRENT_STATE, GAP_ANALYSIS, DEPLOYMENT
  specs/          This directory
```

Each TS package has a strict, one-directional dependency order enforced by
convention (no tooling), not by circular necessity:
`core → db → ingest → apps/*`. `services/matcher` depends on nothing in the
TS side except a shared understanding of the Postgres schema — it is a
separate Go module with its own `go.mod`.

## Database roles

Four Postgres roles, one migration-owner, plus per-environment login roles
granted membership. See `packages/db/migrations/0001_extensions_roles.sql`
and `docs/DEPLOYMENT.md` §2 for exact provisioning SQL.

| Role | RLS? | Used by | Grants |
|---|---|---|---|
| owner (migration role) | Bypasses (table owner) | `pnpm migrate` only | DDL on everything |
| `app_web` | Enforced | `apps/web`, `services/matcher/cmd/api` (session validation only) | Full CRUD on Layer 0/2, SELECT-only on Layer 1, column-restricted writes on `job_match`/`candidate_profile` |
| `app_ingest` | Enforced | `apps/worker`, `apps/scheduler` | Full CRUD on Layer 1 + `job_queue`. **Zero grant on any tenant table** — the one property with its own dedicated test (`packages/db/test/rls.test.ts`) |
| `app_matcher` | **Bypasses** (`ALTER ROLE app_matcher BYPASSRLS`) | `services/matcher/cmd/worker` (not yet built) | SELECT on Layer 1 + profile tables, SELECT/INSERT/UPDATE on `job_queue`, full CRUD on `job_match`/`match_explanation` |

**The one subtlety that has already caused a real bug** (see
`specs/matching-pipeline.md`): `BYPASSRLS` is a role *attribute*, not a
privilege. `GRANT app_matcher TO some_login_role` does **not** give
`some_login_role` bypass — Postgres deliberately excludes role attributes
(`LOGIN`, `SUPERUSER`, `BYPASSRLS`, ...) from what `INHERIT` membership
grants. Every login role that needs to act as the matcher needs its own
explicit `ALTER ROLE ... BYPASSRLS`, in addition to the `GRANT`.

### Two pools in Go, never one

`services/matcher/internal/db.Pools` holds `Web` (RLS-enforced,
`WithAccount` sets `app.current_account_id` per transaction, mirrors
`packages/db/src/context.ts` exactly) and `Matcher` (BYPASSRLS, used only
by the batch worker's per-account loop, explicit `WHERE account_id = $1`
on every query since RLS provides no backstop for this role). Mixing both
privileges into one pooled connection via `SET ROLE` was considered and
rejected — see `internal/db/pool.go`'s doc comment.

## Deployment target (planned, not yet built)

Single-node k3s cluster, Oracle Cloud ARM Ampere (Always Free tier)
primary, Hetzner x86_64 fallback — forcing genuine multi-arch image builds
from day one. Two namespaces (`jobswitch` stateless, `jobswitch-data`
stateful: Postgres StatefulSet+PVC, NATS). Traefik (k3s-bundled) does
path-based routing behind one origin, preserving the existing single-cookie
auth model with no CORS story needed. See `docs/ADR.md` D-29/D-30 for the
full reasoning once those decisions are formally recorded there (currently
only in the build plan — this doc will be updated once D-29/D-30 land in
`docs/ADR.md` proper).

**Nothing is deployed yet.** Every subsystem described in this directory is
built and tested against a local Docker Postgres container. Provisioning
the actual cluster is blocked on external account setup (Oracle Cloud /
Hetzner), not on code.

## Event bus (planned, not yet built)

NATS JetStream for cross-service, cross-language fan-out (a fact multiple
independent consumers care about) and cross-language task handoff — not a
replacement for the existing `job_queue`, which stays for same-language,
single-consumer internal claiming. SSE (not WebSocket) for browser
real-time delivery, since the actual need is unidirectional server→client
push and SSE carries the existing session cookie automatically. Neither
exists in code yet.

## Testing philosophy

No mocks for anything Postgres/RLS/tenancy touches — proven by running
against a real `pgvector/pgvector:pg16` container, locally and in CI. This
has already caught multiple real bugs that review alone would have missed
— each one is documented in the relevant feature spec, not just fixed
silently.

The one deliberate exception is a paid, nondeterministic third party: LLM
calls are tested against a fake implementing the same client interface
(`services/ai/tests/fakes.py`'s `FakeLLM`), never a live provider — a
mocked LLM is the only way to have a deterministic suite, and the
alternative (a live call in CI) would be nondeterministic, slow, and
billed per run. **Embeddings are the opposite case**: `fastembed` runs
locally with no network dependency once its model is cached, so
`specs/embeddings-and-explanation.md`'s tests use the real model — a
mocked embedding would prove nothing about whether it actually produces
sensible vectors, which is the one thing worth testing.
