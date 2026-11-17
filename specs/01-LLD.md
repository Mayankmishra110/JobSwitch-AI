# JobSwitch AI v2 — Low-Level Design (LLD)

> Doc 2 of the spec set. Assumes `00-PRD-and-HLD.md` is read. This doc goes inside each new service: exact job lifecycles, state machines, and the Go/Python patterns behind them — with the theory that makes each pattern make sense, not just the shape.

---

## 1. Crawler Svc (Go)

### 1.1 Job lifecycle

Reuses your existing `job_queue` table (Postgres `FOR UPDATE SKIP LOCKED`) — no new queue tech. Two new queue names: `crawl.resolve_company` and `crawl.fetch_postings`.

```
target_company (status: pending)
        │
        ▼
enqueue crawl.resolve_company
        │
        ▼
┌───────────────────────────────────────────┐
│ resolveCompany(company)                     │
│  1. Check ats_platform/career_source        │
│     (existing table) for a known domain     │
│     match → if found: status=resolved_ats,  │
│     done, reuse existing Greenhouse/Lever/  │
│     Ashby adapter forever.                  │
│  2. Else: HTTP HEAD the likely careers URL  │
│     (company.com/careers, /jobs, /careers)  │
│     → if 200: status=resolved_generic,      │
│     enqueue crawl.fetch_postings            │
│  3. Else: status=dead, log reason           │
└───────────────────────────────────────────┘
        │
        ▼ (only for resolved_generic)
┌───────────────────────────────────────────┐
│ fetchPostings(source)                       │
│  1. Acquire a Playwright browser context     │
│     from the pool (see 1.2)                 │
│  2. Navigate, wait for network-idle          │
│  3. Extract raw HTML/text of the page        │
│  4. Send to services/ai's new                │
│     /v1/extract/postings endpoint            │
│     (LangGraph: HTML → structured list of    │
│     {title, url, apply_form_detected,        │
│      email_found})                            │
│  5. Upsert into job_posting (existing table, │
│     source_type='generic_crawl')             │
│  6. Write a crawl_run row (same shape as     │
│     scrape_run — reuse the pattern, don't    │
│     invent a new one)                        │
└───────────────────────────────────────────┘
```

Re-run cadence: same `next_run_at` pattern as `career_source` — generic sources get a longer default interval (12–24h) than ATS sources (which are cheap API calls and can run hourly), because headless browser runs are the expensive resource here.

### 1.2 Browser pool — the actual Go concurrency pattern

This is the part directly relevant to "SDE2 Go fluency." A naive "spawn a goroutine per crawl job" approach will OOM your box the first time 200 companies are due at once — Playwright browser instances are heavy (~100-300MB each). You need a **bounded worker pool**.

```go
// crawler/pool.go
package crawler

import (
    "context"
    "sync"
)

// Pool bounds concurrent browser instances. This is the classic
// "worker pool" pattern: N goroutines pull work from a channel,
// so you never have more than N browsers alive regardless of how
// many jobs are queued.
type Pool struct {
    sem chan struct{} // a buffered channel used as a counting semaphore
}

func NewPool(maxConcurrent int) *Pool {
    return &Pool{sem: make(chan struct{}, maxConcurrent)}
}

// Acquire blocks until a slot is free, or ctx is cancelled.
// This is the goroutine-safe way to say "wait your turn" —
// no mutex needed because channel send/receive is already
// safe for concurrent use.
func (p *Pool) Acquire(ctx context.Context) error {
    select {
    case p.sem <- struct{}{}:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

func (p *Pool) Release() {
    <-p.sem
}
```

Usage in the worker loop (mirrors your existing `runLoop` in `services/backend/cmd/worker/main.go` — same claim/execute/complete shape, just with a pool gate added):

```go
pool := crawler.NewPool(8) // 8 concurrent browser contexts, tune by RAM

for {
    job, err := queue.Claim(ctx, dbPool, []string{"crawl.fetch_postings"}, workerID, 5*time.Minute)
    if job == nil { sleep(idleDelay); continue }

    wg.Add(1)
    go func(j *queue.Job) {
        defer wg.Done()
        if err := pool.Acquire(ctx); err != nil { return }
        defer pool.Release()

        if err := fetchPostings(ctx, j); err != nil {
            queue.Fail(ctx, dbPool, *j, err, queue.FailOptions{})
            return
        }
        queue.Complete(ctx, dbPool, j.ID)
    }(job)
}
```

