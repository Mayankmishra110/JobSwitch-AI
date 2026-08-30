-- 0004 · audit_log - the first tenant-scoped table, and the RLS template.
--
-- Every Layer 2-4 table added after this one follows exactly this shape:
--
--   1. an `account_id uuid NOT NULL REFERENCES account(id)` column;
--   2. `ENABLE ROW LEVEL SECURITY`;
--   3. a policy comparing account_id against app_current_account_id();
--   4. grants to app_web, and to app_matcher only where it must write.
--
-- Note ENABLE, not FORCE. The table owner (the migration role) intentionally
-- bypasses RLS so migrations and backfills work; app_web is a different role,
-- so the policy applies to it. If ownership ever changes, revisit this.

CREATE TABLE audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  action        text NOT NULL,
  target        text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_account_created_idx
  ON audit_log (account_id, created_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Reads are tenant-scoped.
CREATE POLICY audit_log_tenant_select ON audit_log
  FOR SELECT
  USING (account_id = app_current_account_id());

-- Writes must also be tenant-scoped: WITH CHECK stops a request operating in
-- account A from inserting a row attributed to account B. Without it, RLS
-- would protect reads while leaving writes wide open - a common and quiet
-- half-implementation.
CREATE POLICY audit_log_tenant_insert ON audit_log
  FOR INSERT
  WITH CHECK (account_id = app_current_account_id());

-- No UPDATE or DELETE policy is defined, so neither is permitted for app_web
-- under RLS. The audit log is append-only by construction rather than by
-- convention.

GRANT SELECT, INSERT ON audit_log TO app_web;
