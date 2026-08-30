-- 0001 · Extensions, database roles, and the RLS helper.
--
-- ADR D-14: four roles with different grants. The single most valuable
-- property established here is that `app_ingest` has NO grant on tenant
-- tables at all. Ingestion adapters process untrusted third-party content and
-- are the component most likely to be exploited; they must not be able to
-- read a resume even if fully compromised.
--
-- Roles are cluster-wide in Postgres, so they are created idempotently.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Roles. NOLOGIN group roles; deployment grants them to real login users and
-- sets passwords out of band. Creating them without LOGIN means a migration
-- can never accidentally create a credentialed account.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_web') THEN
    CREATE ROLE app_web NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ingest') THEN
    CREATE ROLE app_ingest NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_matcher') THEN
    CREATE ROLE app_matcher NOLOGIN;
  END IF;
END
$$;

-- app_matcher writes match rows for every account in one batch pass, so it
-- bypasses RLS. It compensates by iterating accounts with an explicit context
-- per account (ADR §13) rather than issuing cross-tenant queries.
ALTER ROLE app_matcher BYPASSRLS;

-- Nobody gets the public schema by default.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_web, app_ingest, app_matcher;

-- ---------------------------------------------------------------------------
-- The RLS context helper.
--
-- `current_setting(..., true)` returns NULL rather than raising when the
-- setting is absent. That is the whole safety property: a query issued
-- without a tenant context matches zero rows instead of every row.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_current_account_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_account_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app_current_account_id() IS
  'Tenant context for RLS. NULL when unset, so an unscoped query returns no rows.';

GRANT EXECUTE ON FUNCTION app_current_account_id() TO app_web, app_matcher;