> **What you'll learn here:** the counting-semaphore-via-buffered-channel idiom is one of the most-asked-about Go interview patterns (right after "explain a goroutine leak"). You're also seeing why Go's concurrency primitives (channels + `select`) replace what you'd need a `Semaphore`/`ExecutorService` class for in Java — same idea, radically less ceremony. Compare this mentally to how you'd write it in Spring Boot with a `ThreadPoolTaskExecutor` — worth doing once as a side-by-side note for your own interview prep.

### 1.3 Tier C (walled portals) — isolation detail

Separate Go binary (`crawler-tier-c`), separate deployment, separate outbound IP (different VPS or at minimum different NAT egress), separate Postgres role (`app_crawler_tier_c`) with **zero** grants beyond its own `tier_c_session` table. Off by default (`account.tier_c_enabled = false`). This is a hard architectural wall, not a feature flag inside the same process — the entire point is that if this gets an IP banned, it cannot take Tier A/B down with it.

---

## 2. Matcher Svc — simplification of existing `services/backend`

> **Superseded as a contract by [`F05-matching-engine/SPEC.md`](F05-matching-engine/SPEC.md).** This section remains as the original sketch (same service binary, new smaller function, no embeddings in the *decision*). F05 is the source of truth for signature, empty-JD behaviour, nullable candidate years, sibling table `gated_match` (not columns on `job_match`), JD skills coming from `jd_extraction` + a Go parser, and skipping `needs_confirmation=true`. Do not implement from the Go block below.

You already have a 7-signal RRF-based ranker. For this feature, don't reuse the full pipeline — the 2-axis requirement is deliberately simpler and more explainable. New, smaller function, same service binary. Historical sketch (bugs called out in F05 §2: non-nullable `candidateYears`, divide-by-zero on empty `jdSkills`):

```go
// match/simple.go — SKETCH ONLY. See F05 §7.1 for the actual function.
package match

type SimpleMatchResult struct {
    SkillMatchPct   float64
    SkillsMatched   []string
    SkillsMissing   []string
    ExperienceFit   bool
    Eligible        bool // SkillMatchPct >= 0.5 && ExperienceFit
}

func ComputeSimpleMatch(candidateSkills []string, jdSkills []string, candidateYears int, jdMinYears, jdMaxYears *int) SimpleMatchResult {
    matched, missing := intersect(candidateSkills, jdSkills)
    pct := float64(len(matched)) / float64(len(jdSkills))

    fit := true // no stated range = no filter
    if jdMinYears != nil && candidateYears < *jdMinYears { fit = false }
    if jdMaxYears != nil && candidateYears > *jdMaxYears { fit = false }

    return SimpleMatchResult{
        SkillMatchPct: pct,
        SkillsMatched: matched,
        SkillsMissing: missing,
        ExperienceFit: fit,
        Eligible:      pct >= 0.5 && fit,
    }
}
```

No embeddings, no LLM call, no `pgvector` needed for this decision — deterministic, instant, and — critically for a product that auto-applies on your behalf — **fully explainable to the user** ("matched 6/10 skills: Go, Postgres, Docker... missing: Kubernetes, gRPC"). Save the LLM budget for the extraction and drafting steps, where it's actually earning its cost. F05 allows an LLM only to *fill* `jd_extraction` before this function runs.

> **What you'll learn here:** this is a real product/engineering tradeoff, not a shortcut — knowing *when not* to reach for embeddings/ML and use plain deterministic logic instead is a stronger signal in an interview than knowing how to wire up a vector DB. Interviewers probe for this explicitly ("would you use an LLM for X? why or why not?").

---

## 3. Apply Svc — the state machine

### 3.1 States (`apply_action.status`)

```
proposed ──(user approves, mode≠manual)──► approved ──► executing ──┬─► applied
   │                                                                └─► failed ──(retry, capped)──► executing
   ├──(user rejects)──► rejected
   └──(mode=manual, user mark-applied)──► applied

auto_apply_enabled: still INSERT proposed, then proposed→approved in the same txn
                    (never skip the row). Never auto-executes mode=manual.
```

Mode is `form_fill | email | manual` — see `F06-dryrun-approval-queue/SPEC.md`. The sketch below omitted `manual`; do not implement from this section alone.

Modeled as a Go type-safe enum with a transition-guard function — reject illegal transitions at the code level, not just via a DB `CHECK` constraint (defense in depth, same philosophy your DB layer already uses):

