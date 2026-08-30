import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type Pool } from '../src/pool.js';
import { migrate } from '../src/migrate.js';
import { withoutTenantContext } from '../src/context.js';
import * as queueRepo from '../src/repositories/queue.js';

/**
 * Queue semantics (ADR D-13).
 *
 * The claim path is the part that has to be exactly right: two workers must
 * never get the same job, and a worker that dies must not strand one forever.
 * Both are properties of Postgres behaviour, so both are tested against a real
 * database rather than reasoned about.
 */

const DB_URL =
  process.env.DATABASE_URL_TEST ??
  'postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test';

let pool: Pool;

beforeAll(async () => {
  pool = createPool({ connectionString: DB_URL, max: 10 });
  await migrate(pool);
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM job_queue');
});

const enqueue = (params: queueRepo.EnqueueParams) =>
  withoutTenantContext(pool, (tx) => queueRepo.enqueue(tx, params));

describe('enqueue', () => {
  it('creates a pending job', async () => {
    const id = await enqueue({ queue: 'test.q', payload: { a: 1 } });
    expect(id).toBeTruthy();

    const { rows } = await pool.query('SELECT status, payload FROM job_queue');
    expect(rows[0]).toMatchObject({ status: 'pending', payload: { a: 1 } });
  });

  it('is a no-op for a duplicate dedup key', async () => {
    const first = await enqueue({ queue: 'test.q', dedupKey: 'same' });
    const second = await enqueue({ queue: 'test.q', dedupKey: 'same' });

    expect(first).toBeTruthy();
    expect(second).toBeNull();

    const { rows } = await pool.query('SELECT count(*)::int AS c FROM job_queue');
    expect(rows[0].c).toBe(1);
  });

  it('allows the dedup key again once the job is done', async () => {
    // The key is unique only among live rows, so tomorrow's identical job can
    // still be scheduled.
    const first = await enqueue({ queue: 'test.q', dedupKey: 'recurring' });
    await queueRepo.complete(pool, first as string);

    const second = await enqueue({ queue: 'test.q', dedupKey: 'recurring' });
    expect(second).toBeTruthy();
  });
});

describe('claim', () => {
  it('returns null when nothing is due', async () => {
    await enqueue({
      queue: 'test.q',
      runAt: new Date(Date.now() + 60_000),
    });
    const job = await queueRepo.claim(pool, { queues: ['test.q'], workerId: 'w1' });
    expect(job).toBeNull();
  });

  it('respects priority then run_at', async () => {
    await enqueue({ queue: 'test.q', payload: { n: 'low' }, priority: 200 });
    await enqueue({ queue: 'test.q', payload: { n: 'high' }, priority: 10 });

    const job = await queueRepo.claim(pool, { queues: ['test.q'], workerId: 'w1' });
    expect(job?.payload).toEqual({ n: 'high' });
  });

  it('never hands the same job to two workers', async () => {
    // The core SKIP LOCKED property. Ten jobs, five workers claiming
    // concurrently - every claim must be distinct.
    for (let i = 0; i < 10; i += 1) {
      await enqueue({ queue: 'test.q', payload: { i } });
    }

    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, w) =>
        queueRepo.claim(pool, { queues: ['test.q'], workerId: `w${w}` }),
      ),
    );

    const ids = claims.filter((c) => c !== null).map((c) => c!.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('only claims from the requested queues', async () => {
    await enqueue({ queue: 'other.q' });
    const job = await queueRepo.claim(pool, { queues: ['test.q'], workerId: 'w1' });
    expect(job).toBeNull();
  });

  it('increments attempts on each claim', async () => {
    await enqueue({ queue: 'test.q' });
    const job = await queueRepo.claim(pool, { queues: ['test.q'], workerId: 'w1' });
    expect(job?.attempts).toBe(1);
  });

  it('reclaims a job orphaned by a dead worker', async () => {
    // A worker killed mid-job leaves the row 'running' forever. The visibility
    // timeout is what makes that self-healing rather than a permanent stall.
    await enqueue({ queue: 'test.q' });
    const first = await queueRepo.claim(pool, {
      queues: ['test.q'],
      workerId: 'dead-worker',
    });
    expect(first).toBeTruthy();

    // Nothing available while the claim is fresh.
    const tooSoon = await queueRepo.claim(pool, {
      queues: ['test.q'],
      workerId: 'w2',
      visibilityTimeoutMs: 60_000,
    });
    expect(tooSoon).toBeNull();

    await pool.query(
      `UPDATE job_queue SET locked_at = now() - interval '10 minutes'`,
    );

    const reclaimed = await queueRepo.claim(pool, {
      queues: ['test.q'],
      workerId: 'w2',
      visibilityTimeoutMs: 60_000,
    });
    expect(reclaimed?.id).toBe(first?.id);
    expect(reclaimed?.attempts).toBe(2);
  });
});

