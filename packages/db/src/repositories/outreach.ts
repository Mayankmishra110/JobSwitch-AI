import { AccountId, type CreateOutreachInput, type OutreachDraft, type PatchOutreachInput } from '@jobswitch/core';
import type { Queryable } from '../context.js';

/**
 * Outreach drafts (Phase 7, migration 0017) - `outreach_draft`. Never
 * auto-sent: status only ever advances through an explicit action at each
 * step (draft -> approved -> sent), enforced here by every transition
 * function requiring the row to already be in the expected prior status.
 */

interface OutreachRow {
  id: string;
  account_id: string;
  application_id: string;
  to_email: string;
  to_name: string | null;
  subject: string;
  body: string;
  status: 'draft' | 'approved' | 'sent';
  gmail_message_id: string | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const OUTREACH_COLUMNS = `id, account_id, application_id, to_email, to_name, subject, body,
  status, gmail_message_id, sent_at, created_at, updated_at`;

function toOutreach(row: OutreachRow): OutreachDraft {
  return {
    id: row.id,
    accountId: AccountId(row.account_id),
    applicationId: row.application_id,
    toEmail: row.to_email,
    toName: row.to_name,
    subject: row.subject,
    body: row.body,
    status: row.status,
    gmailMessageId: row.gmail_message_id,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every draft across every application for this account, most recent first - the outreach inbox view. */
export async function listOutreachForAccount(tx: Queryable, accountId: AccountId): Promise<OutreachDraft[]> {
  const { rows } = await tx.query<OutreachRow>(
    `SELECT ${OUTREACH_COLUMNS} FROM outreach_draft WHERE account_id = $1 ORDER BY created_at DESC`,
    [accountId],
  );
  return rows.map(toOutreach);
}

export async function listOutreachForApplication(
  tx: Queryable,
  accountId: AccountId,
  applicationId: string,
): Promise<OutreachDraft[]> {
  const { rows } = await tx.query<OutreachRow>(
    `SELECT ${OUTREACH_COLUMNS} FROM outreach_draft
     WHERE account_id = $1 AND application_id = $2
     ORDER BY created_at DESC`,
    [accountId, applicationId],
  );
  return rows.map(toOutreach);
}

export async function getOutreachById(
  tx: Queryable,
  accountId: AccountId,
  outreachId: string,
): Promise<OutreachDraft | null> {
  const { rows } = await tx.query<OutreachRow>(
    `SELECT ${OUTREACH_COLUMNS} FROM outreach_draft WHERE account_id = $1 AND id = $2`,
    [accountId, outreachId],
  );
  return rows[0] ? toOutreach(rows[0]) : null;
}

export async function createOutreachDraft(
  tx: Queryable,
  accountId: AccountId,
  applicationId: string,
  input: CreateOutreachInput,
  content: { subject: string; body: string },
): Promise<OutreachDraft> {
  const { rows } = await tx.query<OutreachRow>(
    `INSERT INTO outreach_draft (account_id, application_id, to_email, to_name, subject, body)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${OUTREACH_COLUMNS}`,
    [accountId, applicationId, input.toEmail, input.toName ?? null, content.subject, content.body],
  );
  const row = rows[0];
  if (!row) throw new Error('outreach_draft insert returned no row');
  return toOutreach(row);
}

/** Only while status = 'draft' - an approved or sent message is no longer editable. */
export async function patchOutreachDraft(
  tx: Queryable,
  accountId: AccountId,
  outreachId: string,
  patch: PatchOutreachInput,
): Promise<OutreachDraft | null> {
  const existing = await getOutreachById(tx, accountId, outreachId);
  if (!existing || existing.status !== 'draft') return null;

  const { rows } = await tx.query<OutreachRow>(
    `UPDATE outreach_draft
     SET to_email = $3, to_name = $4, subject = $5, body = $6, updated_at = now()
     WHERE account_id = $1 AND id = $2
     RETURNING ${OUTREACH_COLUMNS}`,
    [
      accountId,
      outreachId,
      patch.toEmail ?? existing.toEmail,
      patch.toName !== undefined ? patch.toName : existing.toName,
      patch.subject ?? existing.subject,
      patch.body ?? existing.body,
    ],
  );
  return rows[0] ? toOutreach(rows[0]) : null;
}

/** draft -> approved. Returns null if the row wasn't in 'draft' (already approved/sent, or doesn't exist). */
export async function approveOutreachDraft(
  tx: Queryable,
  accountId: AccountId,
  outreachId: string,
): Promise<OutreachDraft | null> {
  const { rows } = await tx.query<OutreachRow>(
    `UPDATE outreach_draft SET status = 'approved', updated_at = now()
     WHERE account_id = $1 AND id = $2 AND status = 'draft'
     RETURNING ${OUTREACH_COLUMNS}`,
    [accountId, outreachId],
  );
  return rows[0] ? toOutreach(rows[0]) : null;
}

/**
 * approved -> sent. Compare-and-set on status = 'approved' in the WHERE
 * clause itself (the build plan's own words: "compare-and-set, 409 if not
 * approved") - the route distinguishes "no such draft" from "not approved"
 * by re-reading the row when this returns null, never by racing a separate
 * check-then-act.
 */
export async function markOutreachSent(
  tx: Queryable,
  accountId: AccountId,
  outreachId: string,
  gmailMessageId: string,
): Promise<OutreachDraft | null> {
  const { rows } = await tx.query<OutreachRow>(
    `UPDATE outreach_draft SET status = 'sent', gmail_message_id = $3, sent_at = now(), updated_at = now()
     WHERE account_id = $1 AND id = $2 AND status = 'approved'
     RETURNING ${OUTREACH_COLUMNS}`,
    [accountId, outreachId, gmailMessageId],
  );
  return rows[0] ? toOutreach(rows[0]) : null;
}
