# JobSwitch AI v2 — PRD + High-Level Design

> Doc 1 of the spec set. Read order: **this doc → LLD → DB migrations → API contracts → FE architecture → per-feature spec docs.**
> Each section below ends with a **"What you'll learn building this"** box — that's deliberate. This project is a dual-purpose build: ship a real SaaS, and use it as the vehicle to go from "knows React/Next/Spring Boot" to "SDE2-at-a-funded-startup who actually understands the machine underneath."

---

## 1. Product Vision

A candidate uploads a resume + a list of target companies. The system finds every open role at those companies matching the candidate's skills and experience, drafts an application (form-fill or email), gets one-time approval in dry-run mode, then — once trusted — applies and emails autonomously, notifying the candidate in real time.

**One-line pitch:** "Give it your resume and your dream-company list. It watches those companies forever and applies for you."

## 2. Personas

| Persona | Who | Can do |
|---|---|---|
| **Admin** | You (product owner) | Everything a User can, plus: view all users' accounts/activity, manage global company registry, view crawl health across the whole system, kill-switch any user's auto-apply |
| **User** | Everyone else, including you-as-a-candidate | Upload resume + company list, review/approve dry-run matches, toggle autonomous mode, chat with Amatya, see live unapplied-match count |

## 3. Core User Journey (locked from prior discussion)

1. User uploads resume (PDF/LaTeX source) + a company list (doc/pdf/txt/plain comma-separated names) to their profile.
2. System resolves each company to a crawlable career-page source (existing ATS adapter, or a generic crawl target).
3. System periodically crawls each source, extracts open roles.
4. Each role is matched against the resume on exactly two axes: **skill overlap %** and **years-of-experience fit**. Threshold: skill match ≥ 50%.
5. For a match:
   - If the career page has a direct-apply form → prepare a form-fill action.
   - If it has a careers/HR email → prepare an LLM-drafted email with the tailored resume PDF attached.
   - If neither (LinkedIn-only / login-walled) → **do not auto-anything**. Notify the user; the link is saved and shown in a list they can open and apply to manually.
6. **v1: everything above stops at "proposed."** The user sees a dry-run queue, approves (individually or "approve all"), and only then does the system execute.
7. **v2 (later, per-user toggle):** once a user trusts the system, they flip `auto_apply_enabled`, and proposed actions execute without the manual click.
8. A notification bell shows a **live, real-time unapplied count** (server push, not polling). Clicking it opens **Amatya**, an AI chat assistant that:
   - Keeps history of every link/action across sessions.
   - Lets the user ask about a specific match, re-open a link, or ask "why did/didn't this match."
   - Is the single place the "notify user to apply manually" cases surface.

## 4. Explicit Non-Goals (v1)

- Not scraping LinkedIn/Naukri/AngelList/YC directly (legal risk already discussed — out of scope until a dedicated, isolated Tier-C crawler is built later, off by default).
- Not a general job board — only companies the user explicitly lists.
- Not fully autonomous on day one — dry-run gate is mandatory for v1 (per your decision).
- No unlimited email sending — hard daily cap per user, non-negotiable, protects their Gmail account from spam-flagging.

## 5. Functional Requirements (feature list — each gets its own spec doc later)

| # | Feature | Summary |
|---|---|---|
| F1 | Auth + RBAC | Admin/User roles, session-based auth (reuse existing) |
| F2 | Profile & Resume | Upload resume, parse to structured facts (reuse existing tailor pipeline) |
| F3 | Company List Ingestion | Upload doc/pdf/txt, LLM-assisted parse into company names |
| F4 | Career-Page Resolver | Tiered crawler: known-ATS lookup → generic Playwright+LLM crawl → (later) walled-portal tier |
| F5 | Matching Engine | Deterministic 2-axis skill/experience matcher, no ML needed |
| F6 | Dry-Run & Approval Queue | Proposed actions surfaced to user, approve individually/bulk |
| F7 | Auto-Apply (Form-Fill) | Playwright fills detected apply forms |
| F8 | Auto-Email | LLM-drafted outreach + resume PDF attach, rate-capped Gmail send |
| F9 | Notification System | Event-driven, real-time unapplied-count badge |
| F10 | Amatya (AI Chatbot) | SSE-streamed chat, persists link/action history, answers "why" questions |
| F11 | Admin Console | Cross-account visibility, crawl health, kill-switches |

