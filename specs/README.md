# Specs

End-to-end reference documentation, one file per feature or subsystem.
Different purpose from `docs/`:

| Directory | Answers |
|---|---|
| `docs/PRD.md` | What is this product, for whom, what's in/out of scope |
| `docs/ADR.md` | Which architectural decision, and why, numbered (D-01…) |
| `docs/CURRENT_STATE.md` | A point-in-time factual audit (may drift as code changes) |
| `docs/GAP_ANALYSIS.md` | Current vs. proposed, as of one specific audit |
| **`specs/*.md`** | **How one specific feature actually works, kept current as it changes** — schema, code paths, edge cases, known bugs found and how they were fixed, test coverage |

A spec is maintained, not archived: when a feature changes, its spec
changes in the same commit. If a spec and the code disagree, the code is
right and the spec is stale — fix the spec.

## Index

| Spec | Covers |
|---|---|
| [architecture.md](architecture.md) | System-wide shape: layers, services, languages, database roles, deployment target |
| [auth-and-identity.md](auth-and-identity.md) | Signup, login, logout, password reset, Google OAuth, rate limiting, health/readiness |
| [session-auth.md](session-auth.md) | How a session is **validated** on every request after login: the `js_session` cookie, the hash, cross-language parity (TS ↔ Go) |
| [audit-log.md](audit-log.md) | The append-only `audit_log` table: what's written, what isn't, why writes never block the action they're logging |
| [ingestion.md](ingestion.md) | ATS adapters, the job index, the Postgres queue, the scheduler |
| [profile-and-provenance.md](profile-and-provenance.md) | Candidate profile, skills, experience, the fact-provenance model (D-22) |
| [ephemeral-retention.md](ephemeral-retention.md) | Job search sessions, résumé storage, the D-31 purge mechanic |
| [matching-pipeline.md](matching-pipeline.md) | The Go matcher service: hard constraints, structured ranking, `job_match` |
| [embeddings-and-explanation.md](embeddings-and-explanation.md) | The Python `services/ai`: real `fastembed` embeddings, LLM match explanations, the provenance gate |

**Coverage status**: every backend feature built through Phase 5.3 has a
spec. Not yet covered because not yet built: the Next.js dashboard
(Phase 6), the application workspace (Phase 7), résumé tailoring/LangGraph
(Phase 5.4), event bus/SSE (Phase 5.5), Kubernetes deployment (Phase 5.0).
Each gets a spec when it's built, not before.

## Writing a new spec

One file per feature, not per phase or per PR. A feature spec should let
someone who has never read the code answer: what does this do, where does
the code live, what does the schema look like, what are the known sharp
edges, and how is it tested. Include real bugs found during development and
how they were actually fixed — that history is part of the feature's
end-to-end story, not a separate changelog.
