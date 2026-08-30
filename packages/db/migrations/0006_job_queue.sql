-- 0006 · The work queue (ADR D-13).
--
-- Postgres rather than Redis. The claim uses FOR UPDATE SKIP LOCKED, which
-- gives correct competition between workers with no external broker. At ~400
-- jobs/day against a ceiling around 500/second, Redis would be a service to
-- run, pay for, secure and back up in exchange for capacity that cannot be
-- used. Revisit triggers are documented in the ADR.

CREATE TABLE job_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue        text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority     integer NOT NULL DEFAULT 100,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'running', 'done', 'dead')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  -- Idempotency. A unique index over live rows only, so the same logical job
  -- cannot be enqueued twice while one is outstanding, but the key becomes
  -- reusable once the work has finished.
  dedup_key    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

CREATE UNIQUE INDEX job_queue_dedup_key
  ON job_queue (dedup_key)
  WHERE dedup_key IS NOT NULL AND status IN ('pending', 'running');

-- The claim query's index. Partial, so completed rows never slow it down even
-- before they are archived.
CREATE INDEX job_queue_claim_idx
  ON job_queue (queue, priority, run_at)
  WHERE status = 'pending';

-- Orphan reclaim: rows whose worker died holding them.
CREATE INDEX job_queue_running_idx
  ON job_queue (locked_at)
  WHERE status = 'running';

-- Dead-letter inspection.
CREATE INDEX job_queue_dead_idx
  ON job_queue (finished_at DESC)
  WHERE status = 'dead';

COMMENT ON COLUMN job_queue.dedup_key IS
  'Unique among pending/running rows. Re-enqueueing the same key is a no-op.';

-- app_ingest runs the workers, so it owns the queue.
GRANT SELECT, INSERT, UPDATE, DELETE ON job_queue TO app_ingest;

-- app_web reads it for the ops view, and enqueues user-triggered work in later
-- phases (a resume parse, a re-match). It must never mutate a claimed job.
GRANT SELECT, INSERT ON job_queue TO app_web;
