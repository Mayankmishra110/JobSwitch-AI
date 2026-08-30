-- 0002 · Layer 0, the identity boundary.
--
-- BOUNDARY REFINEMENT TO THE ADR, worth stating explicitly:
--
-- Authentication necessarily precedes tenancy. At the moment a login request
-- arrives there is no account context yet - finding the account IS the point
-- of the request. So these tables cannot be RLS-scoped by account_id without
-- creating a chicken-and-egg problem.
--
-- They therefore form "Layer 0 - Identity": not tenant-scoped, reachable only
-- by app_web, never by workers. Tenant RLS begins at Layer 2 and above, where
-- an account context always exists by the time a query runs.
--
-- The security properties for Layer 0 come from elsewhere:
--   * only app_web holds any grant on these tables;
--   * every lookup is by unguessable token or by email under rate limiting;
--   * secrets are stored hashed, never in plaintext.

-- ---------------------------------------------------------------------------
-- Accounts - the tenant root.
-- ---------------------------------------------------------------------------

CREATE TABLE account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL DEFAULT 'personal'
                  CHECK (type IN ('personal', 'organization')),
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

COMMENT ON TABLE account IS
  'Tenant root. Every Layer 2-4 table references this, never user.id (ADR D-17).';

-- ---------------------------------------------------------------------------
-- Users - the identity. Separate from account so organizations can arrive
-- later without reshaping anything.
-- ---------------------------------------------------------------------------

CREATE TABLE app_user (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  email_normalized  text NOT NULL,
  email_verified_at timestamptz,
  full_name         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

-- Partial unique index rather than a plain UNIQUE: a deleted user's address
-- must be reusable, or someone who deletes their account can never come back.
CREATE UNIQUE INDEX app_user_email_normalized_key
  ON app_user (email_normalized)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Credentials, split from the user row.
--
-- Separating the hash means an accidental `SELECT *` on app_user - in a log
-- line, an error report, a debug endpoint - cannot leak password material.
-- ---------------------------------------------------------------------------

CREATE TABLE user_credential (
  user_id       uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  algorithm     text NOT NULL DEFAULT 'argon2id',
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Membership. Degenerate at MVP (exactly one row per user, role 'owner') but
-- present from day one so organizations cost rows rather than a migration.
-- ---------------------------------------------------------------------------

CREATE TABLE account_member (
  account_id uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'owner'
               CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

CREATE INDEX account_member_user_id_idx ON account_member (user_id);

-- ---------------------------------------------------------------------------
-- Federated identities. Config-gated; the table exists regardless so the
-- provider column has somewhere to live from the start.
-- ---------------------------------------------------------------------------

CREATE TABLE oauth_identity (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('google')),
  provider_user_id text NOT NULL,
  email_at_link    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);

CREATE INDEX oauth_identity_user_id_idx ON oauth_identity (user_id);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON account, app_user, user_credential, account_member, oauth_identity
  TO app_web;

-- app_ingest and app_matcher get nothing here. That omission is the control.
