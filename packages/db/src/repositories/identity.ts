import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AccountId,
  type AccountMembership,
  type MemberRole,
  UserId,
  type User,
  normalizeEmail,
} from '@jobswitch/core';
import type { Queryable } from '../context.js';

/**
 * Identity repository - Layer 0.
 *
 * Every function takes a `Queryable` rather than reaching for a pool itself,
 * so callers control transaction boundaries and a caller cannot accidentally
 * run half an operation outside the transaction it thinks it is in.
 */

interface UserRow {
  id: string;
  email: string;
  email_normalized: string;
  email_verified_at: Date | null;
  full_name: string | null;
  created_at: Date;
  deleted_at: Date | null;
}

function toUser(row: UserRow): User {
  return {
    id: UserId(row.id),
    email: row.email,
    emailNormalized: row.email_normalized,
    emailVerifiedAt: row.email_verified_at,
    fullName: row.full_name,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

const USER_COLUMNS = `id, email, email_normalized, email_verified_at,
                      full_name, created_at, deleted_at`;

/** Same columns, qualified, for queries that join against app_user. */
const USER_COLUMNS_QUALIFIED = `u.id, u.email, u.email_normalized,
                                u.email_verified_at, u.full_name,
                                u.created_at, u.deleted_at`;

export async function findUserByEmail(
  tx: Queryable,
  email: string,
): Promise<User | null> {
  const { rows } = await tx.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM app_user
     WHERE email_normalized = $1 AND deleted_at IS NULL`,
    [normalizeEmail(email)],
  );
  return rows[0] ? toUser(rows[0]) : null;
}

export async function findUserById(
  tx: Queryable,
  userId: UserId,
): Promise<User | null> {
  const { rows } = await tx.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM app_user
     WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  return rows[0] ? toUser(rows[0]) : null;
}

export async function getPasswordHash(
  tx: Queryable,
  userId: UserId,
): Promise<string | null> {
  const { rows } = await tx.query<{ password_hash: string }>(
    'SELECT password_hash FROM user_credential WHERE user_id = $1',
    [userId],
  );
  return rows[0]?.password_hash ?? null;
}

export async function setPasswordHash(
  tx: Queryable,
  userId: UserId,
  passwordHash: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO user_credential (user_id, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (user_id)
     DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
    [userId, passwordHash],
  );
}

/**
 * Create a user together with their personal account and owner membership.
 *
 * These three rows are meaningless apart - a user with no account cannot do
 * anything, and an account with no member is unreachable - so they are created
 * together and the caller is expected to be inside a transaction.
 */
export async function createUserWithAccount(
  tx: Queryable,
  params: {
    email: string;
    fullName?: string | null;
    emailVerified?: boolean;
  },
): Promise<{ user: User; accountId: AccountId }> {
  const normalized = normalizeEmail(params.email);

  const { rows: accountRows } = await tx.query<{ id: string }>(
    `INSERT INTO account (type, display_name) VALUES ('personal', $1)
     RETURNING id`,
    [params.fullName ?? null],
  );
  const accountRow = accountRows[0];
  if (!accountRow) throw new Error('account insert returned no row');
  const accountId = AccountId(accountRow.id);

  const { rows: userRows } = await tx.query<UserRow>(
    `INSERT INTO app_user (email, email_normalized, full_name, email_verified_at)
     VALUES ($1, $2, $3, $4)
     RETURNING ${USER_COLUMNS}`,
    [
      params.email.trim(),
      normalized,
      params.fullName ?? null,
      params.emailVerified ? new Date() : null,
    ],
  );
  const userRow = userRows[0];
  if (!userRow) throw new Error('user insert returned no row');
  const user = toUser(userRow);

  await tx.query(
    `INSERT INTO account_member (account_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [accountId, user.id],
  );

  return { user, accountId };
}

export async function findPrimaryMembership(
  tx: Queryable,
  userId: UserId,
): Promise<AccountMembership | null> {
  const { rows } = await tx.query<{
    account_id: string;
    user_id: string;
    role: MemberRole;
    created_at: Date;
  }>(
    `SELECT am.account_id, am.user_id, am.role, am.created_at
     FROM account_member am
     JOIN account a ON a.id = am.account_id
     WHERE am.user_id = $1 AND a.deleted_at IS NULL
     ORDER BY am.created_at ASC
     LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    accountId: AccountId(row.account_id),
    userId: UserId(row.user_id),
    role: row.role,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// OAuth identities
// ---------------------------------------------------------------------------

export async function findUserByOauthIdentity(
  tx: Queryable,
  provider: 'google',
  providerUserId: string,
): Promise<User | null> {
  const { rows } = await tx.query<UserRow>(
    `SELECT ${USER_COLUMNS_QUALIFIED}
     FROM oauth_identity oi
     JOIN app_user u ON u.id = oi.user_id
     WHERE oi.provider = $1 AND oi.provider_user_id = $2
       AND u.deleted_at IS NULL`,
    [provider, providerUserId],
  );
  return rows[0] ? toUser(rows[0]) : null;
}

export async function linkOauthIdentity(
  tx: Queryable,
  params: {
    userId: UserId;
    provider: 'google';
    providerUserId: string;
    emailAtLink: string | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO oauth_identity (user_id, provider, provider_user_id, email_at_link)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, provider_user_id) DO NOTHING`,
    [
      params.userId,
      params.provider,
      params.providerUserId,
      params.emailAtLink,
    ],
  );
}

// ---------------------------------------------------------------------------
// Opaque tokens: sessions and password resets.
//
// Generate 32 random bytes, hand the base64url form to the user, store only
// the SHA-256 hash. Lookup hashes the presented value and compares. A database
// dump therefore yields no usable session or reset token.
//
// SHA-256 without a work factor is correct here and wrong for passwords: these
// are 256-bit random values, so there is no dictionary to attack, and the hot
// path runs on every request.
// ---------------------------------------------------------------------------

export interface IssuedToken {
  raw: string;
  hash: Buffer;
}

export function generateToken(): IssuedToken {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): Buffer {
  return createHash('sha256').update(raw, 'utf8').digest();
}

/** Constant-time compare, for the rare paths that compare hashes in Node. */
export function tokensMatch(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
