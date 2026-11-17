# F3 — Company List Ingestion (Feature Spec)

> Doc 7 of the spec set. Build this second — it produces the `target_company` rows that the crawler (F4) consumes, so nothing downstream can be tested without it.

---

## 1. User Story

> As a **user**, I upload a `.pdf`, `.docx`, `.txt`, or paste comma-separated text containing company names. The system extracts each company, resolves it to a real crawlable career page, and tells me which ones it couldn't find — so I know exactly what it's watching for me.

## 2. Acceptance Criteria

| # | Criterion |
|---|---|
| AC1 | Upload accepts `.pdf`, `.docx`, `.txt`, `.csv`, and raw pasted text |
| AC2 | Parsing is **async** — the upload endpoint returns `202 {jobId}` immediately, results arrive via SSE `companies.parsed` |
| AC3 | Duplicate company names within one account are deduped case-insensitively (enforced by the unique index in migration 0019, not just app logic) |
| AC4 | Every extracted name produces a `target_company` row with `status='pending'`, even if resolution later fails — the user sees what was attempted |
| AC5 | A company that can't be resolved gets `status='dead'` with a human-readable `dead_reason`, shown in the UI |
| AC6 | A malformed/empty/garbage file returns a clear error, not a partial silent import |
| AC7 | File size cap enforced (suggest 5MB) — reject above it before parsing |

## 3. Implementation

### 3.1 Flow

```
POST /api/v1/companies/upload (multipart)
      │
      ▼
 [Go handler]
  1. Validate content-type + size cap
  2. Store the raw bytes temporarily (or stream straight through)
  3. Extract plain text by file type:
       .txt/.csv  → read directly
       .pdf       → reuse existing pdf-reading capability, or a Go lib (ledongthuc/pdf)
       .docx      → unzip + parse word/document.xml (or a lib: nguyenthenguyen/docx)
  4. Enqueue `companies.parse` job with the extracted text
  5. Return 202 {jobId}
      │
      ▼
 [Worker: companies.parse]
  1. Call services/ai POST /v1/extract/companies  (new LangGraph endpoint)
       → returns ["Stripe", "Ramp", "Vercel", ...]
  2. Insert target_company rows (ON CONFLICT DO NOTHING — dedup per AC3)
  3. Enqueue one crawl.resolve_company job per new row  (hands off to F4)
  4. Publish SSE event `companies.parsed`
```

### 3.2 Why an LLM for extraction (and where it's overkill)

**Use the LLM when:** the input is a prose document — a PDF of a "top 100 startups" list, a docx with bullet points and descriptions, a messy export. Regex/CSV-splitting fails immediately on these.

**Skip the LLM when:** the input is already clean comma-separated text or a single-column CSV. Detect this cheaply first (does splitting on commas/newlines yield short, title-case-ish tokens with no sentences?) and skip straight to the DB insert. This saves a paid API call on the most common case.

```go
// A cheap pre-check before spending an LLM call.
func looksLikeCleanList(text string) bool {
    parts := splitOnCommasAndNewlines(text)
    if len(parts) == 0 { return false }
    for _, p := range parts {
        p = strings.TrimSpace(p)
        if p == "" { continue }
        // Company names are short and sentence-free. A "part" with a
        // period-space or more than ~5 words is prose, not a list entry.
        if len(strings.Fields(p)) > 5 || strings.Contains(p, ". ") {
            return false
        }
    }
    return true
}
```

> **What you'll learn here:** "use an LLM only where cheaper deterministic logic fails" is a recurring architectural judgement in this whole product (you'll hit it again in F5's matcher and F10's intent classifier). Being able to articulate *when not to use AI* is a differentiator — plenty of engineers can wire up an API call; fewer can defend not making one.

### 3.3 The LangGraph extraction endpoint

New endpoint in `services/ai`, following the exact conventions of your existing `/v1/tailor/resume` and `/v1/match/explain`:

```
POST /v1/extract/companies
  body: { text: string }
  → { companies: string[], model: string, prompt_version: int }
```

