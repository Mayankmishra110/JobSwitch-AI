import {
  AccountId,
  type ApplicationEvent,
  type ApplicationStatus,
  type CreateApplicationInput,
  type JobApplication,
} from '@jobswitch/core';
import type { Queryable } from '../context.js';

/**
 * The application tracker (Phase 7) - `job_application` +
 * `application_event`. Schema is Phase 5's (migration 0008); this is the
 * first application-layer code to read or write it. See
 * specs/application-workspace.md.
 */

interface ApplicationRow {
  id: string;
  account_id: string;
  job_posting_id: string | null;
  source: 'match' | 'manual';
  manual_company: string | null;
  manual_title: string | null;
  manual_url: string | null;
  manual_jd_text: string | null;
  status: ApplicationStatus;
  applied_at: Date | null;
  next_action_at: Date | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  posting_title: string | null;
  posting_company: string | null;
  posting_description: string | null;
}

const APPLICATION_SELECT = `
  SELECT a.id, a.account_id, a.job_posting_id, a.source, a.manual_company, a.manual_title,
         a.manual_url, a.manual_jd_text, a.status, a.applied_at, a.next_action_at, a.notes,
         a.created_at, a.updated_at,
         v.title AS posting_title, co.name AS posting_company, v.description_text AS posting_description
  FROM job_application a
  LEFT JOIN job_posting jp ON jp.id = a.job_posting_id
  LEFT JOIN job_posting_version v ON v.id = jp.current_version_id
  LEFT JOIN company co ON co.id = jp.company_id
`;

function toApplication(row: ApplicationRow): JobApplication {
  return {
    id: row.id,
    accountId: AccountId(row.account_id),
    jobPostingId: row.job_posting_id,
    source: row.source,
    manualCompany: row.manual_company,
    manualTitle: row.manual_title,
    manualUrl: row.manual_url,
    manualJdText: row.manual_jd_text,
    status: row.status,
    appliedAt: row.applied_at,
    nextActionAt: row.next_action_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    postingTitle: row.posting_title,
    postingCompany: row.posting_company,
    postingDescription: row.posting_description,
  };
}

/** The pipeline board's own order - matches job_application_board_idx exactly. */
export async function listApplications(
  tx: Queryable,
  accountId: AccountId,
): Promise<JobApplication[]> {
  const { rows } = await tx.query<ApplicationRow>(
    `${APPLICATION_SELECT} WHERE a.account_id = $1 ORDER BY a.status, a.updated_at DESC`,
    [accountId],
  );
  return rows.map(toApplication);
}

export async function getApplicationById(
  tx: Queryable,
  accountId: AccountId,
  applicationId: string,
): Promise<JobApplication | null> {
  const { rows } = await tx.query<ApplicationRow>(
    `${APPLICATION_SELECT} WHERE a.account_id = $1 AND a.id = $2`,
    [accountId, applicationId],
  );
  return rows[0] ? toApplication(rows[0]) : null;
}

/**
 * The job context Graph A/B need (title, company, description) - a manual
 * entry carries its own; a matched entry reads the joined posting's
 * current version, exactly like services/backend's own
 * GetJobExplanationContext (internal/repo/explain.go) does on the Go side
 * for the same reason (the description a candidate is tailored/explained
 * against must always be the CURRENT version, D-09).
 */
export function jobContextFor(
  application: JobApplication,
): { title: string; company: string | null; description: string } | null {
  if (application.source === 'manual') {
    if (!application.manualTitle || !application.manualJdText) return null;
    return {
      title: application.manualTitle,
      company: application.manualCompany,
      description: application.manualJdText,
    };
  }
  if (!application.postingTitle || !application.postingDescription) return null;
  return {
    title: application.postingTitle,
    company: application.postingCompany,
    description: application.postingDescription,
  };
}

