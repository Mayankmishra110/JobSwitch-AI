import { AccountId, type EmailCredentialStatus } from '@jobswitch/core';
import type { Queryable } from '../context.js';

/**
 * Gmail credential storage (Phase 7, migration 0017) - one row per account,
 * refresh token encrypted at rest with pgcrypto's pgp_sym_encrypt/
 * pgp_sym_decrypt. The symmetric key is passed as a bound parameter on
 * every call here, never stored in this database - it lives in
 * config.EMAIL_CREDENTIAL_ENCRYPTION_KEY (apps/web/src/config.ts).
 *
 * The decrypted token has exactly one legitimate caller:
 * services/gmailSend.ts, right before it calls Google's token endpoint -
 * every other piece of this codebase only ever needs getStatus's
 * connected/email view.
 */

export async function getCredentialStatus(
  tx: Queryable,
  accountId: AccountId,
): Promise<EmailCredentialStatus> {
  const { rows } = await tx.query<{ email: string }>(
    `SELECT email FROM email_credential WHERE account_id = $1`,
    [accountId],
  );
  const row = rows[0];
  return row ? { connected: true, email: row.email } : { connected: false, email: null };
}

export async function upsertCredential(
  tx: Queryable,
  accountId: AccountId,
  input: { email: string; refreshToken: string; scope: string },
  encryptionKey: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO email_credential (account_id, email, encrypted_refresh_token, scope)
     VALUES ($1, $2, pgp_sym_encrypt($3, $4), $5)
     ON CONFLICT (account_id) DO UPDATE SET
       email = EXCLUDED.email,
       encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
       scope = EXCLUDED.scope,
       updated_at = now()`,
    [accountId, input.email, input.refreshToken, encryptionKey, input.scope],
  );
}

export async function getDecryptedRefreshToken(
  tx: Queryable,
  accountId: AccountId,
  encryptionKey: string,
): Promise<string | null> {
  const { rows } = await tx.query<{ refresh_token: string }>(
    `SELECT pgp_sym_decrypt(encrypted_refresh_token, $2) AS refresh_token
     FROM email_credential WHERE account_id = $1`,
    [accountId, encryptionKey],
  );
  return rows[0]?.refresh_token ?? null;
}

export async function deleteCredential(tx: Queryable, accountId: AccountId): Promise<boolean> {
  const { rowCount } = await tx.query(`DELETE FROM email_credential WHERE account_id = $1`, [
    accountId,
  ]);
  return (rowCount ?? 0) > 0;
}
