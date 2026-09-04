-- 0011 · Matching output (Phase 5, wave B).
--
-- job_match is the persisted result of the D-21 pipeline: hard constraints
-- -> hybrid retrieval -> ranking -> (later) explanation. Phase 5.2 writes
-- this table with structured signals only; embedding-derived signals and
-- explanations land in Phase 5.3 without needing to touch this shape again.

CREATE TABLE job_match (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  job_posting_id         uuid NOT NULL REFERENCES job_posting(id) ON DELETE CASCADE,
  job_posting_version_id uuid NOT NULL REFERENCES job_posting_version(id) ON DELETE CASCADE,
  score           real NOT NULL CHECK (score BETWEEN 0 AND 1),
  vector_score    real NOT NULL,
  keyword_score   real NOT NULL,
  skill_score     real NOT NULL,
  seniority_score real NOT NULL,
  location_score  real NOT NULL,
  -- NULL means "salary unknown," never zero - only Ashby emits structured
  -- salary today (ADR D-32/the rank package), so most rows will be NULL and
  -- must not be scored as if the posting failed a comp floor.
  comp_score      real,
  freshness_score real NOT NULL,
  -- Bumped to invalidate every cached score at once (a ranking-formula
  -- change, a new signal added) without a data migration - old rows are
  -- simply superseded by the next batch run rather than needing to be
  -- individually recomputed or deleted.
  matcher_version integer NOT NULL,
  ranked_at       timestamptz NOT NULL DEFAULT now(),
  dismissed_at    timestamptz,
  UNIQUE (account_id, job_posting_id)
);

-- The feed's hot query: this account's live (non-dismissed) matches, best
-- first.
CREATE INDEX job_match_feed_idx
  ON job_match (account_id, score DESC)
  WHERE dismissed_at IS NULL;

ALTER TABLE job_match ENABLE ROW LEVEL SECURITY;

CREATE POLICY job_match_tenant_select ON job_match
  FOR SELECT
  USING (account_id = app_current_account_id());

-- app_web never inserts a match row - only dismisses one it can already
-- see. No INSERT policy for app_web at all; only app_matcher gets that
-- grant, below.
CREATE POLICY job_match_tenant_dismiss ON job_match
  FOR UPDATE
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

-- The one DELETE app_web is allowed: ADR D-31's ephemeral-retention purge,
-- which runs as the candidate's own account under the normal RLS context -
-- never a bulk or cross-tenant delete, because the policy still scopes it
-- to account_id = app_current_account_id() same as every other policy here.
CREATE POLICY job_match_tenant_purge ON job_match
  FOR DELETE
  USING (account_id = app_current_account_id());

-- Column-level: the request path can dismiss a match, and cannot rewrite
-- its score - the same asymmetric-grant pattern as job_posting_version's
-- embedding columns above. DELETE is table-level (RLS above is what keeps
-- it scoped) since there is no column-level equivalent for a whole-row op.
GRANT SELECT, DELETE ON job_match TO app_web;
GRANT UPDATE (dismissed_at) ON job_match TO app_web;

GRANT SELECT, INSERT, UPDATE, DELETE ON job_match TO app_matcher;

-- ---------------------------------------------------------------------------
-- match_explanation - Phase 5.3+ (LangGraph B). The table exists now so
-- 5.2's job_match writer and 5.3's explainer are two independent additions
-- to a schema that does not change shape between them.
-- ---------------------------------------------------------------------------

CREATE TABLE match_explanation (
  account_id             uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  job_posting_version_id uuid NOT NULL REFERENCES job_posting_version(id) ON DELETE CASCADE,
  summary        text NOT NULL,
  -- [{claim, fact_ref, provenance}] - D-22 made structural: every claim in
  -- the explanation carries the provenance of the fact it is based on, so
  -- the UI can show "verified" vs "inferred" per sentence rather than
  -- asserting the whole explanation is equally trustworthy.
  evidence       jsonb NOT NULL,
  model          text NOT NULL,
  prompt_version integer NOT NULL,
  generated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, job_posting_version_id)
);

ALTER TABLE match_explanation ENABLE ROW LEVEL SECURITY;

CREATE POLICY match_explanation_tenant_select ON match_explanation
  FOR SELECT
  USING (account_id = app_current_account_id());

-- Same D-31 purge exception as job_match above, same reasoning.
CREATE POLICY match_explanation_tenant_purge ON match_explanation
  FOR DELETE
  USING (account_id = app_current_account_id());

GRANT SELECT, DELETE ON match_explanation TO app_web;
GRANT SELECT, INSERT, UPDATE ON match_explanation TO app_matcher;

-- ---------------------------------------------------------------------------
-- Remaining app_matcher grants this phase needs: enough of `account` to
-- iterate every tenant (D-13's per-account batch pattern), and the queue,
-- so the matcher can claim its own jobs the same way app_ingest already
-- does for ingestion.
-- ---------------------------------------------------------------------------

-- Column-level: enough to iterate accounts and skip soft-deleted ones.
-- Nothing about a person (email, name) is on this table to begin with, but
-- naming the exact columns is still the more honest grant than SELECT *.
GRANT SELECT (id, type, deleted_at) ON account TO app_matcher;

-- No DELETE: the matcher claims, completes and fails jobs the same way
-- app_ingest does; pruning done rows is an operational task, not something
-- either producer role needs to do itself.
GRANT SELECT, INSERT, UPDATE ON job_queue TO app_matcher;
