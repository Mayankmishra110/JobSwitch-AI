import {
  AccountId,
  EMBED_PROFILE_QUEUE,
  type EmbedProfilePayload,
  type JobSearchSession,
  type JobSearchStopReason,
  type ResumeUpload,
} from '@jobswitch/core';
import type { Queryable } from '../context.js';
import * as queueRepo from './queue.js';

/**
 * Job search lifecycle and ephemeral resume retention (ADR D-31).
 *
 * "Start" and "upload a resume" are one action, and so are "stop" and
 * "purge everything that search touched" - see packages/core's
 * startJobSearchInput and the PRD §30 framing this whole mechanic extends.
 */

// ---------------------------------------------------------------------------
// job_search_session
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  account_id: string;
  status: 'active' | 'stopped';
  started_at: Date;
  stopped_at: Date | null;
  stop_reason: JobSearchStopReason | null;
}

const SESSION_COLUMNS = 'id, account_id, status, started_at, stopped_at, stop_reason';

function toSession(row: SessionRow): JobSearchSession {
  return {
    id: row.id,
    accountId: AccountId(row.account_id),
    status: row.status,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    stopReason: row.stop_reason,
  };
}

export async function getActiveSession(
  tx: Queryable,
  accountId: AccountId,
): Promise<JobSearchSession | null> {
  const { rows } = await tx.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM job_search_session
     WHERE account_id = $1 AND status = 'active'`,
    [accountId],
  );
  return rows[0] ? toSession(rows[0]) : null;
}

interface ResumeUploadRow {
  account_id: string;
  filename: string;
  raw_text: string;
  uploaded_at: Date;
}

function toResumeUpload(row: ResumeUploadRow): ResumeUpload {
  return {
    accountId: AccountId(row.account_id),
    filename: row.filename,
    rawText: row.raw_text,
    uploadedAt: row.uploaded_at,
  };
}

export async function getResumeUpload(
  tx: Queryable,
  accountId: AccountId,
): Promise<ResumeUpload | null> {
  const { rows } = await tx.query<ResumeUploadRow>(
    'SELECT account_id, filename, raw_text, uploaded_at FROM resume_upload WHERE account_id = $1',
    [accountId],
  );
  return rows[0] ? toResumeUpload(rows[0]) : null;
}

/**
 * Turn on active job search and record the resume that drives it.
 *
 * Idempotent with respect to an already-active session: rather than
 * rejecting a second "start" (which the unique partial index on
 * job_search_session would otherwise turn into a constraint violation),
 * re-starting while already active is treated as "update my resume" - a
 * reasonable action, not an error, and the session itself is left alone
 * rather than churning a new row for no reason.
 */
export async function startJobSearch(
  tx: Queryable,
  accountId: AccountId,
  resume: { filename: string; rawText: string },
): Promise<{ session: JobSearchSession; resume: ResumeUpload }> {
  const existing = await getActiveSession(tx, accountId);

  const { rows: resumeRows } = await tx.query<ResumeUploadRow>(
    `INSERT INTO resume_upload (account_id, filename, raw_text, uploaded_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (account_id) DO UPDATE SET
       filename = EXCLUDED.filename,
       raw_text = EXCLUDED.raw_text,
       uploaded_at = EXCLUDED.uploaded_at
     RETURNING account_id, filename, raw_text, uploaded_at`,
    [accountId, resume.filename, resume.rawText],
  );
  const resumeRow = resumeRows[0];
  if (!resumeRow) throw new Error('resume_upload upsert returned no row');

  // The resume text just changed (or was set for the first time) - queue a
  // re-embed. Cheap even when the text turns out unchanged: the handler
  // reads resume_upload fresh at claim time (this payload carries no text
  // of its own) and skips the actual AI call via profile_embedding's own
  // source_hash column when nothing changed - see specs/matching-pipeline.md.
  await queueRepo.enqueue(tx, {
    queue: EMBED_PROFILE_QUEUE,
    payload: { accountId, kind: 'resume' } satisfies EmbedProfilePayload,
    dedupKey: `${EMBED_PROFILE_QUEUE}:${accountId}:resume`,
  });

  if (existing) {
    return { session: existing, resume: toResumeUpload(resumeRow) };
  }

  const { rows: sessionRows } = await tx.query<SessionRow>(
    `INSERT INTO job_search_session (account_id, status)
     VALUES ($1, 'active')
     RETURNING ${SESSION_COLUMNS}`,
    [accountId],
  );
  const sessionRow = sessionRows[0];
  if (!sessionRow) throw new Error('job_search_session insert returned no row');

  return { session: toSession(sessionRow), resume: toResumeUpload(resumeRow) };
}

/**
 * The tables purged when a job search stops (ADR D-31's "does this row name
 * or imply a specific employer engaged with via this product, during an
 * active search?" test).
 *
 * job_match and job_search_session's own account_id give it a home too:
 * a persisted match names a specific posting the candidate was shown
 * during this search, so it purges like everything else here.
 * match_explanation cascades automatically via job_match's... no - it does
 * not FK to job_match, it FKs to job_posting_version directly, so it needs
 * its own explicit delete, included below.
 *
 * outreach_draft (0017) is in this list, per this comment's own original
 * plan: a draft or sent message names a specific employer contact engaged
 * with during this search, the same test job_application itself is named
 * for. email_credential is deliberately NOT here - see 0017's own comment -
 * linking a Gmail inbox is a standing, account-level connection, not
 * something a specific search did, same reasoning that already keeps
 * candidate_profile out of this array.
 *
 * profile_embedding is deliberately NOT in this array, even though its
 * 'resume' kind is named explicitly as a purge target (D-31): every other
 * entry here is a plain `DELETE FROM table WHERE account_id = $1`, but
 * profile_embedding's 'desired_role' kind is derived from candidate_profile/
 * profile_skill - retained data, not search activity - so a blanket
 * whole-table delete would be wrong for this one table specifically. See
 * the explicit kind-scoped DELETE right after this loop instead.
 */
const PURGE_TABLES = [
  'resume_upload',
  'resume_source',
  'outreach_draft',
  'resume_artifact',
  'job_application',
  'job_match',
  'match_explanation',
] as const;

/**
 * Turn off active job search and hard-delete everything it touched.
 *
 * Synchronous, single transaction, real DELETE - not a soft delete and not a
 * queued job. "Boom, gone" is a claim about *when*, and only a transaction
 * that has actually committed by the time this function returns can make
 * that claim honestly.
 *
 * Returns null if there was no active session to stop - the caller decides
 * whether that is a 404 or a no-op.
 */
export async function stopJobSearch(
  tx: Queryable,
  accountId: AccountId,
  reason: JobSearchStopReason,
): Promise<{ session: JobSearchSession; purgedTables: string[] } | null> {
  const { rows } = await tx.query<SessionRow>(
    `UPDATE job_search_session
     SET status = 'stopped', stopped_at = now(), stop_reason = $2
     WHERE account_id = $1 AND status = 'active'
     RETURNING ${SESSION_COLUMNS}`,
    [accountId, reason],
  );
  const row = rows[0];
  if (!row) return null;

  for (const table of PURGE_TABLES) {
    await tx.query(`DELETE FROM ${table} WHERE account_id = $1`, [accountId]);
  }

  // Kind-scoped, unlike everything above: only the 'resume' embedding names
  // search activity (a vector derived from resume_upload, which just got
  // deleted). 'desired_role' is derived from candidate_profile/profile_skill
  // - retained biography, not search content - and must survive this purge
  // exactly like those tables do. Runs (and is reported below) the same way
  // every PURGE_TABLES entry is, whether or not a row happened to exist.
  await tx.query(`DELETE FROM profile_embedding WHERE account_id = $1 AND kind = 'resume'`, [
    accountId,
  ]);

  return { session: toSession(row), purgedTables: [...PURGE_TABLES, 'profile_embedding'] };
}

/**
 * Sessions dormant past `staleDays` with no explicit stop - the scheduled
 * sweep's input (ADR D-31's safety net, since relying only on an explicit
 * stop means an abandoned account keeps its résumé indefinitely).
 *
 * "Dormant" is measured from started_at, not from any activity timestamp on
 * the account: there is no per-account last-active column to read yet, and
 * started_at is a conservative, always-available proxy - a candidate who is
 * genuinely still searching after `staleDays` can simply start again.
 *
 * DELIBERATELY UNWIRED as of Phase 5.1. This is a cross-tenant query by
 * nature (it must see every account's active sessions to find the dormant
 * ones), which under RLS only returns correct results for a BYPASSRLS-
 * capable role querying with no tenant context set - app_matcher, not
 * app_web. apps/scheduler currently connects as app_ingest, which has zero
 * grant on any tenant table by design (D-14) and must stay that way; giving
 * it access here to run this sweep would be a real regression, not a
 * shortcut. The sweep is wired to a running process in Phase 5.2, as one
 * more per-account task in the Go matcher-worker's existing BYPASSRLS loop
 * (ADR D-13) - the same role and iteration pattern already built for
 * exactly this shape of batch, cross-tenant job. Until then this function
 * exists and is tested, but nothing calls it on a schedule.
 */
export async function findDormantActiveSessions(
  tx: Queryable,
  staleDays: number,
): Promise<JobSearchSession[]> {
  const { rows } = await tx.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM job_search_session
     WHERE status = 'active' AND started_at < now() - ($1 || ' days')::interval`,
    [staleDays],
  );
  return rows.map(toSession);
}
