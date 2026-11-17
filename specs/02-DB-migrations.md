# JobSwitch AI v2 — Database Migrations

> **Numbering superseded — read before using any number in this doc.** This doc originally continued 0001–0017 with 0018 onward, assuming F03/F04/F07/F08/F10 (the crawler/apply/amatya feature set) would be the first new migrations written. They aren't — F01 and F02 ship first, per `specs/README.md`'s build order, and since nothing past 0017 was ever actually applied to a real database, the real numbers now follow build order instead: **F01 = 0018, F02 = 0019, F03 = 0020**, with everything below reassigned as each feature's own spec is written (see `specs/README.md` §2 for the authoritative, current ledger). **The content sections below (roles, tables, RLS, grants) are still the right reference for what each piece needs to contain — the section headers' numbers (`## 0018`, `## 0021`, etc.) are not the numbers to actually apply.** Where a specific reassignment is already known, it's noted inline.
>
> Doc 3 of the spec set. Same conventions as your existing schema: raw SQL, no ORM, checksum-tracked, RLS-first, roles are the load-bearing access-control layer.

> **What you'll learn here:** Postgres Row-Level Security (RLS) is one of the least-taught, most-asked-about-in-senior-interviews Postgres features — most engineers have only used app-layer `WHERE account_id = ?` filtering, which fails the moment someone forgets the clause in one query. RLS makes the database itself refuse to return another tenant's rows, *even if the application code has a bug*. You already have this working; this doc extends the same pattern to new tables and explains the parts that are easy to get subtly wrong (grant vs. policy, `SET LOCAL` vs `SET`, `BYPASSRLS` scope).

---

## 0018 — New roles

```sql
-- 0018 · New Postgres roles for the crawl/apply/admin subsystem.
--
-- Mirrors 0001's reasoning exactly: app_ingest (existing) has zero grants
-- on tenant data because it processes untrusted third-party ATS responses.
-- app_crawler is the same isolation principle applied to arbitrary
-- third-party HTML from company career pages — an even less trusted input
-- surface, since it's not even a documented API response shape.
--
-- app_crawler_tier_c is a SEPARATE role from app_crawler on purpose (not
-- just a flag) — see docs/01-LLD.md §1.3. If Tier C's crawling gets an
-- account flagged/banned by a target site, that role's blast radius must
-- be provably confined to its own single table, verifiable by reading
-- grants alone, not by trusting application code to enforce the boundary.
--
-- app_admin is new: the one role allowed to read across ALL accounts, not
-- because it bypasses RLS (it does NOT get BYPASSRLS), but because its
-- policies explicitly check a claim (see 0021) rather than an account_id
-- match. This keeps "admin can see everything" auditable at the policy
-- level instead of being an app-code special case that could silently
-- leak in other queries.

CREATE ROLE app_crawler NOLOGIN;
CREATE ROLE app_crawler_tier_c NOLOGIN;
CREATE ROLE app_amatya NOLOGIN;
CREATE ROLE app_admin NOLOGIN;

GRANT USAGE ON SCHEMA public TO app_crawler, app_crawler_tier_c, app_amatya, app_admin;
```

---

## 0019 — Company targets and crawl runs

```sql
-- 0019 · target_company + crawl_run (Feature F3/F4).
--
-- target_company is tenant-scoped (a user's own list of companies to
-- watch) but resolves to a SHARED company/career_source row (Layer 1,
-- from 0005) once resolved — same "don't duplicate what's shared" instinct
-- as job_posting already follows. Many users can target the same company;
-- the crawl itself happens once, not once per user (see LLD §1.1).

CREATE TABLE target_company (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  raw_name        text NOT NULL,               -- exactly what the user typed/uploaded
  company_id      uuid REFERENCES company(id) ON DELETE SET NULL, -- set once resolved
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved_ats', 'resolved_generic', 'dead')),
  dead_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

CREATE UNIQUE INDEX target_company_account_name_key
  ON target_company (account_id, lower(raw_name));

ALTER TABLE target_company ENABLE ROW LEVEL SECURITY;

CREATE POLICY target_company_tenant_select ON target_company
  FOR SELECT USING (account_id = app_current_account_id());
CREATE POLICY target_company_tenant_insert ON target_company
  FOR INSERT WITH CHECK (account_id = app_current_account_id());
CREATE POLICY target_company_tenant_update ON target_company
  FOR UPDATE USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());
CREATE POLICY target_company_tenant_delete ON target_company
  FOR DELETE USING (account_id = app_current_account_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON target_company TO app_web;
GRANT SELECT, UPDATE (status, company_id, dead_reason, resolved_at) ON target_company TO app_crawler;

-- ---------------------------------------------------------------------------
-- crawl_run — same append-only audit shape as scrape_run (0005). A generic
-- career-page crawl breaks constantly (site redesigns, bot detection,
-- layout changes) — this table is how you find out instead of the product
-- silently going quiet, per your own docs/PRD.md §29 principle.
-- ---------------------------------------------------------------------------

CREATE TABLE crawl_run (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  career_source_id uuid NOT NULL REFERENCES career_source(id) ON DELETE CASCADE,
  tier             text NOT NULL CHECK (tier IN ('ats', 'generic', 'tier_c')),
  status           text NOT NULL CHECK (status IN ('success', 'failure', 'skipped')),
  postings_found   integer NOT NULL DEFAULT 0,
  error            text,
  duration_ms      integer,
  started_at       timestamptz NOT NULL,
  finished_at      timestamptz
);

CREATE INDEX crawl_run_source_idx ON crawl_run (career_source_id, started_at DESC);

-- No RLS: same reasoning as scrape_run — this is Layer 1 operational data,
-- not tenant data. Readable by app_web (so an admin/status page can show
-- it) and writable by whichever crawler tier ran it.
GRANT SELECT ON crawl_run TO app_web, app_admin;
GRANT SELECT, INSERT ON crawl_run TO app_crawler;
GRANT SELECT, INSERT ON crawl_run TO app_crawler_tier_c;
```

