-- 0008 · The application pipeline and resume tailoring (Phase 5, wave A).
--
-- Ties Layer 1 (job_posting) to Layer 2 tenant data via job_application,
-- which is deliberately the shape that lets a candidate start using this
-- product before either ingestion has found their target company or
-- matching exists: job_posting_id is nullable, and a pasted JD is a
-- first-class path, not a fallback. Follows the RLS template from
-- 0004_audit_log_rls.sql exactly, same as 0007.
--
-- Two ADR decisions this migration is built around:
--   D-24 (cost) - resume_artifact.pdf_bytes is bytea, not S3. A tailored PDF
--     is ~100KB; even 200 applications is ~25MB. No new managed service for
--     that. Revisit only if this genuinely grows past a few GB.
--   D-31 (ephemeral resume retention) - resume_source and resume_artifact
--     are named purge targets once that migration lands (0009). Nothing
--     here implements the purge; this just creates the tables it applies to.

-- ---------------------------------------------------------------------------
-- resume_source - the candidate's LaTeX template(s), byte-exact.
--
-- One row per (account, variant): a candidate may keep more than one
-- resume shape (e.g. "frontend" vs "fullstack"), same as the two variants
-- nipun shipped for Mayank himself. account_id + variant_id is the PK
-- rather than a synthetic id because the pair is the real identity here.
-- ---------------------------------------------------------------------------

CREATE TABLE resume_source (
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  variant_id    text NOT NULL CHECK (btrim(variant_id) <> ''),
  label         text NOT NULL,
  pdf_base_name text NOT NULL,
  tex           text NOT NULL,
  -- Proves which exact bytes a later resume_artifact was spliced from - the
  -- same "provenance for the document itself" instinct D-22 applies to facts.
  sha256        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, variant_id)
);

ALTER TABLE resume_source ENABLE ROW LEVEL SECURITY;

CREATE POLICY resume_source_tenant_select ON resume_source
  FOR SELECT
  USING (account_id = app_current_account_id());

CREATE POLICY resume_source_tenant_insert ON resume_source
  FOR INSERT
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY resume_source_tenant_update ON resume_source
  FOR UPDATE
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY resume_source_tenant_delete ON resume_source
  FOR DELETE
  USING (account_id = app_current_account_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON resume_source TO app_web;

-- ---------------------------------------------------------------------------
-- job_application - the tracker. job_posting_id is nullable ON PURPOSE: a
-- candidate pasting a JD by hand must work before ingestion has this
-- company, or before matching exists at all. The CHECK below is what keeps
-- that flexibility from becoming a row with no usable content either way.
-- ---------------------------------------------------------------------------

CREATE TABLE job_application (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  job_posting_id uuid REFERENCES job_posting(id) ON DELETE RESTRICT,
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('match', 'manual')),
  manual_company text,
  manual_title   text,
  manual_url     text,
  manual_jd_text text,
  status         text NOT NULL DEFAULT 'found'
    CHECK (status IN ('found', 'tailoring', 'tailored', 'applied',
                       'responded', 'interview', 'offer', 'rejected', 'withdrawn')),
  applied_at     timestamptz,
  next_action_at timestamptz,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- A row must be usable one way or the other: either it points at a real
  -- indexed posting, or it carries enough hand-entered content to tailor
  -- and track against. Never neither.
  CHECK (
    job_posting_id IS NOT NULL
    OR (manual_title IS NOT NULL AND manual_jd_text IS NOT NULL)
  )
);

-- A candidate tracks a given indexed posting at most once. Partial (only
-- when job_posting_id is set) so any number of manual entries coexist freely.
CREATE UNIQUE INDEX job_application_account_posting_key
  ON job_application (account_id, job_posting_id)
  WHERE job_posting_id IS NOT NULL;

-- The pipeline board's hot query: this account's applications, grouped by
-- status, most-recently-touched first.
CREATE INDEX job_application_board_idx
  ON job_application (account_id, status, updated_at DESC);

ALTER TABLE job_application ENABLE ROW LEVEL SECURITY;

