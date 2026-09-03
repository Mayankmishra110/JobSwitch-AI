-- 0007 · Layer 2, the personal layer - candidate profiles (Phase 4).
--
-- The first genuinely tenant-owned data in the system: everything up to here
-- (Layer 0 identity, Layer 1 job index) is either not tenant-scoped or shared
-- across every tenant. These three tables follow the RLS template set out in
-- 0004_audit_log_rls.sql exactly, with one addition each policy set needs that
-- audit_log did not: audit_log is append-only, a profile is not, so UPDATE and
-- (for the child tables) DELETE policies exist here too.
--
-- Matching and explanations (the rest of "L2 personal" in the README's layer
-- diagram) are Phase 5. This migration is the data a match will be computed
-- against, not the match itself.

-- ---------------------------------------------------------------------------
-- candidate_profile - one row per account.
--
-- account_id is the primary key rather than a separate id + unique index,
-- because the 1:1 relationship is exact: a profile with no account is
-- meaningless and an account has at most one. Upserts are a single
-- INSERT ... ON CONFLICT (account_id) DO UPDATE.
-- ---------------------------------------------------------------------------

CREATE TABLE candidate_profile (
  account_id            uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  headline              text,
  summary               text,
  current_title         text,
  years_experience      smallint CHECK (years_experience IS NULL OR years_experience >= 0),
  desired_titles        text[] NOT NULL DEFAULT '{}',
  desired_locations     text[] NOT NULL DEFAULT '{}',
  desired_work_mode     text CHECK (desired_work_mode IN ('remote', 'hybrid', 'onsite', 'any')),
  desired_salary_min    integer CHECK (desired_salary_min IS NULL OR desired_salary_min >= 0),
  desired_salary_max    integer,
  desired_salary_currency text,
  -- Resume storage is text-only at Phase 4: the extracted plain text a future
  -- embedding step reads, plus the filename for display. Binary storage needs
  -- an object store that does not exist yet - see the README's known gaps.
  resume_filename       text,
  resume_text           text,
  resume_uploaded_at    timestamptz,
  linkedin_url          text,
  github_url            text,
  portfolio_url         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (
    desired_salary_min IS NULL OR desired_salary_max IS NULL
    OR desired_salary_max >= desired_salary_min
  )
);

ALTER TABLE candidate_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY candidate_profile_tenant_select ON candidate_profile
  FOR SELECT
  USING (account_id = app_current_account_id());

CREATE POLICY candidate_profile_tenant_insert ON candidate_profile
  FOR INSERT
  WITH CHECK (account_id = app_current_account_id());

-- A profile is mutable, unlike audit_log - USING re-checks the row being
-- targeted, WITH CHECK the row being written, so a tenant cannot retarget its
-- own row onto another account_id mid-update either.
CREATE POLICY candidate_profile_tenant_update ON candidate_profile
  FOR UPDATE
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

GRANT SELECT, INSERT, UPDATE ON candidate_profile TO app_web;

-- ---------------------------------------------------------------------------
-- profile_skill - free-text skill tags. Case-insensitive uniqueness per
-- account so "React" and "react" cannot both be added, which would otherwise
-- silently double-count in Phase 5 hard filters.
-- ---------------------------------------------------------------------------

CREATE TABLE profile_skill (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  skill      text NOT NULL CHECK (btrim(skill) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX profile_skill_account_skill_key
  ON profile_skill (account_id, lower(skill));

ALTER TABLE profile_skill ENABLE ROW LEVEL SECURITY;

CREATE POLICY profile_skill_tenant_select ON profile_skill
  FOR SELECT
  USING (account_id = app_current_account_id());

CREATE POLICY profile_skill_tenant_insert ON profile_skill
  FOR INSERT
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY profile_skill_tenant_delete ON profile_skill
  FOR DELETE
  USING (account_id = app_current_account_id());

GRANT SELECT, INSERT, DELETE ON profile_skill TO app_web;

-- ---------------------------------------------------------------------------
-- profile_experience - work history. Structured (rather than left inside
-- resume_text) because Phase 7 autofill needs individually addressable
-- entries, not a paragraph to re-parse.
-- ---------------------------------------------------------------------------

CREATE TABLE profile_experience (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  company     text NOT NULL CHECK (btrim(company) <> ''),
  title       text NOT NULL CHECK (btrim(title) <> ''),
  location    text,
  start_date  date NOT NULL,
  end_date    date,
  is_current  boolean NOT NULL DEFAULT false,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date),
  -- A role cannot be "current" and also have an end date - that is two
  -- contradictory facts in one row rather than a data-entry preference.
  CHECK (NOT (is_current AND end_date IS NOT NULL))
);

CREATE INDEX profile_experience_account_start_idx
  ON profile_experience (account_id, start_date DESC);

ALTER TABLE profile_experience ENABLE ROW LEVEL SECURITY;

CREATE POLICY profile_experience_tenant_select ON profile_experience
  FOR SELECT
  USING (account_id = app_current_account_id());

CREATE POLICY profile_experience_tenant_insert ON profile_experience
  FOR INSERT
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY profile_experience_tenant_update ON profile_experience
  FOR UPDATE
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY profile_experience_tenant_delete ON profile_experience
  FOR DELETE
  USING (account_id = app_current_account_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON profile_experience TO app_web;

-- app_ingest and app_matcher get nothing here, same control as 0001: ingestion
-- must never be able to reach a résumé even if fully compromised, and the
-- matcher's read access is a Phase 5 decision to make deliberately, not one to
-- default into by omission.
