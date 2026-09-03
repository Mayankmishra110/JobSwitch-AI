-- 0009 · Fact provenance (ADR D-22/D-22a) and ephemeral resume retention
-- (ADR D-31), Phase 5 wave B.
--
-- Two changes landing together because they touch the same existing table:
-- every fact in a candidate's profile is now tagged with where it came from,
-- and the raw resume text/file is split off candidate_profile into its own
-- table so it can be hard-deleted independently of everything else when a
-- candidate turns their active job search off.
--
-- This is deliberately the migration GAP_ANALYSIS.md called out as needing
-- to land before any matching or tailoring code exists - retrofitting either
-- change after Phase 5 code depends on the current flat shape would be
-- materially more expensive than doing it now.

-- ---------------------------------------------------------------------------
-- Fact provenance (D-22/D-22a).
--
-- Four kinds from the PRD, plus a fifth added here: a hand-typed headline is
-- neither "extracted from a document" (verified_fact) nor "a search
-- criterion" (preference) - it needed its own name. Every downstream
-- consumer (tailoring, explanations) keys its trust and its citation
-- requirements off this enum, not off a prompt instruction.
-- ---------------------------------------------------------------------------

CREATE TYPE fact_provenance AS ENUM (
  'verified_fact',    -- extracted from a document the candidate supplied
  'self_asserted',    -- the candidate typed it about themselves
  'preference',        -- a search criterion, not a fact about the past
  'ai_inference',      -- derived by a model
  'generated_text'     -- model-written prose
);

-- Only the fields that are genuinely ambiguous get a provenance column.
-- Everything else is provenance-by-construction, documented in place rather
-- than tracked per-row, because tracking it would say nothing a comment
-- doesn't already say for free.
ALTER TABLE candidate_profile
  ADD COLUMN headline_provenance         fact_provenance NOT NULL DEFAULT 'self_asserted',
  ADD COLUMN summary_provenance          fact_provenance NOT NULL DEFAULT 'self_asserted',
  ADD COLUMN current_title_provenance    fact_provenance NOT NULL DEFAULT 'self_asserted',
  ADD COLUMN years_experience_provenance fact_provenance NOT NULL DEFAULT 'self_asserted';

COMMENT ON COLUMN candidate_profile.desired_titles IS 'Always preference (ADR D-22).';
COMMENT ON COLUMN candidate_profile.desired_locations IS 'Always preference (ADR D-22).';
COMMENT ON COLUMN candidate_profile.desired_work_mode IS 'Always preference (ADR D-22).';
COMMENT ON COLUMN candidate_profile.desired_salary_min IS 'Always preference (ADR D-22).';
COMMENT ON COLUMN candidate_profile.desired_salary_max IS 'Always preference (ADR D-22).';
COMMENT ON COLUMN candidate_profile.desired_salary_currency IS 'Always preference (ADR D-22).';
COMMENT ON COLUMN candidate_profile.linkedin_url IS 'Always self_asserted (ADR D-22).';
COMMENT ON COLUMN candidate_profile.github_url IS 'Always self_asserted (ADR D-22).';
COMMENT ON COLUMN candidate_profile.portfolio_url IS 'Always self_asserted (ADR D-22).';

ALTER TABLE profile_skill
  ADD COLUMN provenance   fact_provenance NOT NULL DEFAULT 'self_asserted',
  -- e.g. 'resume:experience[0].bullets[2]' - where a verified_fact or
  -- ai_inference skill was actually seen. Free text on purpose: the shape of
  -- a reference differs by source, and this is read by humans debugging a
  -- match explanation, not queried structurally.
  ADD COLUMN evidence_ref text,
  ADD COLUMN confidence   real CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  -- An inferred skill without a confidence score is an unbounded claim; this
  -- is the one place D-22 is enforced as a constraint rather than only in
  -- application code, because the alternative (trusting every caller to set
  -- it) is exactly the kind of thing that quietly stops being true.
  ADD CONSTRAINT profile_skill_inference_needs_confidence
    CHECK (provenance <> 'ai_inference' OR confidence IS NOT NULL);

