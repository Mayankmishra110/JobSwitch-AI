import type { Queryable } from '../context.js';

/**
 * Layer 1 repository: companies, career sources, postings, versions, groups.
 *
 * No account_id appears anywhere in this file. If one ever does, the layer
 * boundary has been crossed and the cost model (one fetch serves every user)
 * has quietly broken.
 */

export interface CareerSourceRow {
  id: string;
  companyId: string;
  companyName: string;
  atsType: string;
  boardIdentifier: string;
  status: 'active' | 'degraded' | 'disabled';
  consecutiveFailures: number;
  lastRunAt: Date | null;
  nextRunAt: Date;
}

const SOURCE_SELECT = `
  s.id, s.company_id, c.name AS company_name, s.ats_type, s.board_identifier,
  s.status, s.consecutive_failures, s.last_run_at, s.next_run_at
`;

function toSource(row: {
  id: string;
  company_id: string;
  company_name: string;
  ats_type: string;
  board_identifier: string;
  status: 'active' | 'degraded' | 'disabled';
  consecutive_failures: number;
  last_run_at: Date | null;
  next_run_at: Date;
}): CareerSourceRow {
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    atsType: row.ats_type,
    boardIdentifier: row.board_identifier,
    status: row.status,
    consecutiveFailures: row.consecutive_failures,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
  };
}

export async function findSourceById(
  tx: Queryable,
  id: string,
): Promise<CareerSourceRow | null> {
  const { rows } = await tx.query(
    `SELECT ${SOURCE_SELECT} FROM career_source s
     JOIN company c ON c.id = s.company_id
     WHERE s.id = $1`,
    [id],
  );
  return rows[0] ? toSource(rows[0]) : null;
}

/** Sources whose next_run_at has passed. Disabled sources are never returned. */
export async function findDueSources(
  tx: Queryable,
  limit = 500,
): Promise<CareerSourceRow[]> {
  const { rows } = await tx.query(
    `SELECT ${SOURCE_SELECT} FROM career_source s
     JOIN company c ON c.id = s.company_id
     WHERE s.status <> 'disabled' AND s.next_run_at <= now()
     ORDER BY s.next_run_at ASC
     LIMIT $1`,
    [limit],
  );
  return rows.map(toSource);
}

const CADENCE_INTERVAL_HOURS: Record<string, number> = {
  hot: 6,
  standard: 24,
  cold: 72,
};

/**
 * Move a source's next run forward according to its company's cadence tier.
 *
 * Called on success and on failure alike. A source that keeps failing must
 * still be pushed forward, or the scheduler re-enqueues it every tick and the
 * queue fills with the same doomed job.
 */
export async function scheduleNextRun(
  tx: Queryable,
  sourceId: string,
  options: { jitterMinutes?: number } = {},
): Promise<Date> {
  const jitter = options.jitterMinutes ?? 30;
  const { rows } = await tx.query<{ next_run_at: Date }>(
    `UPDATE career_source s
     SET last_run_at = now(),
         next_run_at = now()
           + (COALESCE($2::jsonb ->> c.cadence_tier, '24')::int || ' hours')::interval
           + (random() * $3 || ' minutes')::interval,
         updated_at = now()
     FROM company c
     WHERE s.id = $1 AND c.id = s.company_id
     RETURNING s.next_run_at`,
    [sourceId, JSON.stringify(CADENCE_INTERVAL_HOURS), String(jitter)],
  );
  const row = rows[0];
  if (!row) throw new Error(`career_source ${sourceId} not found`);
  return row.next_run_at;
}

