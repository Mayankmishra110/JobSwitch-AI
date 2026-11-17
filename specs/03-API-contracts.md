# JobSwitch AI v2 — API Contracts

> Doc 4 of the spec set. Covers REST additions to the existing `apps/web` API, the new GraphQL BFF schema, and the exact SSE event payloads the frontend subscribes to.

> **What you'll learn here:** designing a contract *before* writing the handler is the actual discipline behind "API-first development" — it's what lets frontend and backend work in parallel without one blocking the other, and it's exactly what a well-run startup does before a feature gets built (this is also literally what an OpenAPI/GraphQL SDL file is for — a machine-checkable version of this doc).

---

## 1. REST additions (extends existing `apps/web` route table)

All new routes follow your existing conventions exactly: `/api/v1/...`, cookie session auth via `requireAuth`, Zod validation, the existing error-handler shape (`AppError` → JSON `{error, message}`).

### Company targets (F3)

```
POST   /api/v1/companies/upload
  multipart/form-data: file (pdf|docx|txt|csv)
  → 202 { jobId: uuid }   // parsing is async (LLM-assisted extraction)
  → subscribe to SSE event `companies.parsed` for the result

GET    /api/v1/companies
  → 200 { companies: TargetCompany[] }

DELETE /api/v1/companies/:id
  → 204
```

```ts
interface TargetCompany {
  id: string;
  rawName: string;
  status: 'pending' | 'resolved_ats' | 'resolved_generic' | 'dead';
  deadReason?: string;
  resolvedAt?: string;
}
```

### Gated matches (F5)

Read-only. The 2-axis apply-gate (`gated_match`), not the v1 RRF feed (`GET /api/v1/matches`). No approve/reject here — that is F6.

```
GET    /api/v1/gated-matches?eligible=true|false
  → 200 { matches: GatedMatch[] }
```

```ts
interface GatedMatch {
  id: string;
  jobPostingId: string;
  jobPostingVersionId: string;
  title: string;
  company: string | null;
  applyUrl: string;
  skillMatchPct: number;
  skillsMatched: string[];
  skillsMissing: string[];
  experienceFit: boolean;
  eligible: boolean;
  ineligibleReason:
    | 'no_jd_skills'
    | 'skill_below_threshold'
    | 'experience_mismatch'
    | 'candidate_years_unknown'
    | null;
  candidateYears: number | null;
  jdMinYears: number | null;
  jdMaxYears: number | null;
  computedAt: string;
}
```

Contract detail lives in `F05-matching-engine/SPEC.md` §6. v1 `GET /api/v1/matches` is unchanged.

### Apply actions / dry-run queue (F6, F7, F8)

```
GET    /api/v1/apply-actions?status=proposed
  → 200 { actions: ApplyAction[], unappliedCount: number }

POST   /api/v1/apply-actions/:id/approve
  → 200 { action: ApplyAction }   // status: proposed → approved, enqueues execution

POST   /api/v1/apply-actions/:id/reject
  → 200 { action: ApplyAction }

POST   /api/v1/apply-actions/approve-bulk
  body: { ids: string[] }
  → 200 { approved: number, failed: string[] }   // partial failure is reported, not silently swallowed

PATCH  /api/v1/profile/settings
  body: { autoApplyEnabled?: boolean, dailyEmailCap?: number }
  → 200 { settings: ProfileSettings }
```

```ts
interface ApplyAction {
  id: string;
  jobPostingId: string;
  companyName: string;      // joined for display
  jobTitle: string;         // joined for display
  mode: 'form_fill' | 'email' | 'manual';
  status: 'proposed' | 'approved' | 'rejected' | 'executing' | 'applied' | 'failed';
  skillMatchPct: number;
  skillsMatched: string[];
  skillsMissing: string[];
  experienceFit: boolean;
  draftSubject?: string;    // mode=email only
  draftBody?: string;       // mode=email only, shown for review before send
  lastError?: string;
  proposedAt: string;
  executedAt?: string;
}
```

**Design decision worth noting explicitly:** `approve-bulk` returns a partial-failure shape (`{approved: number, failed: string[]}`) rather than an all-or-nothing 200/500 — because approving 40 items where 2 have gone stale (job closed since proposal) is a completely normal case, not an exceptional one. Designing an endpoint's response shape around "what does the caller actually need to do next" rather than "success or exception" is a small thing that separates thoughtful API design from a REST-CRUD-tutorial default.

### Amatya chat (F10)

```
GET    /api/v1/amatya/threads
  → 200 { threads: AmatyaThread[] }

GET    /api/v1/amatya/threads/:id/messages
  → 200 { messages: AmatyaMessage[] }

POST   /api/v1/amatya/threads/:id/messages
  body: { content: string }
  → 202 { messageId: uuid }   // response streams via SSE `amatya.token`, not in this response body
```

**Why 202, not 200 with the answer inline:** an LLM response is not instant — returning `202 Accepted` and streaming the actual tokens over SSE is the correct HTTP semantic for "request accepted, result comes asynchronously," and it's the same pattern ChatGPT's own API uses under the hood (`stream: true` + SSE). Returning a blocking 200 here would mean holding an HTTP connection open for the full LLM generation time — works, but is the wrong tool (ties up a connection/thread for no reason when SSE already exists for this).

### Admin console (F11)

