import { jobsRepo, queueRepo, withoutTenantContext, type Pool } from '@jobswitch/db';
import { requireAdapter } from './registry.js';
import { runIngestion, type RunOutcome } from './run.js';

/** Queue name for per-source ingestion jobs. */
export const INGEST_QUEUE = 'ingest.source';

export interface IngestPayload {
  careerSourceId: string;
}

/**
 * Enqueue one job per due career source.
 *
 * The dedup key is the source plus the current hour, so a scheduler that ticks
 * more than once an hour - or two schedulers briefly overlapping during a
 * deploy - cannot enqueue the same source twice.
 */
export async function enqueueDueSources(
  pool: Pool,
  now: Date = new Date(),
): Promise<{ enqueued: number; due: number }> {
  const hourKey = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH

  return withoutTenantContext(pool, async (tx) => {
    const due = await jobsRepo.findDueSources(tx);
    let enqueued = 0;

    for (const source of due) {
      const id = await queueRepo.enqueue(tx, {
        queue: INGEST_QUEUE,
        payload: { careerSourceId: source.id } satisfies IngestPayload,
        dedupKey: `${INGEST_QUEUE}:${source.id}:${hourKey}`,
        maxAttempts: 3,
      });
      if (id) enqueued += 1;
    }

    return { enqueued, due: due.length };
  });
}

/**
 * Handle one ingestion job.
 *
 * Note what this does NOT do: it never throws on an adapter failure. A source
 * that is down is a recorded outcome, not a queue-level error - retrying it
 * three times within the hour would hammer a struggling platform to reach the
 * same answer the next scheduled run will get anyway. Only infrastructure
 * faults (a missing source row, a database error) propagate and trigger the
 * queue's own retry.
 */
export async function handleIngestSource(
  pool: Pool,
  payload: unknown,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<RunOutcome> {
  const careerSourceId = (payload as IngestPayload | undefined)?.careerSourceId;
  if (typeof careerSourceId !== 'string') {
    throw new Error('ingest.source payload missing careerSourceId');
  }

  const source = await withoutTenantContext(pool, (tx) =>
    jobsRepo.findSourceById(tx, careerSourceId),
  );
  if (!source) throw new Error(`career_source ${careerSourceId} not found`);

  const adapter = requireAdapter(source.atsType);

  return runIngestion({
    pool,
    adapter,
    careerSourceId,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}
