-- 0010 · Embedding readiness for Layer 1 and Layer 2 (Phase 5, wave B).
--
-- The vector extension has been enabled since 0001; nothing has used it
-- until now. This migration only adds columns and indexes - no service
-- writes an embedding yet (that is Phase 5.3's FastAPI + Go worker code).
-- Structural readiness first, on purpose: it means the Go matcher's
-- non-AI pipeline (Phase 5.2, hard constraints + structured ranking) can
-- be built and tested against the real, final table shape rather than
-- against a shape that changes out from under it once embeddings land.

-- ---------------------------------------------------------------------------
-- job_posting_version - one embedding per version, matching D-09: keyed on
-- the version so a whitespace-only re-scrape never triggers a re-embed.
-- ---------------------------------------------------------------------------

ALTER TABLE job_posting_version
  ADD COLUMN embedding       vector(384),
  ADD COLUMN embedding_model text,
  ADD COLUMN embedded_at     timestamptz;

-- Hybrid retrieval's keyword half (ADR D-32). GENERATED ALWAYS ... STORED so
-- it can never drift out of sync with title/description_text - there is no
-- write path that could update one and forget the other, because there is
-- no write path to this column at all.
ALTER TABLE job_posting_version
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description_text, ''))
  ) STORED;

CREATE INDEX job_posting_version_search_idx
  ON job_posting_version USING gin (search_tsv);

-- HNSW over IVFFlat (ADR D-32): IVFFlat needs training on a populated table
-- and its recall degrades as the table grows past what it was trained on -
-- a poor fit for an index that grows continuously by design (D-01). HNSW
-- has no training step and inserts incrementally. m/ef_construction are
-- pgvector's own defaults, chosen deliberately rather than left implicit -
-- see D-32 for the benchmark this pins them against.
CREATE INDEX job_posting_version_embedding_idx
  ON job_posting_version USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Column-level, not table-level: the matcher can write vectors and
-- literally cannot touch job content, title, or anything else on this
-- table. app_ingest keeps its existing full grant from 0005 - ingestion
-- still owns everything else about a posting.
GRANT UPDATE (embedding, embedding_model, embedded_at) ON job_posting_version TO app_matcher;

-- ---------------------------------------------------------------------------
-- profile_embedding - the query-side vectors: one row per (account, kind).
-- Never itself searched (it is what a search searches WITH), so it carries
-- no HNSW index - a query vector doesn't benefit from an index on the query.
-- ---------------------------------------------------------------------------

CREATE TABLE profile_embedding (
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('resume', 'desired_role')),
  embedding       vector(384) NOT NULL,
  -- sha256 of the text that was embedded - lets the embedding worker skip
  -- re-embedding unchanged input instead of re-computing on every run.
  source_hash     text NOT NULL,
  embedding_model text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, kind)
);

ALTER TABLE profile_embedding ENABLE ROW LEVEL SECURITY;

CREATE POLICY profile_embedding_tenant_select ON profile_embedding
  FOR SELECT
  USING (account_id = app_current_account_id());

CREATE POLICY profile_embedding_tenant_insert ON profile_embedding
  FOR INSERT
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY profile_embedding_tenant_update ON profile_embedding
  FOR UPDATE
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY profile_embedding_tenant_delete ON profile_embedding
  FOR DELETE
  USING (account_id = app_current_account_id());

-- app_web reads it (a profile page could show "embedding last updated");
-- app_matcher reads and writes it (the embedding worker owns this table
-- outright, unlike job_posting_version where it only owns three columns -
-- there is no other content on this table for it to accidentally touch).
GRANT SELECT ON profile_embedding TO app_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON profile_embedding TO app_matcher;

-- profile_embedding is keyed by account_id, so it is - deliberately - a
-- purge target under D-31's retention mechanic once the resume kind is
-- re-embedded per search cycle. Not added to jobSearch.ts's PURGE_TABLES
-- list yet: this migration only creates the table, and wiring the purge is
-- Phase 5.3 work, done alongside the embedding worker that populates it in
-- the first place.
