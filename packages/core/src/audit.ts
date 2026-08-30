import type { AccountId, UserId } from './ids.js';

/**
 * Audit actions.
 *
 * `audit_log` is the first genuinely tenant-scoped table in the system, so it
 * is also where RLS is proven end to end (see packages/db/test/rls.test.ts).
 * The list is a closed union rather than a free string so that a typo becomes
 * a compile error instead of an unqueryable row.
 */
export type AuditAction =
  | 'user.signed_up'
  | 'user.signed_in'
  | 'user.signed_in_oauth'
  | 'user.signed_out'
  | 'user.sign_in_failed'
  | 'password.reset_requested'
  | 'password.reset_completed'
  | 'session.revoked'
  | 'session.revoked_all'
  | 'account.created';

export interface AuditEntry {
  id: string;
  accountId: AccountId;
  actorUserId: UserId | null;
  action: AuditAction;
  target: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface AuditWrite {
  accountId: AccountId;
  actorUserId: UserId | null;
  action: AuditAction;
  target?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}