export async function recordSourceOutcome(
  tx: Queryable,
  sourceId: string,
  ok: boolean,
): Promise<void> {
  if (ok) {
    await tx.query(
      `UPDATE career_source
       SET consecutive_failures = 0,
           status = CASE WHEN status = 'degraded' THEN 'active' ELSE status END,
           updated_at = now()
       WHERE id = $1`,
      [sourceId],
    );
    return;
  }

  // Three consecutive failures marks the source degraded so it surfaces in the
  // ops view. It is not disabled: transient outages recover, and silently
  // dropping a company would be worse than a noisy flag.
  await tx.query(
    `UPDATE career_source
     SET consecutive_failures = consecutive_failures + 1,
         status = CASE WHEN consecutive_failures + 1 >= 3 AND status = 'active'
                       THEN 'degraded' ELSE status END,
         updated_at = now()
     WHERE id = $1`,
    [sourceId],
  );
}

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

export interface NormalizedPostingInput {
  sourceJobId: string;
  canonicalTitle: string;
  normalizedTitle: string;
  seniority: string | null;
  employmentType: string | null;
  department: string | null;
  applyUrl: string;
  contentFingerprint: string;
  descriptionText: string | null;
  descriptionHtml: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  sourceUpdatedAt: Date | null;
  locations: Array<{
    raw: string;
    city: string | null;
    region: string | null;
    country: string | null;
    workMode: 'remote' | 'hybrid' | 'onsite' | null;
    isPrimary: boolean;
  }>;
}

export type UpsertOutcome = 'created' | 'updated' | 'unchanged' | 'reopened';

export interface UpsertResult {
  postingId: string;
  outcome: UpsertOutcome;
  versionCreated: boolean;
  /** Set whenever versionCreated is true - the version to embed. */
  versionId: string | null;
}

/**
 * Insert or update one posting from a source record.
 *
 * Identity is (career_source_id, source_job_id) and nothing else. A new
 * version row is written only when the content fingerprint changes, so an
 * unchanged posting re-seen every night costs one UPDATE and no history.
 */
export async function upsertPosting(
  tx: Queryable,
  params: {
    careerSourceId: string;
    companyId: string;
    posting: NormalizedPostingInput;
  },
): Promise<UpsertResult> {
  const p = params.posting;

  const { rows: existingRows } = await tx.query<{
    id: string;
    closed_at: Date | null;
    current_fingerprint: string | null;
  }>(
    `SELECT jp.id, jp.closed_at, v.content_fingerprint AS current_fingerprint
     FROM job_posting jp
     LEFT JOIN job_posting_version v ON v.id = jp.current_version_id
     WHERE jp.career_source_id = $1 AND jp.source_job_id = $2`,
    [params.careerSourceId, p.sourceJobId],
  );
  const existing = existingRows[0];

  let postingId: string;
  let outcome: UpsertOutcome;

  if (!existing) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO job_posting
         (career_source_id, company_id, source_job_id, canonical_title,
          normalized_title, seniority, employment_type, department, apply_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        params.careerSourceId,
        params.companyId,
        p.sourceJobId,
        p.canonicalTitle,
        p.normalizedTitle,
        p.seniority,
        p.employmentType,
        p.department,
        p.applyUrl,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('job_posting insert returned no row');
    postingId = row.id;
    outcome = 'created';
  } else {
    postingId = existing.id;
    // Reappearing under the same source_job_id is the same posting reopened,
    // not a new one - so it must not fire a "new job" notification.
    const wasClosed = existing.closed_at !== null;

    await tx.query(
      `UPDATE job_posting
       SET canonical_title = $2, normalized_title = $3, seniority = $4,
           employment_type = $5, department = $6, apply_url = $7,
           last_seen_at = now(), absent_run_count = 0,
           closed_at = NULL,
           reopened_at = CASE WHEN $8 THEN now() ELSE reopened_at END,
           updated_at = now()
       WHERE id = $1`,
      [
        postingId,
        p.canonicalTitle,
        p.normalizedTitle,
        p.seniority,
        p.employmentType,
        p.department,
        p.applyUrl,
        wasClosed,
      ],
    );

    outcome = wasClosed
      ? 'reopened'
      : existing.current_fingerprint === p.contentFingerprint
        ? 'unchanged'
        : 'updated';
  }

  const needsVersion =
    !existing || existing.current_fingerprint !== p.contentFingerprint;

  let versionId: string | null = null;

  if (needsVersion) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO job_posting_version
         (job_posting_id, content_fingerprint, title, description_text,
          description_html, salary_min, salary_max, salary_currency,
          source_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (job_posting_id, content_fingerprint) DO NOTHING
       RETURNING id`,
      [
        postingId,
        p.contentFingerprint,
        p.canonicalTitle,
        p.descriptionText,
        p.descriptionHtml,
        p.salaryMin,
        p.salaryMax,
        p.salaryCurrency,
        p.sourceUpdatedAt,
      ],
    );

    // DO NOTHING means this exact content was seen before - a posting that
    // reverted to an earlier wording. Point at the existing version rather
    // than writing a duplicate.
    versionId =
      rows[0]?.id ??
      (
        await tx.query<{ id: string }>(
          `SELECT id FROM job_posting_version
           WHERE job_posting_id = $1 AND content_fingerprint = $2`,
          [postingId, p.contentFingerprint],
        )
      ).rows[0]?.id ??
      null;

    if (versionId) {
      await tx.query(
        'UPDATE job_posting SET current_version_id = $2 WHERE id = $1',
        [postingId, versionId],
      );
    }
  }

  await replaceLocations(tx, postingId, p.locations);

  return { postingId, outcome, versionCreated: needsVersion, versionId };
}

async function replaceLocations(
  tx: Queryable,
  postingId: string,
  locations: NormalizedPostingInput['locations'],
): Promise<void> {
  await tx.query('DELETE FROM job_posting_location WHERE job_posting_id = $1', [
    postingId,
  ]);
  for (const loc of locations) {
    await tx.query(
      `INSERT INTO job_posting_location
         (job_posting_id, raw, city, region, country, work_mode, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        postingId,
        loc.raw,
        loc.city,
        loc.region,
        loc.country,
        loc.workMode,
        loc.isPrimary,
      ],
    );
  }
}