ALTER TABLE profile_experience
  ADD COLUMN provenance   fact_provenance NOT NULL DEFAULT 'self_asserted',
  ADD COLUMN evidence_ref text;

-- The first grant on these three tables for app_matcher - it had none before
-- this migration. Read-only: matching needs to read facts, never write them.
GRANT SELECT ON candidate_profile, profile_skill, profile_experience TO app_matcher;

-- ---------------------------------------------------------------------------
-- Ephemeral resume retention (D-31).
--
-- resume_upload is split OFF candidate_profile rather than left as three
-- nullable columns there, because candidate_profile deliberately has no
-- DELETE policy (0007: "rows are only ever upserted, never deleted by the
-- app"). A dedicated table means the purge below is a plain DELETE without
-- touching that existing, tested invariant.
-- ---------------------------------------------------------------------------

CREATE TABLE resume_upload (
  account_id  uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  raw_text    text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE resume_upload ENABLE ROW LEVEL SECURITY;

CREATE POLICY resume_upload_tenant_select ON resume_upload
  FOR SELECT
  USING (account_id = app_current_account_id());

CREATE POLICY resume_upload_tenant_insert ON resume_upload
  FOR INSERT
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY resume_upload_tenant_update ON resume_upload
  FOR UPDATE
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

-- Unlike candidate_profile, this table DOES get a DELETE policy - the whole
-- point of splitting it out was to make the D-31 purge a plain DELETE.
CREATE POLICY resume_upload_tenant_delete ON resume_upload
  FOR DELETE
  USING (account_id = app_current_account_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON resume_upload TO app_web;

-- Carry forward any resume data already sitting on candidate_profile from
-- before this split (Phase 4's setResume path). In a fresh environment this
-- affects zero rows; it exists so the migration is correct regardless of
-- what state a given database is actually in.
INSERT INTO resume_upload (account_id, filename, raw_text, uploaded_at)
SELECT account_id, resume_filename, resume_text, resume_uploaded_at
FROM candidate_profile
WHERE resume_filename IS NOT NULL
  AND resume_text IS NOT NULL
  AND resume_uploaded_at IS NOT NULL;

ALTER TABLE candidate_profile
  DROP COLUMN resume_filename,
  DROP COLUMN resume_text,
  DROP COLUMN resume_uploaded_at;

-- ---------------------------------------------------------------------------
-- job_search_session - the "active job search" toggle, modeled as
-- append-only history (like scrape_run, audit_log) rather than a single
-- boolean, so "this candidate has run 3 search rounds" is a real, inspectable
-- fact rather than something only inferable from other tables' timestamps.
-- ---------------------------------------------------------------------------

CREATE TABLE job_search_session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  stopped_at  timestamptz,
  stop_reason text CHECK (stop_reason IN ('user_action', 'scheduled_sweep_inactivity')),
  -- An active session has no stop time and no stop reason; a stopped one has
  -- both. Boolean-equality form so either half drifting is a constraint
  -- violation, not a silently inconsistent row.
  CHECK ((status = 'active') = (stopped_at IS NULL)),
  CHECK ((status = 'stopped') = (stop_reason IS NOT NULL))
);

-- At most one active session per account - the toggle really is a toggle.
CREATE UNIQUE INDEX job_search_session_one_active_key
  ON job_search_session (account_id)
  WHERE status = 'active';

CREATE INDEX job_search_session_account_idx
  ON job_search_session (account_id, started_at DESC);

ALTER TABLE job_search_session ENABLE ROW LEVEL SECURITY;

CREATE POLICY job_search_session_tenant_select ON job_search_session
  FOR SELECT
  USING (account_id = app_current_account_id());

CREATE POLICY job_search_session_tenant_insert ON job_search_session
  FOR INSERT
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY job_search_session_tenant_update ON job_search_session
  FOR UPDATE
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

-- No DELETE policy: a session is stopped, never removed - it is the record
-- of when a search happened, which the purge below deliberately preserves
-- even though it deletes everything the search touched.
GRANT SELECT, INSERT, UPDATE ON job_search_session TO app_web;

-- app_ingest and app_matcher get nothing on either new table, same control
-- as every tenant table before them.
