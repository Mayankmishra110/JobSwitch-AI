-- 0003 · Sessions and password reset tokens.
--
-- Both tables store a SHA-256 hash of the token, never the token itself. The
-- raw value exists only in the user's cookie or in the emailed link. A dump of
-- this database therefore does not let an attacker mint a working session or
-- reset anyone's password - it yields hashes with nothing to unlock.

CREATE TABLE user_session (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  token_hash       bytea NOT NULL,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  ip_address       inet,
  user_agent       text
);

CREATE UNIQUE INDEX user_session_token_hash_key ON user_session (token_hash);

-- The session-validation hot path: one index-only lookup on every request.
CREATE INDEX user_session_active_idx
  ON user_session (user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE password_reset_token (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  ip_address inet
);

CREATE UNIQUE INDEX password_reset_token_hash_key
  ON password_reset_token (token_hash);

CREATE INDEX password_reset_token_user_idx
  ON password_reset_token (user_id)
  WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON user_session, password_reset_token
  TO app_web;
