-- 0017 · Application workspace, part 2: outreach drafts + Gmail credential
-- storage (Phase 7). job_application/application_event/resume_artifact
-- already exist (0008) - this migration adds exactly the two tables that
-- didn't: the outreach tracker and the encrypted refresh token Gmail
-- sending needs (Phase 7's send step, and Phase 8's event-triggered
-- notification emails, both reuse the same stored credential).

-- ---------------------------------------------------------------------------
-- outreach_draft - one draft (later: approved, later: sent) message tied to
-- one application. Never auto-sent (D-3/PRD §30): status only ever advances
-- through an explicit human action at each step.
-- ---------------------------------------------------------------------------

CREATE TABLE outreach_draft (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  application_id    uuid NOT NULL REFERENCES job_application(id) ON DELETE CASCADE,
  to_email          text NOT NULL,
  to_name           text,
  subject           text NOT NULL,
  body              text NOT NULL,
  status            text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'sent')),
  -- Set only once status = 'sent' - Gmail's own id for the sent message,
  -- kept so "did this actually go out" is answerable from this row alone
  -- without calling Gmail again.
  gmail_message_id  text,
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outreach_draft_app_idx
  ON outreach_draft (application_id, created_at DESC);

ALTER TABLE outreach_draft ENABLE ROW LEVEL SECURITY;

CREATE POLICY outreach_draft_tenant_select ON outreach_draft
  FOR SELECT
  USING (account_id = app_current_account_id());

CREATE POLICY outreach_draft_tenant_insert ON outreach_draft
  FOR INSERT
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY outreach_draft_tenant_update ON outreach_draft
  FOR UPDATE
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY outreach_draft_tenant_delete ON outreach_draft
  FOR DELETE
  USING (account_id = app_current_account_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON outreach_draft TO app_web;

-- ---------------------------------------------------------------------------
-- email_credential - one Gmail connection per account, for outreach send
-- (Phase 7) and event-triggered notification email (Phase 8's
-- job_search.stopped/match.computed -> email wiring). Deliberately NOT a
-- D-31 purge target: linking an inbox is a standing account-level
-- connection like Google sign-in, not something a specific job search did -
-- exactly the same reasoning that already keeps candidate_profile out of
-- jobSearch.ts's PURGE_TABLES.
--
-- The refresh token is pgcrypto-encrypted (pgp_sym_encrypt/pgp_sym_decrypt,
-- extension already enabled by 0001) rather than stored plaintext - the one
-- credential in this schema that grants a real external capability (sending
-- mail as the candidate) if it ever leaked from a backup or a stray SELECT
-- *. The symmetric key lives in application config
-- (EMAIL_CREDENTIAL_ENCRYPTION_KEY), never in this database.
-- ---------------------------------------------------------------------------

CREATE TABLE email_credential (
  account_id              uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  provider                text NOT NULL DEFAULT 'google' CHECK (provider = 'google'),
  email                   text NOT NULL,
  encrypted_refresh_token bytea NOT NULL,
  scope                   text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE email_credential ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_credential_tenant_select ON email_credential
  FOR SELECT
  USING (account_id = app_current_account_id());

CREATE POLICY email_credential_tenant_insert ON email_credential
  FOR INSERT
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY email_credential_tenant_update ON email_credential
  FOR UPDATE
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

CREATE POLICY email_credential_tenant_delete ON email_credential
  FOR DELETE
  USING (account_id = app_current_account_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON email_credential TO app_web;