export async function createManualApplication(
  tx: Queryable,
  accountId: AccountId,
  input: CreateApplicationInput,
): Promise<JobApplication> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO job_application
       (account_id, source, manual_company, manual_title, manual_url, manual_jd_text, status)
     VALUES ($1, 'manual', $2, $3, $4, $5, 'found')
     RETURNING id`,
    [accountId, input.manualCompany, input.manualTitle, input.manualUrl ?? null, input.manualJdText],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('job_application insert returned no row');

  await tx.query(
    `INSERT INTO application_event (account_id, application_id, from_status, to_status)
     VALUES ($1, $2, NULL, 'found')`,
    [accountId, id],
  );

  const created = await getApplicationById(tx, accountId, id);
  if (!created) throw new Error('job_application not found immediately after insert');
  return created;
}

/**
 * "Track" a match: create (or return the existing) application for a
 * job_posting_id this account has already been shown a job_match for.
 * Idempotent by design - job_application_account_posting_key (0008) is a
 * unique index on (account_id, job_posting_id), so tracking the same match
 * twice is a safe no-op that returns the row already there, never a
 * constraint-violation 500.
 */
export async function createApplicationFromMatch(
  tx: Queryable,
  accountId: AccountId,
  jobPostingId: string,
): Promise<JobApplication> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO job_application (account_id, job_posting_id, source, status)
     VALUES ($1, $2, 'match', 'found')
     ON CONFLICT (account_id, job_posting_id) WHERE job_posting_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [accountId, jobPostingId],
  );

  let id = rows[0]?.id;
  if (!id) {
    const { rows: existing } = await tx.query<{ id: string }>(
      `SELECT id FROM job_application WHERE account_id = $1 AND job_posting_id = $2`,
      [accountId, jobPostingId],
    );
    id = existing[0]?.id;
    if (!id) throw new Error('job_application insert conflicted but no existing row was found');
    const app = await getApplicationById(tx, accountId, id);
    if (!app) throw new Error('job_application not found after conflict lookup');
    return app;
  }

  await tx.query(
    `INSERT INTO application_event (account_id, application_id, from_status, to_status)
     VALUES ($1, $2, NULL, 'found')`,
    [accountId, id],
  );

  const created = await getApplicationById(tx, accountId, id);
  if (!created) throw new Error('job_application not found immediately after insert');
  return created;
}

export interface ApplicationPatch {
  status?: ApplicationStatus;
  notes?: string;
  nextActionAt?: Date;
  appliedAt?: Date;
}

/**
 * Writes job_application + application_event in one transaction (the build
 * plan's own explicit requirement for this endpoint) and, when the status
 * actually changed, publishes D-26's application.status_changed AFTER both
 * writes commit - see routes/applications.ts, which calls this inside
 * withAccount and publishes only once that call has returned successfully.
 */
export async function patchApplication(
  tx: Queryable,
  accountId: AccountId,
  applicationId: string,
  patch: ApplicationPatch,
): Promise<{ application: JobApplication; statusChanged: boolean; fromStatus: ApplicationStatus | null } | null> {
  const existing = await getApplicationById(tx, accountId, applicationId);
  if (!existing) return null;

  const nextStatus = patch.status ?? existing.status;
  const statusChanged = nextStatus !== existing.status;

  await tx.query(
    `UPDATE job_application
     SET status = $3, notes = COALESCE($4, notes), next_action_at = COALESCE($5, next_action_at),
         applied_at = COALESCE($6, applied_at), updated_at = now()
     WHERE account_id = $1 AND id = $2`,
    [
      accountId,
      applicationId,
      nextStatus,
      patch.notes ?? null,
      patch.nextActionAt ?? null,
      patch.appliedAt ?? null,
    ],
  );

  if (statusChanged) {
    await tx.query(
      `INSERT INTO application_event (account_id, application_id, from_status, to_status)
       VALUES ($1, $2, $3, $4)`,
      [accountId, applicationId, existing.status, nextStatus],
    );
  }

  const updated = await getApplicationById(tx, accountId, applicationId);
  if (!updated) throw new Error('job_application not found immediately after update');

  return { application: updated, statusChanged, fromStatus: existing.status };
}

export async function listApplicationEvents(
  tx: Queryable,
  accountId: AccountId,
  applicationId: string,
): Promise<ApplicationEvent[]> {
  const { rows } = await tx.query<{
    id: string;
    account_id: string;
    application_id: string;
    from_status: ApplicationStatus | null;
    to_status: ApplicationStatus;
    note: string | null;
    occurred_at: Date;
  }>(
    `SELECT id, account_id, application_id, from_status, to_status, note, occurred_at
     FROM application_event WHERE account_id = $1 AND application_id = $2
     ORDER BY occurred_at DESC`,
    [accountId, applicationId],
  );
  return rows.map((r) => ({
    id: r.id,
    accountId: AccountId(r.account_id),
    applicationId: r.application_id,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    note: r.note,
    occurredAt: r.occurred_at,
  }));
}
