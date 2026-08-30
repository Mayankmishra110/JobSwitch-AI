import { queueRepo, type Pool, type QueueJob } from '@jobswitch/db';

/**
 * The queue worker loop.
 *
 * Claim one job, run its handler, mark done or failed, repeat. When the queue
 * is empty it sleeps rather than spinning - polling flat out would turn an
 * idle system into constant database load for no benefit.
 */

export type JobHandler = (
  payload: Record<string, unknown>,
  job: QueueJob,
) => Promise<void>;

export interface WorkerOptions {
  pool: Pool;
  workerId: string;
  handlers: Record<string, JobHandler>;
  /** How long to wait when there is nothing to do. */
  idleDelayMs?: number;
  /** Must exceed the longest handler runtime, or a job can be double-claimed. */
  visibilityTimeoutMs?: number;
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class Worker {
  private running = false;
  private stopping = false;
  private readonly queues: string[];
  private readonly logger: NonNullable<WorkerOptions['logger']>;

  constructor(private readonly options: WorkerOptions) {
    this.queues = Object.keys(options.handlers);
    this.logger = options.logger ?? noopLogger;

    if (this.queues.length === 0) {
      throw new Error('Worker requires at least one handler');
    }
  }

  /**
   * Process at most `max` jobs and return how many ran.
   *
   * Exposed separately from `run()` so tests can drive the loop deterministically
   * instead of racing a background timer.
   */
  async processOnce(max = 1): Promise<number> {
    let processed = 0;

    for (let i = 0; i < max; i += 1) {
      const job = await queueRepo.claim(this.options.pool, {
        queues: this.queues,
        workerId: this.options.workerId,
        ...(this.options.visibilityTimeoutMs
          ? { visibilityTimeoutMs: this.options.visibilityTimeoutMs }
          : {}),
      });

      if (!job) break;

      await this.execute(job);
      processed += 1;
    }

    return processed;
  }

  private async execute(job: QueueJob): Promise<void> {
    const handler = this.options.handlers[job.queue];

    if (!handler) {
      // An unroutable job is a deployment problem - a queue whose handler was
      // removed. Dead-letter it immediately rather than retrying five times to
      // reach the same conclusion.
      await queueRepo.fail(
        this.options.pool,
        { ...job, attempts: job.maxAttempts },
        new Error(`no handler registered for queue "${job.queue}"`),
      );
      this.logger.error({ jobId: job.id, queue: job.queue }, 'unroutable job');
      return;
    }

    try {
      await handler(job.payload, job);
      await queueRepo.complete(this.options.pool, job.id);
      this.logger.info(
        { jobId: job.id, queue: job.queue, attempts: job.attempts },
        'job completed',
      );
    } catch (error) {
      const result = await queueRepo.fail(this.options.pool, job, error);
      if (result.outcome === 'dead') {
        this.logger.error(
          { jobId: job.id, queue: job.queue, err: error },
          'job dead-lettered',
        );
      } else {
        this.logger.warn(
          { jobId: job.id, queue: job.queue, retryAt: result.retryAt, err: error },
          'job failed, will retry',
        );
      }
    }
  }

  async run(): Promise<void> {
    this.running = true;
    const idle = this.options.idleDelayMs ?? 2_000;

    while (!this.stopping) {
      try {
        const processed = await this.processOnce(10);
        if (processed === 0) await sleep(idle, () => this.stopping);
      } catch (error) {
        // A database outage must not kill the process - it will come back, and
        // a crash-loop makes recovery slower than a backoff does.
        this.logger.error({ err: error }, 'worker loop error');
        await sleep(idle * 2, () => this.stopping);
      }
    }

    this.running = false;
  }

  /**
   * Stop after the in-flight job finishes.
   *
   * Graceful rather than immediate: killing a handler mid-transaction leaves a
   * claimed row that only the visibility timeout will recover, delaying the
   * work by minutes for no reason.
   */
  stop(): void {
    this.stopping = true;
  }

  get isRunning(): boolean {
    return this.running;
  }
}

function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const step = Math.min(ms, 200);
    let waited = 0;
    const tick = () => {
      if (cancelled() || waited >= ms) return resolve();
      waited += step;
      setTimeout(tick, step).unref?.();
    };
    setTimeout(tick, step).unref?.();
  });
}