Graph shape (simple — two nodes, no retry loop needed since there's no fabrication risk to gate on):

```
extract_names → normalize_names → END
```

`normalize_names` is deterministic Python, not an LLM call: strip legal suffixes (`Inc.`, `Ltd`, `Pvt Ltd`), trim whitespace, title-case. Keeping normalization out of the LLM makes it testable and free.

### 3.4 Company resolution (handoff to F4)

`target_company.status` transitions:

```
pending ──► resolved_ats      (matched an existing career_source in your Layer 1 tables — free, no crawl)
        ──► resolved_generic  (found a live careers page via HEAD probe)
        ──► dead              (no career page found; dead_reason recorded)
```

Resolution order matters for cost: **always check your existing `company`/`career_source` tables first.** If 200 users all target Stripe, and Stripe is already a known Greenhouse board in your Layer 1 index, that's 200 `resolved_ats` rows and **zero** crawls. This dedup-by-shared-index is the single biggest cost lever in the whole product.

## 4. Frontend (per `04-FE-architecture.md`'s structure)

```
apps/dashboard/src/app/companies/
├── page.tsx                  # Server Component — initial list via apiServer.ts
├── actions.ts                # Server Action: uploadCompanyList, deleteCompany
├── CompanyUploadForm.tsx     # Client — file input, useActionState for pending/error
└── CompanyList.tsx           # Client — subscribes to SSE companies.parsed, shows status badges
```

Status badges map directly to the enum: `pending` (grey, spinner), `resolved_ats` (green, "watching"), `resolved_generic` (blue, "watching"), `dead` (red, with `dead_reason` on hover).

## 5. Test Cases

### Go unit
```
TestLooksLikeCleanList_CleanCSV_ReturnsTrue
TestLooksLikeCleanList_ProseDocument_ReturnsFalse
TestExtractText_PDF / _DOCX / _TXT
TestUploadHandler_RejectsOversizeFile
TestUploadHandler_RejectsUnsupportedMimeType
```

### Python (services/ai)
```
test_extract_companies_from_prose
test_normalize_strips_legal_suffixes       # "Stripe, Inc." → "Stripe"
test_extract_companies_empty_text_returns_empty_list
```

### Integration (real Postgres)
```
TestCompanyUpload_DedupesCaseInsensitively           # AC3 — "stripe" + "Stripe" = one row
TestCompanyUpload_RLS_UserSeesOnlyOwnCompanies
TestResolveCompany_KnownATS_SkipsCrawl               # the cost lever — assert no crawl job enqueued
TestResolveCompany_NoCareerPage_MarksDeadWithReason
```

### E2E (Playwright)
```
upload a .txt with 3 companies → see 3 pending badges →
  (after worker runs) → 2 resolved, 1 dead with visible reason
```

---

## 6. What you'll learn building this

- **Async job + SSE result pattern** — the correct shape for any operation too slow for a request/response cycle. This exact pattern (202 + job ID + push notification on completion) is how every file-processing, report-generation, and import feature in production software works. Contrast it with the naive blocking-request version and know why that breaks (request timeouts, no progress feedback, retries re-do all the work).
- **File parsing in Go** — PDF and DOCX are both *container formats*, not text. DOCX is literally a ZIP of XML (rename one to `.zip` and look inside — do this once, it demystifies the whole thing). PDF is far messier (a graphics format that happens to contain text runs, with no guaranteed reading order). Understanding *why* PDF text extraction is unreliable is genuinely useful knowledge.
- **Idempotency via DB constraints, not app logic** — AC3's dedup is enforced by a unique index with `ON CONFLICT DO NOTHING`, not by a `SELECT` -then- `INSERT` in the handler. The latter has a race condition (two concurrent uploads both see "not there," both insert). Constraints are the only race-free option. **This is a classic interview question** ("how do you prevent duplicate submissions?") and you'll have built the correct answer.
- **Cost-aware architecture** — the "check the shared index before crawling" decision in §3.4 is a real engineering-for-cost choice. Being able to say "this one lookup order saves ~99% of crawl cost at scale" in an interview is exactly the kind of thinking that separates SDE2 from SDE1.

---

## 7. Definition of Done

- [ ] Migration 0019 applied (`target_company`, `crawl_run`)
- [ ] Upload endpoint with size/mime validation + text extraction for all 4 formats
- [ ] `companies.parse` worker + `/v1/extract/companies` LangGraph endpoint
- [ ] Clean-list fast path (skips LLM) implemented and tested
- [ ] Resolution checks existing `career_source` before probing (cost lever verified by test)
- [ ] SSE `companies.parsed` event wired to the FE list
- [ ] All tests in §5 green
- [ ] Pre-commit hook passing

---

Next specs: **F4 (Career-Page Resolver / Crawler)** and **F5 (Matching Engine)**.
