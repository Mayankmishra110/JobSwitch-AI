import {
  jobsRepo,
  queueRepo,
  withoutTenantContext,
  type Pool,
  type Queryable,
} from '@jobswitch/db';
import { AdapterHttpError, AdapterShapeError, type AtsAdapter } from './adapter.js';
import { linkNewPosting } from './grouping.js';

/**
 * Queue name services/backend's cmd/worker claims from
 * (internal/worker/embed.go's EmbedJobVersionQueue) - the two sides never
 * share code, so the string and the payload shape below are a cross-
 * language contract enforced only by matching them exactly, not by a type.
 */
export const EMBED_JOB_VERSION_QUEUE = 'embed.job_version';

export interface EmbedJobVersionPayload {
  versionId: string;
}

/**
 * One ingestion run for one career source.
 *
 * Sequence: fetch → normalize → upsert → version → locations → group-link →
 * absence/closing → record the run. Everything after the fetch happens in one
 * transaction, so a crash mid-run leaves the index on its previous consistent
 * state rather than half-updated.
 */

export interface RunOptions {
  pool: Pool;
  adapter: AtsAdapter;
  careerSourceId: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** Abort a hung platform rather than holding a worker slot forever. */
  timeoutMs?: number;
  now?: () => Date;
}

export interface RunOutcome {
  status: 'success' | 'failure' | 'skipped';
  postingsSeen: number;
  postingsNew: number;
  postingsUpdated: number;
  postingsClosed: number;
  postingsReopened: number;
  error?: string;
  /** True when the zero-result guard suppressed closing. */
  closingSuppressed?: boolean;
}

export const DEFAULT_USER_AGENT =
  'JobSwitchAI/0.1 (+https://jobswitch.ai/bot; jobs indexer)';