---

## 0020 — Apply actions

```sql
-- 0020 · apply_action (Feature F5-F8): the dry-run → approve → execute
-- state machine from docs/01-LLD.md §3.1. This is the single most
-- important table in this migration set — it's the record of "what did
-- this system do or propose to do on the candidate's behalf," which is
-- exactly the kind of action that needs a complete, honest audit trail
-- (same instinct as application_event being append-only, one layer up).

CREATE TABLE apply_action (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  job_posting_id    uuid NOT NULL REFERENCES job_posting(id) ON DELETE CASCADE,
  mode              text NOT NULL CHECK (mode IN ('form_fill', 'email')),
  status            text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'approved', 'rejected', 'executing', 'applied', 'failed')),

  -- The matching decision that produced this action — stored, not
  -- recomputed later, so "why did this apply" is always answerable even
  -- if the resume/JD changes afterward. Mirrors match_explanation's own
  -- reasoning (0011) for keeping evidence alongside the decision.
  skill_match_pct   real NOT NULL,
  skills_matched    text[] NOT NULL DEFAULT '{}',
  skills_missing    text[] NOT NULL DEFAULT '{}',
  experience_fit    boolean NOT NULL,

  -- mode=email only
  draft_subject     text,
  draft_body        text,
  target_email      text,
  gmail_message_id  text,

  -- mode=form_fill only
  form_field_map    jsonb,          -- detected {field_name: selector} at proposal time
  confirmation_screenshot bytea,    -- proof of submission, same D-24 cost reasoning as resume_artifact

  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  proposed_at       timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz,   -- when user approved/rejected
  executed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One proposal per (account, posting) — re-crawling the same still-open
-- role must never create a duplicate action.
CREATE UNIQUE INDEX apply_action_account_posting_key
  ON apply_action (account_id, job_posting_id);

-- The dashboard's hottest query: this account's unapplied count / list.
CREATE INDEX apply_action_pending_idx
  ON apply_action (account_id, status)
  WHERE status IN ('proposed', 'approved', 'executing');

ALTER TABLE apply_action ENABLE ROW LEVEL SECURITY;

CREATE POLICY apply_action_tenant_select ON apply_action
  FOR SELECT USING (account_id = app_current_account_id());
CREATE POLICY apply_action_tenant_insert ON apply_action
  FOR INSERT WITH CHECK (account_id = app_current_account_id());
CREATE POLICY apply_action_tenant_update ON apply_action
  FOR UPDATE USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

GRANT SELECT, INSERT, UPDATE ON apply_action TO app_web;
-- No DELETE for app_web — same append-only-ish reasoning as
-- application_event; a rejected/failed action stays as a record, it
-- doesn't disappear.

-- The matcher writes new proposals; column-scoped exactly like job_match's
-- own precedent in 0011 (app_matcher gets UPDATE (dismissed_at) only there).
GRANT SELECT, INSERT ON apply_action TO app_matcher;

-- The apply-svc executes: needs to move status forward and write results,
-- nothing else.
GRANT SELECT,
  UPDATE (status, attempts, last_error, executed_at, updated_at,
          gmail_message_id, confirmation_screenshot)
  ON apply_action TO app_amatya; -- (apply-svc reuses this role; see note below)
```

> Note: in the migration file itself I'd actually name a dedicated `app_apply` role rather than overloading `app_amatya` — shown here as `app_amatya` only because I hadn't split it out yet in this draft. **Flagging this explicitly rather than silently fixing it**, because catching a copy-paste role mismatch like this by reading the grant list is exactly the RLS-review skill worth practicing — go back and add a real `CREATE ROLE app_apply NOLOGIN;` in 0018 and re-point this grant before you run it.

---

## "0021" — Admin cross-account access (content reference only — see notice at top of doc)

