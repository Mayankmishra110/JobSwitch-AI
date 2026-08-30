/**
 * Scheduler process.
 *
 * Ticks once a minute and enqueues ingestion jobs for career sources whose
 * next_run_at has passed.
 *
 * Runs as a singleton, guarded by a Postgres advisory lock. A second copy
 * started by accident during a deploy simply does nothing, rather than
 * double-enqueueing every source. The per-hour dedup key on the queue is a
 * second, independent guard against the same mistake.
 */
import { createPool } from '@jobswitch/db';
import { enqueueDueSources } from '@jobswitch/ingest';
import { loadSchedulerConfig } from './config.js';

const SCHEDULER_ADVISORY_LOCK = 8_240_119;

const config = loadSchedulerConfig();

const pool = createPool({
  connectionString: config.DATABASE_URL_INGEST,
  max: 2,
  applicationName: 'jobswitch-scheduler',
  ssl: config.DATABASE_SSL === 'true',
});

const log = (level: string, msg: string, extra: object = {}) =>
  console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...extra }));

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

// Session-scoped advisory lock, held for the lifetime of this connection.
const client = await pool.connect();
const { rows } = await client.query<{ locked: boolean }>(
  'SELECT pg_try_advisory_lock($1) AS locked',
  [SCHEDULER_ADVISORY_LOCK],
);

if (!rows[0]?.locked) {
  log('warn', 'another scheduler holds the lock; exiting');
  client.release();
  await pool.end();
  process.exit(0);
}

log('info', 'scheduler started');

while (!stopping) {
  try {
    const result = await enqueueDueSources(pool);
    if (result.due > 0) {
      log('info', 'enqueued due sources', result);
    }
  } catch (error) {
    log('error', 'scheduler tick failed', { err: String(error) });
  }
  await new Promise((r) => setTimeout(r, config.SCHEDULER_TICK_MS).unref?.());
}

log('info', 'scheduler stopping');
client.release();
await pool.end();