/**
 * Mark postings absent from this run, and close those absent twice running.
 *
 * THE GUARD THAT MATTERS (ADR D-05): the caller must not invoke this after a
 * run that returned zero postings when the source has live postings. An
 * adapter answering 200 with an empty body would otherwise retire an entire
 * company's index in one night, silently.
 */
export async function markAbsentAndClose(
  tx: Queryable,
  careerSourceId: string,
  seenSourceJobIds: string[],
): Promise<number> {
  await tx.query(
    `UPDATE job_posting
     SET absent_run_count = absent_run_count + 1, updated_at = now()
     WHERE career_source_id = $1
       AND closed_at IS NULL
       AND NOT (source_job_id = ANY($2::text[]))`,
    [careerSourceId, seenSourceJobIds],
  );

  const { rowCount } = await tx.query(
    `UPDATE job_posting
     SET closed_at = now(), updated_at = now()
     WHERE career_source_id = $1
       AND closed_at IS NULL
       AND absent_run_count >= 2`,
    [careerSourceId],
  );

  return rowCount ?? 0;
}

export async function countOpenPostings(
  tx: Queryable,
  careerSourceId: string,
): Promise<number> {
  const { rows } = await tx.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM job_posting
     WHERE career_source_id = $1 AND closed_at IS NULL`,
    [careerSourceId],
  );
  return rows[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Scrape runs
// ---------------------------------------------------------------------------

export interface ScrapeRunSummary {
  status: 'success' | 'failure' | 'skipped';
  httpStatus?: number | null;
  postingsSeen?: number;
  postingsNew?: number;
  postingsUpdated?: number;
  postingsClosed?: number;
  error?: string | null;
  durationMs?: number;
}

export async function recordScrapeRun(
  tx: Queryable,
  careerSourceId: string,
  summary: ScrapeRunSummary,
): Promise<void> {
  await tx.query(
    `INSERT INTO scrape_run
       (career_source_id, status, http_status, postings_seen, postings_new,
        postings_updated, postings_closed, error, duration_ms, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
    [
      careerSourceId,
      summary.status,
      summary.httpStatus ?? null,
      summary.postingsSeen ?? 0,
      summary.postingsNew ?? 0,
      summary.postingsUpdated ?? 0,
      summary.postingsClosed ?? 0,
      summary.error?.slice(0, 2000) ?? null,
      summary.durationMs ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------
// Grouping - links only, never merges (ADR D-03)
// ---------------------------------------------------------------------------

export interface GroupCandidate {
  id: string;
  careerSourceId: string;
  normalizedTitle: string;
  closedAt: Date | null;
  fingerprint: string | null;
  groupId: string | null;
}

/**
 * Postings at the same company with the same normalized title, excluding the
 * posting under consideration.
 *
 * Deliberately narrow: same company AND same normalized title. Widening this
 * to fuzzy title matching would raise the link rate and the false-link rate
 * together, and a false link hides a job the user needed to see - a failure
 * they never find out about.
 */
export async function findGroupCandidates(
  tx: Queryable,
  params: { companyId: string; normalizedTitle: string; excludePostingId: string },
): Promise<GroupCandidate[]> {
  const { rows } = await tx.query<{
    id: string;
    career_source_id: string;
    normalized_title: string;
    closed_at: Date | null;
    fingerprint: string | null;
    group_id: string | null;
  }>(
    `SELECT jp.id, jp.career_source_id, jp.normalized_title, jp.closed_at,
            v.content_fingerprint AS fingerprint, gl.job_group_id AS group_id
     FROM job_posting jp
     LEFT JOIN job_posting_version v ON v.id = jp.current_version_id
     LEFT JOIN job_group_link gl ON gl.job_posting_id = jp.id
     WHERE jp.company_id = $1
       AND jp.normalized_title = $2
       AND jp.id <> $3
     ORDER BY jp.last_seen_at DESC
     LIMIT 25`,
    [params.companyId, params.normalizedTitle, params.excludePostingId],
  );

  return rows.map((r) => ({
    id: r.id,
    careerSourceId: r.career_source_id,
    normalizedTitle: r.normalized_title,
    closedAt: r.closed_at,
    fingerprint: r.fingerprint,
    groupId: r.group_id,
  }));
}

export async function linkIntoGroup(
  tx: Queryable,
  params: {
    postingId: string;
    companyId: string;
    existingGroupId: string | null;
    representativePostingId: string;
    reason: 'repost' | 'cross_source' | 'location_variant';
    confidence: number;
  },
): Promise<string> {
  let groupId = params.existingGroupId;

  if (!groupId) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO job_group (company_id, representative_posting_id)
       VALUES ($1, $2) RETURNING id`,
      [params.companyId, params.representativePostingId],
    );
    const row = rows[0];
    if (!row) throw new Error('job_group insert returned no row');
    groupId = row.id;

    await tx.query(
      `INSERT INTO job_group_link
         (job_posting_id, job_group_id, reason, confidence)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (job_posting_id) DO NOTHING`,
      [params.representativePostingId, groupId, params.reason, params.confidence],
    );
  }

  await tx.query(
    `INSERT INTO job_group_link
       (job_posting_id, job_group_id, reason, confidence)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (job_posting_id) DO NOTHING`,
    [params.postingId, groupId, params.reason, params.confidence],
  );

  return groupId;
}

export async function markAsRepost(
  tx: Queryable,
  postingId: string,
): Promise<void> {
  await tx.query(
    'UPDATE job_posting SET is_repost = true, updated_at = now() WHERE id = $1',
    [postingId],
  );
}

export async function unlinkFromGroup(
  tx: Queryable,
  postingId: string,
): Promise<void> {
  // Grouping is reversible by design: an incorrect link is undone with no loss,
  // because no posting data was ever merged away.
  await tx.query('DELETE FROM job_group_link WHERE job_posting_id = $1', [
    postingId,
  ]);
}
