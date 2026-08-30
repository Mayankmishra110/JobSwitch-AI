import type { Pool } from 'pg';
import type { Queryable } from '../context.js';

/**
 * Postgres-backed work queue (ADR D-13).
 *
 * The whole design rests on one Postgres feature: FOR UPDATE SKIP LOCKED.
 * Several workers can run the claim query concurrently and each gets a
 * different row, with no coordination and no broker.
 */

export interface QueueJob {
  id: string;
  queue: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueParams {
  queue: string;
  payload?: Record<string, unknown>;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  /**
   * Unique among pending and running rows. Re-enqueueing a live key is a
   * silent no-op, which is what makes the scheduler safe to run twice.
   */
  dedupKey?: string;
}

/** Returns the job id, or null when a live job already holds the dedup key. */
export async function enqueue(
  tx: Queryable,
  params: EnqueueParams,
): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO job_queue (queue, payload, run_at, priority, max_attempts, dedup_key)
     VALUES ($1, $2, COALESCE($3, now()), $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      params.queue,
      JSON.stringify(params.payload ?? {}),
      params.runAt ?? null,
      params.priority ?? 100,
      params.maxAttempts ?? 5,
      params.dedupKey ?? null,
    ],
  );
  return rows[0]?.id ?? null;
}

export interface ClaimParams {
  queues: string[];
  workerId: string;
  /**
   * How long a claim is honoured before another worker may take the job. Must
   * exceed the longest expected handler runtime, or two workers will process
   * the same job concurrently.
   */
  visibilityTimeoutMs?: number;
}

/**
 * Claim one job.
 *
 * The inner SELECT ... FOR UPDATE SKIP LOCKED picks a row no other transaction
 * currently holds; the outer UPDATE marks it running. Doing both in one
 * statement means there is no window in which a job is selected but not yet
 * claimed.
 *
 * The `locked_at` clause is the orphan reclaim: a worker killed mid-job leaves
 * a row in 'running' forever, so a claim older than the visibility timeout
 * becomes eligible again rather than needing a separate reaper.
 */
export async function claim(
  pool: Pool,
  params: ClaimParams,
): Promise<QueueJob | null> {
  const visibility = params.visibilityTimeoutMs ?? 5 * 60_000;

  const { rows } = await pool.query<{
    id: string;
    queue: string;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
  }>(
    `UPDATE job_queue q
     SET status = 'running',
         locked_at = now(),
         locked_by = $2,
         attempts = q.attempts + 1,
         updated_at = now()
     WHERE q.id = (
       SELECT j.id FROM job_queue j
       WHERE j.queue = ANY($1::text[])
         AND (
           (j.status = 'pending' AND j.run_at <= now())
           OR (j.status = 'running'
               AND j.locked_at < now() - ($3::bigint || ' milliseconds')::interval)
         )
       ORDER BY j.priority ASC, j.run_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING q.id, q.queue, q.payload, q.attempts, q.max_attempts`,
    [params.queues, params.workerId, String(visibility)],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    queue: row.queue,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

export async function complete(pool: Pool, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE job_queue
     SET status = 'done', finished_at = now(), locked_at = NULL,
         locked_by = NULL, updated_at = now()
     WHERE id = $1`,
    [jobId],
  );
}

export interface FailResult {
  outcome: 'retry' | 'dead';
  retryAt?: Date;
}

/**
 * Record a failure: schedule a retry, or dead-letter once attempts are spent.
 *
 * Backoff is exponential with jitter. The jitter is not decoration - without
 * it, every source that failed in the same run retries in the same instant,
 * reproducing the burst that may have caused the failure.
 */
export async function fail(
  pool: Pool,
  job: QueueJob,
  error: unknown,
  options: { baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<FailResult> {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  // Long stack traces from a repeatedly failing job would otherwise bloat the
  // table; the full error is in the logs.
  const truncated = message.slice(0, 2000);

  if (job.attempts >= job.maxAttempts) {
    await pool.query(
      `UPDATE job_queue
       SET status = 'dead', last_error = $2, finished_at = now(),
           locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = $1`,
      [job.id, truncated],
    );
    return { outcome: 'dead' };
  }

  const base = options.baseDelayMs ?? 30_000;
  const max = options.maxDelayMs ?? 60 * 60_000;
  const backoff = Math.min(base * 2 ** (job.attempts - 1), max);
  const jitter = Math.random() * backoff * 0.3;
  const retryAt = new Date(Date.now() + backoff + jitter);

  await pool.query(
    `UPDATE job_queue
     SET status = 'pending', run_at = $3, last_error = $2,
         locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE id = $1`,
    [job.id, truncated, retryAt],
  );

  return { outcome: 'retry', retryAt };
}

export interface QueueDepth {
  queue: string;
  pending: number;
  running: number;
  dead: number;
}

export async function queueDepths(pool: Pool): Promise<QueueDepth[]> {
  const { rows } = await pool.query<{
    queue: string;
    pending: string;
    running: string;
    dead: string;
  }>(
    `SELECT queue,
            count(*) FILTER (WHERE status = 'pending') AS pending,
            count(*) FILTER (WHERE status = 'running') AS running,
            count(*) FILTER (WHERE status = 'dead')    AS dead
     FROM job_queue
     GROUP BY queue
     ORDER BY queue`,
  );
  return rows.map((r) => ({
    queue: r.queue,
    pending: Number(r.pending),
    running: Number(r.running),
    dead: Number(r.dead),
  }));
}

/**
 * Delete completed rows.
 *
 * Dead rows are never touched: they are the record of what broke, and the ADR
 * names dead-letter depth as one of the four alarms worth having.
 */
export async function pruneCompleted(
  pool: Pool,
  olderThanDays = 7,
): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM job_queue
     WHERE status = 'done'
       AND finished_at < now() - ($1 || ' days')::interval`,
    [String(olderThanDays)],
  );
  return rowCount ?? 0;
}