## 6. Non-Functional Requirements

- **Scale target:** <500 users, a few thousand distinct companies (per your answer) — this is a small-to-mid SaaS, not hyperscale. Architecture should be **simple and correct first**, not prematurely distributed.
- **Reliability:** every crawl attempt logged (reuse `scrape_run` pattern) — silent breakage is the #1 risk in any scraping-dependent product.
- **Safety:** per-user daily email/apply caps enforced server-side, unconditionally.
- **Real-time:** notification count and Amatya chat must be push-based (SSE), not polled.
- **Security:** RLS-per-tenant (reuse existing Postgres role model), admin cross-account access via an explicitly scoped path, never a blanket RLS bypass.

---

## 7. High-Level Design (HLD)

### 7.1 Service boundaries

```
┌─────────────────┐      ┌──────────────────┐      ┌───────────────────┐
│   Next.js Web    │      │  React Native App │      │   PWA (same RN     │
│   (dashboard)    │      │   (Play Store)     │      │   codebase via     │
│                   │      │                    │      │   Expo/RN-Web)     │
└─────────┬────────┘      └─────────┬──────────┘      └─────────┬──────────┘
          │                          │                            │
          └──────────────┬───────────┴────────────────────────────┘
                          │  GraphQL BFF (thin layer, Go)
                          ▼
        ┌─────────────────────────────────────────────────┐
        │              Go API Gateway (REST+GQL)            │
        │   - Auth/session (reuse apps/web pattern)         │
        │   - RBAC middleware                                │
        │   - SSE endpoint (notifications + Amatya stream)  │
        └───────┬───────────┬───────────┬───────────┬───────┘
                │           │           │           │
      ┌─────────▼──┐ ┌──────▼─────┐ ┌───▼──────┐ ┌──▼─────────┐
      │ Crawler Svc│ │ Matcher Svc│ │ Apply Svc│ │ Amatya Svc │
      │   (Go)     │ │   (Go,     │ │  (Go)    │ │ (Go + LLM  │
      │ Playwright │ │  reuse     │ │ Playwright│ │  client)   │
      │  via exec  │ │  existing) │ │ form-fill │ │            │
      │  pool      │ │            │ │ + Gmail   │ │            │
      └─────┬──────┘ └─────┬──────┘ └────┬─────┘ └─────┬──────┘
            │              │             │              │
            └──────────────┴──────┬──────┴──────────────┘
                                   ▼
                   ┌───────────────────────────────┐
                   │  Postgres (RLS) + pgvector      │
                   │  NATS (event bus, already built)│
                   └───────────────────────────────┘
```

Existing services you already have (reused, not rebuilt): `apps/web` (Fastify auth/session), `services/backend` (Go, RRF matching — repurpose its infra for the simpler 2-axis matcher), `apps/tailor` (LaTeX resume compile), `packages/resume-core`, `services/ai` (LangGraph, LLM client), `packages/db` (migrations, RLS roles).

New services: **Crawler Svc**, **Apply Svc**, **Amatya Svc**. GraphQL BFF is a thin new layer, not a rewrite.

### 7.2 Event-driven flow (the part you specifically asked to get right)

Every state change is an **event on NATS**, not a polled DB read. This is the same pattern your existing `events.ts`/SSE bridge already uses — extend it, don't reinvent it.

```
crawl.job_found → matcher consumes → match.computed
match.computed (score ≥ threshold) → apply.proposed
apply.proposed → published to account's NATS subject → SSE → browser/RN app
                                                        → Redux store updates unread count
user approves → apply.approved → apply-svc consumes → executes → apply.completed | apply.failed
apply.completed/failed → SSE → Redux updates
```