```go
type ApplyStatus string

const (
    StatusProposed  ApplyStatus = "proposed"
    StatusApproved  ApplyStatus = "approved"
    StatusRejected  ApplyStatus = "rejected"
    StatusExecuting ApplyStatus = "executing"
    StatusApplied   ApplyStatus = "applied"
    StatusFailed    ApplyStatus = "failed"
)

var validTransitions = map[ApplyStatus][]ApplyStatus{
    StatusProposed:  {StatusApproved, StatusRejected, StatusExecuting}, // executing only if auto_apply_enabled
    StatusApproved:  {StatusExecuting},
    StatusExecuting: {StatusApplied, StatusFailed},
    StatusFailed:    {StatusExecuting}, // capped retry
}

func CanTransition(from, to ApplyStatus) bool {
    for _, allowed := range validTransitions[from] {
        if allowed == to { return true }
    }
    return false
}
```

### 3.2 Execution — form-fill vs email branches on `apply_action.mode`

- **`mode=form_fill`**: Playwright fills detected fields from the resolved schema (see `04-API-contracts.md` for the field-detection payload shape) → submits → screenshots the confirmation page (stored as proof, same reasoning as `resume_artifact.pdf_bytes` being kept for audit) → `applied`.
- **`mode=email`**: calls `services/ai`'s new email-draft graph → gets subject+body → reuses **existing** `gmailSend.ts`-equivalent Go client (port the MIME-building logic, or call the existing Fastify endpoint internally — cheaper to reuse than rewrite) → attaches `resume_artifact.pdf_bytes` → checks the daily cap (see 3.3) → sends → `applied`.

### 3.3 Daily cap enforcement — non-negotiable per the PRD

```go
func CanSendMoreToday(ctx context.Context, db *pgxpool.Pool, accountID string) (bool, error) {
    var count int
    err := db.QueryRow(ctx,
        `SELECT count(*) FROM apply_action
         WHERE account_id = $1 AND mode = 'email' AND status = 'applied'
           AND created_at >= date_trunc('day', now())`,
        accountID,
    ).Scan(&count)
    return count < dailyEmailCap, err
}
```

Checked at the moment of execution (not at proposal time — proposals can pile up freely, execution is throttled), enforced server-side so no client bug or malicious client can bypass it.

---

## 4. Amatya Svc — LangGraph design

### 4.1 Graph shape (mirrors your existing `explain_graph.py`/`tailor_graph.py` pattern — same shop, same conventions)

```
                    ┌──────────────┐
   user message ──► │ classify_intent│
                    └──────┬───────┘
                           │
        ┌──────────────────┼───────────────────┐
        ▼                  ▼                    ▼
 ┌─────────────┐  ┌─────────────────┐  ┌──────────────────┐
 │ answer_why   │  │ list_unapplied   │  │ general_chat      │
 │ (why did/    │  │ (pulls           │  │ (fallback, still  │
 │  didn't X    │  │  apply_action    │  │  grounded in the  │
 │  match)      │  │  status=proposed)│  │  user's own data) │
 └──────┬──────┘  └────────┬────────┘  └─────────┬─────────┘
        └──────────────────┼─────────────────────┘
                           ▼
                    ┌──────────────┐
                    │ respond_stream│  ── SSE tokens back to client
                    └──────────────┘
```

`classify_intent` is a small, cheap LLM call (or even a regex/keyword pre-filter before falling back to LLM — cheaper, and a good "when do you NOT need an LLM" example again). `answer_why` is the most interesting node: it pulls the exact `SimpleMatchResult` (skills matched/missing, stored on the **`gated_match` row**, not v1 `job_match` — see F05/F10) and hands it to the LLM as **grounding context**, so the answer is a real explanation, not a hallucinated one — same fact-safety principle your existing `provenance_gate` nodes already enforce elsewhere in this codebase.

### 4.2 Persistence

`amatya_thread` (one per account, or one per topic if you want threading later) + `amatya_message` (role: user/assistant, content, created_at, and — critically — a nullable `linked_apply_action_id` so "the link" a message references is queryable, not just prose the user has to re-read to find).

### 4.3 Streaming to the client

SSE, same bridge as your existing `events.ts` — Amatya's response tokens are just another event type on the account's NATS subject (`amatya.token`), consumed by the same `GET /api/v1/events/stream` your dashboard already has, no new transport needed.

> **What you'll learn here:** this is the real shape of production LLM chat features — not a naive "call OpenAI, stream the HTTP response directly to the browser" (which breaks the moment you want multiple tabs/devices in sync, or want the mobile app to see the same stream). Routing LLM output through your existing event bus, same as any other domain event, is the more robust pattern and it's *free* here since you already built the bus.

---

## 5. What's next

**DB migrations** — the exact new tables (`target_company`, `apply_action`, `amatya_thread`, `amatya_message`, `crawl_run`), new roles (`app_crawler`, `app_crawler_tier_c`), and RLS policies, written as real `.sql` migration files in the same numbered style as your existing 17.

Say **next** for that.