> This section's actual dependency problem, unchanged by the broader renumbering above: it references `apply_action`/`target_company`, so whatever number it eventually gets must come *after* whichever migrations create those tables. **What actually happened**: the general mechanism below (the `app_is_admin_session()` function, the `app_admin` role) shipped as part of migration **0018** (`F01-auth-rbac/SPEC.md` §5), with no per-table policies. The per-table admin-`SELECT` policies shown below are applied incrementally instead — each table gets its own, added by the migration that creates that table (0020 adds `target_company`'s, a later one adds `apply_action`'s) — not centralized in one batch far from the tables it references. Kept below for what the policies should look like when each is written; **do not run this SQL as one migration.**

```sql
-- Admin visibility (Feature F11), the auditable way. Kept for reference —
-- see the notice above for where each piece of this actually lands.
--
-- The wrong way to build "admin sees everything" is BYPASSRLS on a
-- request-serving role — that's an unbounded blast radius the moment
-- any endpoint using that role has an authz bug. The right way (this
-- migration): app_admin gets its own RLS policies with a DIFFERENT
-- condition — "is this session flagged as an admin session" — checked
-- via a second session variable, never touching account_id matching
-- at all. This makes "why can this role see this row" answerable by
-- reading one policy, not by trusting every call site to check role
-- first.

-- A second, admin-specific session flag — deliberately separate from
-- app_current_account_id() so the two concerns (which tenant, and
-- whether this is an admin-privileged read) can never be conflated.
CREATE OR REPLACE FUNCTION app_is_admin_session() RETURNS boolean AS $$
  SELECT COALESCE(current_setting('app.is_admin_session', true), 'false')::boolean;
$$ LANGUAGE sql STABLE;

-- Applied to every tenant table an admin needs read access to. Shown here
-- for apply_action and target_company; repeat the same shape for
-- job_application, job_match, candidate_profile if the admin console
-- needs them.
CREATE POLICY apply_action_admin_select ON apply_action
  FOR SELECT USING (app_is_admin_session());
CREATE POLICY target_company_admin_select ON target_company
  FOR SELECT USING (app_is_admin_session());

GRANT SELECT ON apply_action, target_company TO app_admin;
```

Application-layer contract this depends on: the Go API gateway sets `app.is_admin_session = true` via `SET LOCAL` **only** inside a transaction it opens after verifying, from the session/JWT, that `account_member.role = 'admin'` for the calling user — never trust a client-supplied flag. This is the same `withAccount()`-style helper your existing `packages/db/src/context.ts` already implements for `app.current_account_id`; add a sibling `withAdminSession()` following the identical pattern.

---

## 0022 — Amatya chat persistence

```sql
-- 0022 · amatya_thread + amatya_message (Feature F10).

CREATE TABLE amatya_thread (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  title       text,               -- optional, e.g. auto-summarized after N messages
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE amatya_message (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  thread_id             uuid NOT NULL REFERENCES amatya_thread(id) ON DELETE CASCADE,
  role                  text NOT NULL CHECK (role IN ('user', 'assistant')),
  content               text NOT NULL,
  linked_apply_action_id uuid REFERENCES apply_action(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX amatya_message_thread_idx ON amatya_message (thread_id, created_at);

ALTER TABLE amatya_thread ENABLE ROW LEVEL SECURITY;
ALTER TABLE amatya_message ENABLE ROW LEVEL SECURITY;

CREATE POLICY amatya_thread_tenant_all ON amatya_thread
  FOR ALL USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());
-- Note: this is the one place a FOR ALL policy is actually fine —
-- unlike apply_action/application_event, there's no append-only or
-- narrower-than-CRUD requirement here, so one policy covering all four
-- operations is simpler and not hiding anything a split set would catch.

CREATE POLICY amatya_message_tenant_all ON amatya_message
  FOR ALL USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON amatya_thread, amatya_message TO app_web;
GRANT SELECT, INSERT ON amatya_thread, amatya_message TO app_amatya;
```

---

## 0023 — Grant fixes (there will be one)

Your own history (0012–0016) already proves this pattern: real integration tests against real Postgres will find a missing `SELECT`-for-`DELETE`'s-`WHERE`-clause or similar within the first week of writing tests against 0018–0022. **Reserve migration number 0023 for it now** rather than renumbering later — expect it, don't be surprised by it.

---

## What you'll learn across this whole doc

- **RLS policy design**: `FOR SELECT/INSERT/UPDATE/DELETE` split vs `FOR ALL`, and when each is the right call (hint: split whenever the table has an intentionally-narrower-than-CRUD access pattern, like append-only tables).
- **Column-level grants** (`GRANT UPDATE (col1, col2) ON ...`) — a genuinely underused Postgres feature that lets you give a service exactly the write surface it needs, nothing more, without a second table.
- **Session-scoped config as an authorization primitive** (`current_setting`/`SET LOCAL`) — this is how multi-tenant Postgres apps implement "current user context" without passing it as a parameter through every single query.
- **Why admin access should never be `BYPASSRLS`** on a request-serving role — a real, defensible architecture decision you can explain in an interview, not just "we added an if-admin check in the code."

---

## What's next

**API contracts** — REST endpoints + GraphQL schema for all of the above, plus the exact SSE event payload shapes (`apply.proposed`, `amatya.token`, etc.) that the FE will subscribe to.

Say **next** for that.