**Why this matters for what you're trying to learn:** this is the actual "event-driven architecture" pattern used at real companies — not a buzzword. Events are facts ("this happened"), published once, consumed by whoever cares, replayable from the log if needed. You already half-built this (NATS + SSE) — F9/F10 just extend it to two new event types.

> **What you'll learn here:** pub/sub vs point-to-point messaging, at-least-once delivery semantics (NATS core vs JetStream), why SSE beats polling for a notification badge (one open connection vs N HTTP requests/minute), and how a Redux slice subscribes to a live stream instead of a `useEffect` interval — this is the actual pattern behind "real-time" features in production apps (Slack's unread counts work this way).

### 7.3 State layer (frontend)

- **Redux Toolkit** (not Context, not bare Redux) for global state: unread-count, Amatya chat history, current user/role. RTK Query for server-cache (replaces manual fetch+useState).
- **Why Redux over Zustand here specifically:** you have genuinely global, cross-page, real-time-updated state (notification count must be correct on every page, chat history persists across navigation) — this is Redux's actual sweet spot, not just "the popular choice." Zustand shines for local/feature-scoped state; you'll use it too, just not for this.
- Per-page/local state (form inputs, modal open/close) → `useState`, not Redux. Getting this boundary right is itself an interview-relevant skill (over-using Redux is a classic junior mistake).

### 7.4 Tech stack — final list with the "why" for each

| Layer | Choice | Why |
|---|---|---|
| Backend (new services) | Go | Concurrency-heavy crawl/apply workloads, consolidates with existing Go matcher, closer to funded-startup hiring bar |
| Backend (existing, kept) | Fastify/TS | Already built, working, don't churn it |
| API style | REST (existing) + GraphQL BFF (new, for RN/web shared queries) | Don't migrate what works; add GQL only where flexible nested queries help |
| DB | Postgres + pgvector (existing) | RLS model already proven, reuse |
| AI orchestration | LangGraph (existing, Python `services/ai`) | Reuse graph pattern for company-list parsing, email drafting, Amatya |
| Realtime | NATS (existing) + SSE | Already built, extend |
| FE state | Redux Toolkit + RTK Query | Global real-time state + server cache |
| FE framework | Next.js App Router (existing `apps/dashboard`) | Already built |
| Mobile | React Native (Expo) → also ships as PWA via `react-native-web` | One codebase, two targets |
| Styling | Tailwind (new — dashboard currently hand-CSS) | Standard, fast, matches RN via NativeWind for shared design tokens |
| Docs tooling | Docusaurus or a simple mkdocs setup reading these `.md` files, with mermaid diagram support | You asked for a tool that renders `.md` specs with proper flow diagrams (like Jotform's docs) — Docusaurus with `@docusaurus/theme-mermaid` is the standard choice here; simple to self-host |

---

## 8. What's next in this spec set

1. **LLD** — per-service internals: Crawler Svc job lifecycle, Apply Svc state machine, Amatya Svc's LangGraph design, matcher simplification.
2. **DB migrations** — new tables (`target_company`, `apply_action`, `amatya_thread`, `amatya_message`), RLS policies, new `app_crawler`/`app_admin` roles.
3. **API contracts** — REST + GraphQL schema, SSE event payload shapes.
4. **FE architecture** — folder structure (Next.js App Router + RN), Redux slice design, component/state boundaries, Tailwind/NativeWind setup.
5. **Feature spec docs** (one per F1–F11) — each with the full "what you'll learn" theory section, Go and React examples, before we write a line of implementation code.
6. **Tooling doc** — Jest/RTL test setup, Playwright E2E, ESLint/Prettier, golangci-lint, Husky pre-commit hooks (typecheck + lint + test gate), CI pipeline.

Say **next** and I'll write the LLD.