CREATE POLICY job_application_tenant_select ON job_application
  FOR SELECT
  USING (account_id = app_current_account_id());

CREATE POLICY job_application_tenant_insert ON job_application
  FOR INSERT
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY job_application_tenant_update ON job_application
  FOR UPDATE
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY job_application_tenant_delete ON job_application
  FOR DELETE
  USING (account_id = app_current_account_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON job_application TO app_web;

-- ---------------------------------------------------------------------------
-- application_event - append-only history. Same philosophy as scrape_run
-- (0005) and audit_log (0004): a status transition is a fact worth keeping,
-- not just the current value overwriting the last one.
-- ---------------------------------------------------------------------------

CREATE TABLE application_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES job_application(id) ON DELETE CASCADE,
  from_status    text,
  to_status      text NOT NULL,
  note           text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX application_event_app_idx
  ON application_event (application_id, occurred_at DESC);

ALTER TABLE application_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY application_event_tenant_select ON application_event
  FOR SELECT
  USING (account_id = app_current_account_id());

CREATE POLICY application_event_tenant_insert ON application_event
  FOR INSERT
  WITH CHECK (account_id = app_current_account_id());

-- No UPDATE or DELETE policy, so neither is permitted for app_web under
-- RLS - append-only by construction, same pattern as audit_log.
GRANT SELECT, INSERT ON application_event TO app_web;

-- ---------------------------------------------------------------------------
-- resume_artifact - one tailoring run. Two-phase by status: 'proposed' sits
-- for human review (never auto-approved, never auto-sent anywhere), only
-- becomes 'compiled' after the candidate accepts specific changes.
-- ---------------------------------------------------------------------------

CREATE TABLE resume_artifact (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  application_id   uuid NOT NULL REFERENCES job_application(id) ON DELETE CASCADE,
  variant_id       text NOT NULL,
  source_sha256    text NOT NULL,
  status           text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'compiled', 'failed')),
  proposed_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
  flags            jsonb NOT NULL DEFAULT '[]'::jsonb,
  accepted         jsonb NOT NULL DEFAULT '[]'::jsonb,
  tex              text,
  -- Not S3 (ADR D-24): a compiled resume is ~100KB, and there is no
  -- object store in this stack's budget. Revisit only past a few GB.
  pdf_bytes        bytea,
  pdf_sha256       text,
  compile_error    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  compiled_at      timestamptz
);

CREATE INDEX resume_artifact_app_idx
  ON resume_artifact (application_id, created_at DESC);

ALTER TABLE resume_artifact ENABLE ROW LEVEL SECURITY;

CREATE POLICY resume_artifact_tenant_select ON resume_artifact
  FOR SELECT
  USING (account_id = app_current_account_id());

CREATE POLICY resume_artifact_tenant_insert ON resume_artifact
  FOR INSERT
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY resume_artifact_tenant_update ON resume_artifact
  FOR UPDATE
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY resume_artifact_tenant_delete ON resume_artifact
  FOR DELETE
  USING (account_id = app_current_account_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON resume_artifact TO app_web;

-- ---------------------------------------------------------------------------
-- jd_extraction - Layer 1, shared, NOT tenant-scoped. A job description's
-- extracted structure (skills, seniority, must-haves) does not depend on
-- who is reading it, so it is cached once per job_posting_version and read
-- by every candidate matched against that posting - same reasoning as
-- job_posting_version itself (ADR D-09: cache keyed on the version, so a
-- whitespace-only re-scrape never invalidates it).
-- ---------------------------------------------------------------------------

CREATE TABLE jd_extraction (
  job_posting_version_id uuid PRIMARY KEY
    REFERENCES job_posting_version(id) ON DELETE CASCADE,
  extraction     jsonb NOT NULL,
  model          text NOT NULL,
  prompt_version integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- No RLS: this table has no account_id and never will. Readable by the web
-- role (tailoring/matching call sites) and writable only by whichever
-- service extracts it - app_web for now, since apps/web routes call out to
-- services/ai and persist the result itself in Phase 5.
GRANT SELECT, INSERT ON jd_extraction TO app_web;
