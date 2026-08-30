import { AccountId, type MemberRole, UserId } from '@jobswitch/core';
import type { Queryable } from '../context.js';
import { generateToken, hashToken } from './identity.js';

export interface SessionRecord {
  id: string;
  userId: UserId;
  accountId: AccountId;
  role: MemberRole;
  expiresAt: Date;
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export async function createSession(
  tx: Queryable,
  params: {
    userId: UserId;
    accountId: AccountId;
    ttlSeconds: number;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<CreatedSession> {
  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO user_session
       (user_id, account_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      params.userId,
      params.accountId,
      hash,
      expiresAt,
      params.ipAddress ?? null,
      params.userAgent ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('session insert returned no row');

  return { token: raw, sessionId: row.id, expiresAt };
}

/**
 * Resolve a raw session token to its principal.
 *
 * The role is joined from account_member on every lookup rather than being
 * copied into the session row. A membership revoked mid-session then takes
 * effect on the next request instead of persisting until the session expires.
 */
export async function findSessionByToken(
  tx: Queryable,
  rawToken: string,
): Promise<SessionRecord | null> {
  const { rows } = await tx.query<{
    id: string;
    user_id: string;
    account_id: string;
    role: MemberRole;
    expires_at: Date;
  }>(
    `SELECT s.id, s.user_id, s.account_id, am.role, s.expires_at
     FROM user_session s
     JOIN app_user u ON u.id = s.user_id AND u.deleted_at IS NULL
     JOIN account a ON a.id = s.account_id AND a.deleted_at IS NULL
     JOIN account_member am
       ON am.account_id = s.account_id AND am.user_id = s.user_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()`,
    [hashToken(rawToken)],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    userId: UserId(row.user_id),
    accountId: AccountId(row.account_id),
    role: row.role,
    expiresAt: row.expires_at,
  };
}

/**
 * Record activity, at most once a minute per session.
 *
 * Writing last_seen_at on every request would turn a read-mostly hot path into
 * a write on every page view, for information nobody needs to the second.
 */
export async function touchSession(
  tx: Queryable,
  sessionId: string,
): Promise<void> {
  await tx.query(
    `UPDATE user_session
     SET last_seen_at = now()
     WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`,
    [sessionId],
  );
}

export async function revokeSession(
  tx: Queryable,
  sessionId: string,
): Promise<void> {
  await tx.query(
    'UPDATE user_session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [sessionId],
  );
}

/**
 * Revoke every session for a user.
 *
 * Called after a password reset. If an attacker holds a stolen session, a
 * password change that left it alive would not actually lock them out - which
 * is the main thing the user is trying to do.
 */
export async function revokeAllSessionsForUser(
  tx: Queryable,
  userId: UserId,
): Promise<number> {
  const { rowCount } = await tx.query(
    'UPDATE user_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  return rowCount ?? 0;
}

export async function deleteExpiredSessions(
  tx: Queryable,
  olderThanDays = 30,
): Promise<number> {
  const { rowCount } = await tx.query(
    `DELETE FROM user_session
     WHERE expires_at < now() - ($1 || ' days')::interval`,
    [String(olderThanDays)],
  );
  return rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Password reset tokens
// ---------------------------------------------------------------------------

export async function createPasswordResetToken(
  tx: Queryable,
  params: { userId: UserId; ttlSeconds: number; ipAddress?: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  // Invalidate outstanding tokens first: requesting a new link should make the
  // old one stop working, or a leaked earlier email stays usable.
  await tx.query(
    `UPDATE password_reset_token SET used_at = now()
     WHERE user_id = $1 AND used_at IS NULL`,
    [params.userId],
  );

  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);

  await tx.query(
    `INSERT INTO password_reset_token (user_id, token_hash, expires_at, ip_address)
     VALUES ($1, $2, $3, $4)`,
    [params.userId, hash, expiresAt, params.ipAddress ?? null],
  );

  return { token: raw, expiresAt };
}

export type ResetTokenLookup =
  | { status: 'valid'; userId: UserId; tokenId: string }
  | { status: 'expired' }
  | { status: 'invalid' };

export async function findPasswordResetToken(
  tx: Queryable,
  rawToken: string,
): Promise<ResetTokenLookup> {
  const { rows } = await tx.query<{
    id: string;
    user_id: string;
    expires_at: Date;
    used_at: Date | null;
  }>(
    `SELECT id, user_id, expires_at, used_at
     FROM password_reset_token
     WHERE token_hash = $1`,
    [hashToken(rawToken)],
  );

  const row = rows[0];
  if (!row) return { status: 'invalid' };
  // A used token is reported as invalid rather than expired: "already used"
  // would confirm to a stranger that the token was real.
  if (row.used_at !== null) return { status: 'invalid' };
  if (row.expires_at.getTime() <= Date.now()) return { status: 'expired' };

  return { status: 'valid', userId: UserId(row.user_id), tokenId: row.id };
}

/**
 * Consume a reset token.
 *
 * The `used_at IS NULL` predicate makes this a compare-and-set: two concurrent
 * requests with the same token cannot both succeed, and the loser sees
 * rowCount 0.
 */
export async function consumePasswordResetToken(
  tx: Queryable,
  tokenId: string,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE password_reset_token SET used_at = now()
     WHERE id = $1 AND used_at IS NULL`,
    [tokenId],
  );
  return (rowCount ?? 0) === 1;
}