export async function runIngestion(options: RunOptions): Promise<RunOutcome> {
  const startedAt = Date.now();
  const {
    pool,
    adapter,
    careerSourceId,
    fetchImpl = fetch,
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = 30_000,
  } = options;

  const source = await withoutTenantContext(pool, (tx) =>
    jobsRepo.findSourceById(tx, careerSourceId),
  );

  if (!source) {
    throw new Error(`career_source ${careerSourceId} not found`);
  }

  if (source.status === 'disabled') {
    await withoutTenantContext(pool, (tx) =>
      jobsRepo.recordScrapeRun(tx, careerSourceId, { status: 'skipped' }),
    );
    return {
      status: 'skipped',
      postingsSeen: 0,
      postingsNew: 0,
      postingsUpdated: 0,
      postingsClosed: 0,
      postingsReopened: 0,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let raw: unknown[];
  let httpStatus: number;

  try {
    const fetched = await adapter.fetch({
      boardIdentifier: source.boardIdentifier,
      fetchImpl,
      signal: controller.signal,
      userAgent,
    });
    raw = fetched.raw;
    httpStatus = fetched.httpStatus;
  } catch (error) {
    clearTimeout(timer);
    return failRun(pool, careerSourceId, error, startedAt);
  } finally {
    clearTimeout(timer);
  }

  // Normalize outside the transaction: it is pure CPU work, and holding a
  // database transaction open across it would pin a connection for nothing.
  const normalized: ReturnType<AtsAdapter['normalize']>[] = [];
  try {
    for (const record of raw) normalized.push(adapter.normalize(record));
  } catch (error) {
    return failRun(pool, careerSourceId, error, startedAt);
  }

  // Two source records claiming the same source_job_id would fight over one
  // row. Keep the first and carry on rather than failing the whole run.
  const seen = new Set<string>();
  const deduped = normalized.filter((p) => {
    if (seen.has(p.sourceJobId)) return false;
    seen.add(p.sourceJobId);
    return true;
  });

  try {
    const result = await withoutTenantContext(pool, async (tx) => {
      let created = 0;
      let updated = 0;
      let reopened = 0;

      for (const posting of deduped) {
        const upserted = await jobsRepo.upsertPosting(tx, {
          careerSourceId,
          companyId: source.companyId,
          posting,
        });

        if (upserted.outcome === 'created') created += 1;
        else if (upserted.outcome === 'updated') updated += 1;
        else if (upserted.outcome === 'reopened') reopened += 1;

        // A new or changed version needs embedding for Stage 2 hybrid
        // retrieval (specs/matching-pipeline.md). Enqueued inside this same
        // transaction: if the run rolls back, no orphan job survives it.
        // Dedup key is the version id itself - a version is immutable once
        // written, so re-enqueueing the same one twice would only waste a
        // worker cycle, never produce a wrong result, but the dedup key
        // keeps a re-run within the same hour cheap.
        if (upserted.versionCreated && upserted.versionId) {
          await queueRepo.enqueue(tx, {
            queue: EMBED_JOB_VERSION_QUEUE,
            payload: { versionId: upserted.versionId } satisfies EmbedJobVersionPayload,
            dedupKey: `${EMBED_JOB_VERSION_QUEUE}:${upserted.versionId}`,
          });
        }

        if (upserted.outcome === 'created') {
          await linkNewPosting(tx, {
            postingId: upserted.postingId,
            companyId: source.companyId,
            careerSourceId,
            normalizedTitle: posting.normalizedTitle,
            fingerprint: posting.contentFingerprint,
            descriptionText: posting.descriptionText,
          });
        }
      }

      const closed = await closeAbsent(tx, careerSourceId, [...seen]);

      return { created, updated, reopened, ...closed };
    });

    await withoutTenantContext(pool, async (tx) => {
      await jobsRepo.recordSourceOutcome(tx, careerSourceId, true);
      await jobsRepo.scheduleNextRun(tx, careerSourceId);
      await jobsRepo.recordScrapeRun(tx, careerSourceId, {
        status: 'success',
        httpStatus,
        postingsSeen: deduped.length,
        postingsNew: result.created,
        postingsUpdated: result.updated,
        postingsClosed: result.closed,
        durationMs: Date.now() - startedAt,
      });
    });

    return {
      status: 'success',
      postingsSeen: deduped.length,
      postingsNew: result.created,
      postingsUpdated: result.updated,
      postingsClosed: result.closed,
      postingsReopened: result.reopened,
      ...(result.closingSuppressed ? { closingSuppressed: true } : {}),
    };
  } catch (error) {
    return failRun(pool, careerSourceId, error, startedAt);
  }
}

/**
 * Absence handling, with the guard from ADR D-05.
 *
 * An adapter that answers 200 with an empty list - a board being migrated, a
 * silent API change, a CDN serving a stub - would otherwise close every
 * posting for that company in a single night, and nobody would notice until
 * users asked where the jobs went.
 *
 * So: an empty result against a source that currently has open postings never
 * closes anything. It is reported as a suppressed run for a human to look at.
 * The cost of being wrong here is asymmetric - a stale posting is a small
 * annoyance, a wrongly emptied index is invisible data loss.
 */
async function closeAbsent(
  tx: Queryable,
  careerSourceId: string,
  seenSourceJobIds: string[],
): Promise<{ closed: number; closingSuppressed: boolean }> {
  if (seenSourceJobIds.length === 0) {
    const openCount = await jobsRepo.countOpenPostings(tx, careerSourceId);
    if (openCount > 0) {
      return { closed: 0, closingSuppressed: true };
    }
    // No postings seen and none open: a genuinely empty board.
    return { closed: 0, closingSuppressed: false };
  }

  const closed = await jobsRepo.markAbsentAndClose(
    tx,
    careerSourceId,
    seenSourceJobIds,
  );
  return { closed, closingSuppressed: false };
}

async function failRun(
  pool: Pool,
  careerSourceId: string,
  error: unknown,
  startedAt: number,
): Promise<RunOutcome> {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  const httpStatus =
    error instanceof AdapterHttpError ? error.httpStatus : null;

  await withoutTenantContext(pool, async (tx) => {
    await jobsRepo.recordSourceOutcome(tx, careerSourceId, false);
    // Move the schedule forward even on failure, or the scheduler re-enqueues
    // this source every tick and the queue fills with the same doomed job.
    await jobsRepo.scheduleNextRun(tx, careerSourceId);
    await jobsRepo.recordScrapeRun(tx, careerSourceId, {
      status: 'failure',
      httpStatus,
      error: message,
      durationMs: Date.now() - startedAt,
    });
  });

  return {
    status: 'failure',
    postingsSeen: 0,
    postingsNew: 0,
    postingsUpdated: 0,
    postingsClosed: 0,
    postingsReopened: 0,
    error: message,
  };
}

export { AdapterHttpError, AdapterShapeError };