describe('failure handling', () => {
  it('schedules a retry with a future run_at', async () => {
    await enqueue({ queue: 'test.q', maxAttempts: 3 });
    const job = await queueRepo.claim(pool, { queues: ['test.q'], workerId: 'w1' });

    const result = await queueRepo.fail(pool, job!, new Error('boom'));
    expect(result.outcome).toBe('retry');
    expect(result.retryAt!.getTime()).toBeGreaterThan(Date.now());

    const { rows } = await pool.query('SELECT status, last_error FROM job_queue');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].last_error).toContain('boom');
  });

  it('backs off exponentially', async () => {
    await enqueue({ queue: 'test.q', maxAttempts: 10 });

    const delays: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const job = await queueRepo.claim(pool, { queues: ['test.q'], workerId: 'w1' });
      const result = await queueRepo.fail(pool, job!, new Error('again'), {
        baseDelayMs: 1000,
      });
      delays.push(result.retryAt!.getTime() - Date.now());
      // Make it immediately claimable again to observe the next backoff.
      await pool.query('UPDATE job_queue SET run_at = now()');
    }

    expect(delays[1]).toBeGreaterThan(delays[0]!);
    expect(delays[2]).toBeGreaterThan(delays[1]!);
  });

  it('dead-letters once attempts are exhausted, keeping the row', async () => {
    await enqueue({ queue: 'test.q', maxAttempts: 1 });
    const job = await queueRepo.claim(pool, { queues: ['test.q'], workerId: 'w1' });

    const result = await queueRepo.fail(pool, job!, new Error('fatal'));
    expect(result.outcome).toBe('dead');

    // Retained deliberately: the dead-letter row is the record of what broke,
    // and its depth is one of the four alarms the ADR keeps.
    const { rows } = await pool.query(
      `SELECT status, last_error FROM job_queue WHERE id = $1`,
      [job!.id],
    );
    expect(rows[0].status).toBe('dead');
    expect(rows[0].last_error).toContain('fatal');
  });

  it('does not re-claim a dead job', async () => {
    await enqueue({ queue: 'test.q', maxAttempts: 1 });
    const job = await queueRepo.claim(pool, { queues: ['test.q'], workerId: 'w1' });
    await queueRepo.fail(pool, job!, new Error('fatal'));

    const again = await queueRepo.claim(pool, { queues: ['test.q'], workerId: 'w2' });
    expect(again).toBeNull();
  });

  it('truncates a very long error rather than bloating the row', async () => {
    await enqueue({ queue: 'test.q', maxAttempts: 1 });
    const job = await queueRepo.claim(pool, { queues: ['test.q'], workerId: 'w1' });
    await queueRepo.fail(pool, job!, new Error('x'.repeat(10_000)));

    const { rows } = await pool.query<{ last_error: string }>(
      'SELECT last_error FROM job_queue',
    );
    expect(rows[0]!.last_error.length).toBeLessThanOrEqual(2000);
  });
});

describe('maintenance', () => {
  it('reports depth per queue', async () => {
    await enqueue({ queue: 'a.q' });
    await enqueue({ queue: 'b.q' });
    const job = await queueRepo.claim(pool, { queues: ['a.q'], workerId: 'w1' });
    expect(job).toBeTruthy();

    const depths = await queueRepo.queueDepths(pool);
    const a = depths.find((d) => d.queue === 'a.q');
    const b = depths.find((d) => d.queue === 'b.q');

    expect(a).toMatchObject({ pending: 0, running: 1, dead: 0 });
    expect(b).toMatchObject({ pending: 1, running: 0, dead: 0 });
  });

  it('prunes completed jobs but never dead ones', async () => {
    const doneId = await enqueue({ queue: 'test.q' });
    await queueRepo.complete(pool, doneId as string);

    await enqueue({ queue: 'test.q', maxAttempts: 1, dedupKey: 'dead-one' });
    const deadJob = await queueRepo.claim(pool, { queues: ['test.q'], workerId: 'w1' });
    await queueRepo.fail(pool, deadJob!, new Error('fatal'));

    await pool.query(`UPDATE job_queue SET finished_at = now() - interval '30 days'`);

    const pruned = await queueRepo.pruneCompleted(pool, 7);
    expect(pruned).toBe(1);

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM job_queue');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('dead');
  });
});
