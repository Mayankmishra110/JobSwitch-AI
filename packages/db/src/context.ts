import type { Pool, PoolClient } from 'pg';
import { type AccountId, isUuid } from '@jobswitch/core';

/**
 * Transaction helpers, including the RLS tenant context.
 *
 * ADR D-14. `withAccount` is the only sanctioned way for request-path code to
 * touch a tenant-scoped table. It opens a transaction, sets the tenant
 * context with SET LOCAL - which is scoped to that transaction and released
 * automatically, even on error - and runs the callback.
 *
 * SET LOCAL rather than SET matters more than it looks: pooled connections are
 * reused across requests, and a plain SET would leak one user's tenant context
 * to whoever got that connection next. That is the exact bug RLS exists to
 * prevent, so getting it wrong here would be self-defeating.
 */

export type Queryable = Pick<PoolClient, 'query'>;

export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A rollback failure means the connection is already broken; releasing
      // it below discards it. Surfacing the original error is more useful.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a transaction scoped to one tenant.
 *
 * The account id is validated as a UUID before interpolation. set_config is
 * called with a bound parameter, so this is not string concatenation into SQL
 * - but the UUID check is kept as a second barrier, because a non-UUID value
 * reaching here means a caller has already gone wrong.
 */
export async function withAccount<T>(
  pool: Pool,
  accountId: AccountId,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (!isUuid(accountId)) {
    throw new TypeError('withAccount requires a UUID account id');
  }
  return withTransaction(pool, async (tx) => {
    await tx.query('SELECT set_config($1, $2, true)', [
      'app.current_account_id',
      accountId,
    ]);
    return fn(tx);
  });
}

/**
 * Run `fn` with no tenant context.
 *
 * Legitimate only for Layer 0 identity work (login, signup, token lookup),
 * which by definition happens before an account is known. Named explicitly so
 * that reaching for it in request-path code is a visible decision rather than
 * an omission - if you find this wrapping a query against a tenant table, that
 * query returns zero rows and the bug is here.
 */
export async function withoutTenantContext<T>(
  pool: Pool,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, fn);
}
