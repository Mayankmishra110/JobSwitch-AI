import {
  AccountId,
  type AuditEntry,
  type AuditWrite,
  type AuditAction,
  UserId,
} from '@jobswitch/core';
import type { Queryable } from '../context.js';

/**
 * Audit log repository - tenant-scoped, so every call here MUST run inside
 * `withAccount`. Called from `withoutTenantContext` the insert is rejected by
 * the RLS WITH CHECK policy rather than silently landing in the wrong tenant.
 */

export async function writeAuditEntry(
  tx: Queryable,
  entry: AuditWrite,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log
       (account_id, actor_user_id, action, target, metadata, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.accountId,
      entry.actorUserId,
      entry.action,
      entry.target ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.ipAddress ?? null,
      entry.userAgent ?? null,
    ],
  );
}

export async function listAuditEntries(
  tx: Queryable,
  limit = 50,
): Promise<AuditEntry[]> {
  const { rows } = await tx.query<{
    id: string;
    account_id: string;
    actor_user_id: string | null;
    action: AuditAction;
    target: string | null;
    metadata: Record<string, unknown>;
    ip_address: string | null;
    user_agent: string | null;
    created_at: Date;
  }>(
    `SELECT id, account_id, actor_user_id, action, target, metadata,
            ip_address::text, user_agent, created_at
     FROM audit_log
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );

  return rows.map((row) => ({
    id: row.id,
    accountId: AccountId(row.account_id),
    actorUserId: row.actor_user_id ? UserId(row.actor_user_id) : null,
    action: row.action,
    target: row.target,
    metadata: row.metadata,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  }));
}
