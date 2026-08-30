-- 0005 · Layer 1, the shared job index.
--
-- No tenant column anywhere in this file, and that is deliberate: this data is
-- public, shared by every user, and fetched once per company rather than once
-- per user. It is the cost boundary (ADR D-01) as much as the data boundary.
--
-- Written by app_ingest, read by app_web. app_ingest has no grant on any
-- tenant table (migration 0002), so the component that handles untrusted
-- third-party content cannot reach user data.

-- ---------------------------------------------------------------------------
-- ATS platforms as rows, not an enum.
--
-- ADR D-01 requires that adding an ATS be one adapter file plus a registry
-- entry. An enum would make it a schema migration; a lookup table makes it an
-- INSERT, while still giving the foreign key that stops a typo'd platform name
-- from silently creating an unreachable source.
-- ---------------------------------------------------------------------------

CREATE TABLE ats_platform (
  id            text PRIMARY KEY,
  display_name  text NOT NULL,
  -- Declared capabilities drive graceful degradation (ADR §17): the UI reads
  -- these to choose autofill / assisted / open, so no company name is ever
  -- hard-coded in a component.
  capabilities  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ats_platform (id, display_name, capabilities) VALUES
  ('greenhouse', 'Greenhouse', '{"structuredLocation":true,"structuredSalary":false,"department":true,"directApplyUrl":true,"autofillable":true}'),
  ('lever', 'Lever', '{"structuredLocation":true,"structuredSalary":false,"department":true,"directApplyUrl":true,"autofillable":true}'),
  ('ashby', 'Ashby', '{"structuredLocation":true,"structuredSalary":true,"department":true,"directApplyUrl":true,"autofillable":true}'),
  ('smartrecruiters', 'SmartRecruiters', '{"structuredLocation":true,"structuredSalary":false,"department":true,"directApplyUrl":true,"autofillable":false}'),
  ('workable', 'Workable', '{"structuredLocation":true,"structuredSalary":false,"department":true,"directApplyUrl":true,"autofillable":false}'),
  ('workday', 'Workday', '{"structuredLocation":true,"structuredSalary":false,"department":true,"directApplyUrl":true,"autofillable":false}'),
  ('custom', 'Custom career page', '{"structuredLocation":false,"structuredSalary":false,"department":false,"directApplyUrl":true,"autofillable":false}');

-- ---------------------------------------------------------------------------
-- Companies
-- ---------------------------------------------------------------------------

CREATE TABLE company (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  normalized_domain text NOT NULL,
  website           text,
  -- Cadence tiering (ADR §13). At 300 companies everything is 'standard'; the
  -- column exists now so growing to 5,000 is configuration, not a migration.
  cadence_tier      text NOT NULL DEFAULT 'standard'
                      CHECK (cadence_tier IN ('hot', 'standard', 'cold')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX company_normalized_domain_key
  ON company (normalized_domain);

-- ---------------------------------------------------------------------------
-- Career sources. One company may have several (a global board plus a
-- India-specific one, say), which is also how the same role can legitimately
-- appear twice and need cross-source linking rather than merging.
-- ---------------------------------------------------------------------------

CREATE TABLE career_source (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  ats_type             text NOT NULL REFERENCES ats_platform(id),
  board_identifier     text NOT NULL,
  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'degraded', 'disabled')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_run_at          timestamptz,
  next_run_at          timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- The same board token cannot be registered twice, which is the cheapest
-- possible defence against ingesting one company's jobs under two identities.
CREATE UNIQUE INDEX career_source_board_key
  ON career_source (ats_type, board_identifier);

CREATE INDEX career_source_due_idx
  ON career_source (next_run_at)
  WHERE status <> 'disabled';

-- ---------------------------------------------------------------------------
-- Postings.
--
-- ADR D-03: (career_source_id, source_job_id) is the authoritative identity.
-- Nothing merges two source records into one posting - similarity only links
-- them into an advisory group (below), and that link is reversible.
-- ---------------------------------------------------------------------------

CREATE TABLE job_posting (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  career_source_id   uuid NOT NULL REFERENCES career_source(id) ON DELETE CASCADE,
  company_id         uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  source_job_id      text NOT NULL,
  canonical_title    text NOT NULL,
  normalized_title   text NOT NULL,
  seniority          text,
  employment_type    text,
  department         text,
  apply_url          text NOT NULL,
  -- Absence is counted, not acted on immediately: a posting is closed only
  -- after two consecutive successful runs miss it, so one odd response cannot
  -- retire a live job.
  absent_run_count   integer NOT NULL DEFAULT 0,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  reopened_at        timestamptz,
  is_repost          boolean NOT NULL DEFAULT false,
  current_version_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX job_posting_source_identity_key
  ON job_posting (career_source_id, source_job_id);

-- Group-link candidate lookup.
CREATE INDEX job_posting_company_title_idx
  ON job_posting (company_id, normalized_title);

-- The matcher only ever considers open postings, so the partial index keeps
-- closed history out of its hot path entirely.
CREATE INDEX job_posting_open_idx
  ON job_posting (company_id, last_seen_at DESC)
  WHERE closed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Versions. Append-only; a new row only on a meaningful content change.
-- Explanations are cached against a version (ADR D-09), so this is what makes
-- cache invalidation correct rather than approximate.
-- ---------------------------------------------------------------------------

CREATE TABLE job_posting_version (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_posting_id      uuid NOT NULL REFERENCES job_posting(id) ON DELETE CASCADE,
  content_fingerprint text NOT NULL,
  title               text NOT NULL,
  description_text    text,
  description_html    text,
  salary_min          numeric,
  salary_max          numeric,
  salary_currency     text,
  source_updated_at   timestamptz,
  captured_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_posting_version_posting_idx
  ON job_posting_version (job_posting_id, captured_at DESC);

CREATE UNIQUE INDEX job_posting_version_fingerprint_key
  ON job_posting_version (job_posting_id, content_fingerprint);

ALTER TABLE job_posting
  ADD CONSTRAINT job_posting_current_version_fk
  FOREIGN KEY (current_version_id)
  REFERENCES job_posting_version(id)
  ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Locations. Many per posting where the source itself lists several.
-- ---------------------------------------------------------------------------

CREATE TABLE job_posting_location (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_posting_id uuid NOT NULL REFERENCES job_posting(id) ON DELETE CASCADE,
  raw            text NOT NULL,
  city           text,
  region         text,
  country        text,
  work_mode      text CHECK (work_mode IN ('remote', 'hybrid', 'onsite')),
  is_primary     boolean NOT NULL DEFAULT false
);

CREATE INDEX job_posting_location_posting_idx
  ON job_posting_location (job_posting_id);

CREATE INDEX job_posting_location_city_idx
  ON job_posting_location (lower(city));

-- ---------------------------------------------------------------------------
-- Groups: a link structure holding no job content of its own.
--
-- Grouping changes exactly two things (ADR D-03/D-04): match lists render one
-- card per group, and notification suppression is keyed on the group. Storage,
-- matching and application all continue to operate on individual postings.
-- ---------------------------------------------------------------------------

CREATE TABLE job_group (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  representative_posting_id uuid REFERENCES job_posting(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_group_link (
  job_posting_id uuid PRIMARY KEY REFERENCES job_posting(id) ON DELETE CASCADE,
  job_group_id   uuid NOT NULL REFERENCES job_group(id) ON DELETE CASCADE,
  reason         text NOT NULL
                   CHECK (reason IN ('repost', 'cross_source', 'location_variant')),
  confidence     numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  linked_by      text NOT NULL DEFAULT 'rule'
                   CHECK (linked_by IN ('rule', 'manual')),
  linked_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_group_link_group_idx ON job_group_link (job_group_id);

-- ---------------------------------------------------------------------------
-- Run log. Written on every attempt, success or failure - silent adapter
-- breakage is the most likely way this product quietly dies (ADR §29).
-- ---------------------------------------------------------------------------

CREATE TABLE scrape_run (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  career_source_id uuid NOT NULL REFERENCES career_source(id) ON DELETE CASCADE,
  status           text NOT NULL CHECK (status IN ('success', 'failure', 'skipped')),
  http_status      integer,
  postings_seen    integer NOT NULL DEFAULT 0,
  postings_new     integer NOT NULL DEFAULT 0,
  postings_updated integer NOT NULL DEFAULT 0,
  postings_closed  integer NOT NULL DEFAULT 0,
  error            text,
  duration_ms      integer,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);

CREATE INDEX scrape_run_source_idx
  ON scrape_run (career_source_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON
  company, career_source, job_posting, job_posting_version,
  job_posting_location, job_group, job_group_link, scrape_run
  TO app_ingest;
GRANT SELECT ON ats_platform TO app_ingest;

GRANT SELECT ON
  ats_platform, company, career_source, job_posting, job_posting_version,
  job_posting_location, job_group, job_group_link, scrape_run
  TO app_web;

GRANT SELECT ON
  ats_platform, company, career_source, job_posting, job_posting_version,
  job_posting_location, job_group, job_group_link
  TO app_matcher;
