/**
 * Worker process.
 *
 * Connects as app_ingest, which has no grant on any tenant table. If this
 * process is ever compromised through a malicious job posting, it cannot read
 * a single resume.
 */
import { createPool } from '@jobswitch/db';
import { INGEST_QUEUE, handleIngestSource } from '@jobswitch/ingest';
import { loadWorkerConfig } from './config.js';
import { Worker } from './worker.js';

const config = loadWorkerConfig();

const pool = createPool({
  connectionString: config.DATABASE_URL_INGEST,
  max: config.WORKER_CONCURRENCY + 2,
  applicationName: `jobswitch-worker/${config.WORKER_ID}`,
  ssl: config.DATABASE_SSL === 'true',
});

const log = (level: string) => (obj: unknown, msg?: string) =>
  console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...(obj as object) }));

const worker = new Worker({
  pool,
  workerId: config.WORKER_ID,
  idleDelayMs: config.WORKER_IDLE_DELAY_MS,
  handlers: {
    [INGEST_QUEUE]: async (payload) => {
      const outcome = await handleIngestSource(pool, payload);
      if (outcome.closingSuppressed) {
        // Loud on purpose: this is the ADR D-05 guard firing, which means a
        // source returned nothing while holding open postings.
        console.log(
          JSON.stringify({
            level: 'warn',
            time: new Date().toISOString(),
            msg: 'closing suppressed: source returned zero postings while holding open ones',
            payload,
          }),
        );
      }
    },
  },
  logger: { info: log('info'), warn: log('warn'), error: log('error') },
});

const shutdown = async (signal: string) => {
  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
  worker.stop();
  // Give the in-flight job a chance to finish before the pool closes.
  setTimeout(() => void pool.end().then(() => process.exit(0)), 5_000).unref();
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

console.log(
  JSON.stringify({ level: 'info', msg: 'worker started', workerId: config.WORKER_ID }),
);
await worker.run();