```
GET    /api/v1/admin/accounts
  → requires role=admin, else 403
  → 200 { accounts: AccountSummary[] }

GET    /api/v1/admin/crawl-health
  → 200 { sources: CrawlHealthRow[] }   // last crawl_run per career_source, failure streaks

POST   /api/v1/admin/accounts/:id/kill-switch
  body: { autoApplyEnabled: false }   // true → 400; admin cannot remotely enable
  → 200
```

---

## 2. GraphQL BFF schema (new, thin layer — see HLD §7.4 for why)

Purpose: the RN app and PWA share this schema so they don't each hand-roll REST call sequences for composite screens (e.g., the dashboard home screen needs unapplied count + recent activity + profile summary in one round trip — a natural GraphQL query, an awkward 3-endpoint REST waterfall).

```graphql
type Query {
  me: User!
  dashboardSummary: DashboardSummary!
  applyActions(status: ApplyActionStatus): [ApplyAction!]!
  amatyaThreads: [AmatyaThread!]!
}

type Mutation {
  approveApplyAction(id: ID!): ApplyAction!
  rejectApplyAction(id: ID!): ApplyAction!
  sendAmatyaMessage(threadId: ID!, content: String!): ID!  # returns messageId; response still streams via SSE
  updateProfileSettings(autoApplyEnabled: Boolean, dailyEmailCap: Int): ProfileSettings!
}

type DashboardSummary {
  unappliedCount: Int!
  recentActions: [ApplyAction!]!
  profile: ProfileSummary!
}

type ApplyAction {
  id: ID!
  jobPostingId: ID!
  companyName: String!
  jobTitle: String!
  mode: ApplyActionMode!
  status: ApplyActionStatus!
  skillMatchPct: Float!
  skillsMatched: [String!]!
  skillsMissing: [String!]!
  experienceFit: Boolean!
  draftSubject: String
  draftBody: String
  proposedAt: String!
}

enum ApplyActionMode { FORM_FILL EMAIL MANUAL }
enum ApplyActionStatus { PROPOSED APPROVED REJECTED EXECUTING APPLIED FAILED }
```

**Implementation note:** this GraphQL layer is a **resolver-as-thin-proxy** over the existing Go REST/service calls — it does not talk to Postgres directly. This avoids the classic GraphQL-in-a-microservices-world trap (N+1 queries fanning out across services with no batching) while you're still small enough that a proxy layer is simple and correct. If/when you actually need field-level resolvers hitting the DB directly, that's a deliberate later step (with DataLoader-style batching), not a v1 concern at <500 users.

> **What you'll learn here:** the REST-vs-GraphQL decision in this project is a real, defensible one you can explain: GraphQL solves *client-side over/under-fetching across composite screens*, not "make my API modern." Using it as a thin BFF proxy rather than the primary data-access layer is itself a legitimate, commonly-used pattern (this is literally what a "Backend For Frontend" architecture is) — know the term, it comes up in system-design interviews constantly.

---

## 3. SSE event payloads (the real-time contract)

All events flow over the existing `GET /api/v1/events/stream` bridge, one NATS subject per account, exactly as your current `resume.tailoring.*` / `outreach.draft.created` events already do. New event types:

```ts
// Emitted whenever a new proposed apply_action is created (or its status changes)
interface ApplyActionEvent {
  type: 'apply.proposed' | 'apply.approved' | 'apply.executing' | 'apply.applied' | 'apply.failed';
  actionId: string;
  unappliedCount: number;   // always included — this is what the Redux badge subscribes to directly
}

// Emitted per LLM token during an Amatya response
interface AmatyaTokenEvent {
  type: 'amatya.token';
  threadId: string;
  messageId: string;
  token: string;
  done: boolean;   // true on the final event for this message
}

// Emitted when async company-list parsing finishes (F3's upload endpoint)
interface CompaniesParsedEvent {
  type: 'companies.parsed';
  jobId: string;
  companies: { rawName: string; status: string }[];
}

// Emitted after F5 writes gated_match rows for one account (best-effort).
// Not the unappliedCount source — that still rides ApplyActionEvent (F6/F9).
interface MatchGatedComputedEvent {
  type: 'match.gated.computed';
  accountId: string;
  eligibleCount: number;
  ineligibleCount: number;
}
```

**Why `unappliedCount` rides inside every `ApplyActionEvent` rather than being computed client-side by counting:** the client should never have to reconstruct derived state by counting a list it's incrementally received over a stream — that's a well-known source of drift bugs (a missed event = a permanently wrong count). The server computes the authoritative count and pushes it every time; the Redux reducer for this slice is then a trivial `state.unappliedCount = action.payload.unappliedCount`, not an accumulator. This single decision is what makes the "real-time count" feature actually correct under packet loss/reconnect, not just correct in the happy path.

---

## 4. Error contract (consistent across REST + GraphQL)

Reuses your existing `AppError` shape:

```ts
interface ApiError {
  error: string;       // machine-readable code, e.g. "DAILY_CAP_EXCEEDED"
  message: string;      // human-readable
  details?: unknown;
}
```

New error codes this feature set introduces: `DAILY_CAP_EXCEEDED`, `COMPANY_ALREADY_TARGETED`, `APPLY_ACTION_STALE` (job closed since proposal), `TIER_C_NOT_ENABLED`.

---

## What's next

**FE architecture** — Next.js App Router folder structure, React Native/Expo project layout, the actual Redux Toolkit slice design for `apply-actions` and `amatya`, RTK Query API layer, and where Tailwind/NativeWind boundaries sit.

Say **next** for that.
