// Package queue is a Go port of packages/db/src/repositories/queue.ts,
// operating on the exact same job_queue table apps/worker already claims
// from. Every statement here is reproduced verbatim from that file - same
// columns, same WHERE clauses, same backoff formula - so the two workers
// can share one queue with no coordination beyond FOR UPDATE SKIP LOCKED
// itself (ADR D-13).
//
// Runs on the Matcher pool (app_matcher, granted SELECT/INSERT/UPDATE on
// job_queue in migration 0011) - job_queue carries no RLS policies at all
// (it isn't tenant data), so this is an ordinary grant, not a BYPASSRLS
// concern the way profile/job_match reads are.
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Job struct {
	ID          string
	Queue       string
	Payload     json.RawMessage
	Attempts    int
	MaxAttempts int
}

type EnqueueParams struct {
	Queue       string
	Payload     any
	RunAt       *time.Time
	Priority    *int
	MaxAttempts *int
	// DedupKey: unique among pending/running rows. Re-enqueueing a live
	// key is a silent no-op - the ON CONFLICT DO NOTHING mirrors
	// queue.ts's own comment: this is what makes an enqueue point safe to
	// call twice.
	DedupKey *string
}

// Enqueue returns the new job's id, or "" (not an error) when a live job
// already holds the dedup key.
func Enqueue(ctx context.Context, pool *pgxpool.Pool, params EnqueueParams) (string, error) {
	payload := params.Payload
	if payload == nil {
		payload = map[string]any{}
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshaling payload: %w", err)
	}

	priority := 100
	if params.Priority != nil {
		priority = *params.Priority
	}
	maxAttempts := 5
	if params.MaxAttempts != nil {
		maxAttempts = *params.MaxAttempts
	}

	var id string
	err = pool.QueryRow(ctx,
		`INSERT INTO job_queue (queue, payload, run_at, priority, max_attempts, dedup_key)
		 VALUES ($1, $2, COALESCE($3, now()), $4, $5, $6)
		 ON CONFLICT DO NOTHING
		 RETURNING id`,
		params.Queue, payloadJSON, params.RunAt, priority, maxAttempts, params.DedupKey,
	).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil // dedup no-op, not a failure
		}
		return "", fmt.Errorf("enqueuing %s: %w", params.Queue, err)
	}
	return id, nil
}

// Claim reproduces queue.ts's claim() exactly: one UPDATE whose inner
// SELECT uses FOR UPDATE SKIP LOCKED, so N concurrent callers (Go or TS,
// any mix) each get a different row with no coordination. attempts is
// incremented as PART OF the claim, not on first handler execution - a
// handler's first run already sees attempts=1, matching the TS side.
func Claim(ctx context.Context, pool *pgxpool.Pool, queues []string, workerID string, visibilityTimeout time.Duration) (*Job, error) {
	if visibilityTimeout <= 0 {
		visibilityTimeout = 5 * time.Minute
	}
	visibilityMs := visibilityTimeout.Milliseconds()

	var job Job
	err := pool.QueryRow(ctx,
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
		queues, workerID, fmt.Sprintf("%d", visibilityMs),
	).Scan(&job.ID, &job.Queue, &job.Payload, &job.Attempts, &job.MaxAttempts)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("claiming from %v: %w", queues, err)
	}
	return &job, nil
}

func Complete(ctx context.Context, pool *pgxpool.Pool, jobID string) error {
	_, err := pool.Exec(ctx,
		`UPDATE job_queue
		 SET status = 'done', finished_at = now(), locked_at = NULL,
		     locked_by = NULL, updated_at = now()
		 WHERE id = $1`,
		jobID,
	)
	if err != nil {
		return fmt.Errorf("completing job %s: %w", jobID, err)
	}
	return nil
}

type FailOutcome string

const (
	FailOutcomeRetry FailOutcome = "retry"
	FailOutcomeDead  FailOutcome = "dead"
)

type FailResult struct {
	Outcome FailOutcome
	RetryAt *time.Time
}

type FailOptions struct {
	BaseDelay time.Duration // default 30s
	MaxDelay  time.Duration // default 1h
}

// Fail reproduces queue.ts's fail(): dead-letter once attempts are spent,
// otherwise schedule a retry with the exact same backoff formula -
// min(base * 2^(attempts-1), max) plus up to 30% jitter. The jitter
// matters for the same reason the TS comment gives: without it, every
// job that failed together in one burst retries in the same instant.
func Fail(ctx context.Context, pool *pgxpool.Pool, job Job, cause error, opts FailOptions) (FailResult, error) {
	message := cause.Error()
	if len(message) > 2000 {
		message = message[:2000]
	}

	if job.Attempts >= job.MaxAttempts {
		_, err := pool.Exec(ctx,
			`UPDATE job_queue
			 SET status = 'dead', last_error = $2, finished_at = now(),
			     locked_at = NULL, locked_by = NULL, updated_at = now()
			 WHERE id = $1`,
			job.ID, message,
		)
		if err != nil {
			return FailResult{}, fmt.Errorf("dead-lettering job %s: %w", job.ID, err)
		}
		return FailResult{Outcome: FailOutcomeDead}, nil
	}

	base := opts.BaseDelay
	if base <= 0 {
		base = 30 * time.Second
	}
	maxDelay := opts.MaxDelay
	if maxDelay <= 0 {
		maxDelay = time.Hour
	}

	backoff := time.Duration(math.Min(
		float64(base)*math.Pow(2, float64(job.Attempts-1)),
		float64(maxDelay),
	))
	jitter := time.Duration(rand.Float64() * float64(backoff) * 0.3) //nolint:gosec // jitter, not security-sensitive
	retryAt := time.Now().Add(backoff + jitter)

	_, err := pool.Exec(ctx,
		`UPDATE job_queue
		 SET status = 'pending', run_at = $3, last_error = $2,
		     locked_at = NULL, locked_by = NULL, updated_at = now()
		 WHERE id = $1`,
		job.ID, message, retryAt,
	)
	if err != nil {
		return FailResult{}, fmt.Errorf("scheduling retry for job %s: %w", job.ID, err)
	}
	return FailResult{Outcome: FailOutcomeRetry, RetryAt: &retryAt}, nil
}
