package queue

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL_TEST")
	if url == "" {
		url = "postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test"
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connecting: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func cleanQueue(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, "DELETE FROM job_queue"); err != nil {
		t.Fatalf("cleaning job_queue: %v", err)
	}
}

func TestEnqueueAndClaim(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	cleanQueue(t, ctx, pool)

	id, err := Enqueue(ctx, pool, EnqueueParams{Queue: "test.q", Payload: map[string]any{"a": 1}})
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	if id == "" {
		t.Fatal("Enqueue returned empty id")
	}

	job, err := Claim(ctx, pool, []string{"test.q"}, "worker-1", 0)
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if job == nil {
		t.Fatal("Claim returned nil, want the enqueued job")
	}
	if job.Attempts != 1 {
		t.Errorf("Attempts = %d, want 1 (incremented at claim time, per queue.ts)", job.Attempts)
	}
	if job.MaxAttempts != 5 {
		t.Errorf("MaxAttempts = %d, want default 5", job.MaxAttempts)
	}
}

func TestClaimReturnsNilWhenNothingPending(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	cleanQueue(t, ctx, pool)

	job, err := Claim(ctx, pool, []string{"empty.q"}, "worker-1", 0)
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if job != nil {
		t.Errorf("Claim = %+v, want nil", job)
	}
}

func TestClaimOnlyMatchesRequestedQueues(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	cleanQueue(t, ctx, pool)

	Enqueue(ctx, pool, EnqueueParams{Queue: "other.q"}) //nolint:errcheck

	job, err := Claim(ctx, pool, []string{"mine.q"}, "worker-1", 0)
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if job != nil {
		t.Errorf("Claim matched a job from an unrequested queue: %+v", job)
	}
}

func TestClaimOrdersByPriorityThenRunAt(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	cleanQueue(t, ctx, pool)

	low := 200
	high := 10
	idLow, _ := Enqueue(ctx, pool, EnqueueParams{Queue: "prio.q", Priority: &low})
	idHigh, _ := Enqueue(ctx, pool, EnqueueParams{Queue: "prio.q", Priority: &high})

	job, err := Claim(ctx, pool, []string{"prio.q"}, "worker-1", 0)
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if job.ID != idHigh {
		t.Errorf("claimed %s (the low-priority-number job %s should win, got the other: %s)", job.ID, idHigh, idLow)
	}
}

func TestEnqueueDedupKeyIsANoOpNotAnError(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	cleanQueue(t, ctx, pool)

	key := "same-key"
	first, err := Enqueue(ctx, pool, EnqueueParams{Queue: "dedup.q", DedupKey: &key})
	if err != nil {
		t.Fatalf("first Enqueue: %v", err)
	}
	second, err := Enqueue(ctx, pool, EnqueueParams{Queue: "dedup.q", DedupKey: &key})
	if err != nil {
		t.Fatalf("second Enqueue: %v", err)
	}
	if first == "" {
		t.Fatal("first Enqueue should have succeeded")
	}
	if second != "" {
		t.Errorf("second Enqueue with a live dedup key = %q, want empty string (silent no-op)", second)
	}

	var count int
	pool.QueryRow(ctx, "SELECT count(*) FROM job_queue WHERE dedup_key = $1", key).Scan(&count) //nolint:errcheck
	if count != 1 {
		t.Errorf("job_queue has %d rows for the dedup key, want exactly 1", count)
	}
}

func TestCompleteMarksJobDone(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	cleanQueue(t, ctx, pool)

	Enqueue(ctx, pool, EnqueueParams{Queue: "complete.q"}) //nolint:errcheck
	job, _ := Claim(ctx, pool, []string{"complete.q"}, "worker-1", 0)

	if err := Complete(ctx, pool, job.ID); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	var status string
	pool.QueryRow(ctx, "SELECT status FROM job_queue WHERE id = $1", job.ID).Scan(&status) //nolint:errcheck
	if status != "done" {
		t.Errorf("status = %q, want done", status)
	}
}

func TestFailRetriesWithinAttemptBudget(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	cleanQueue(t, ctx, pool)

	max := 3
	Enqueue(ctx, pool, EnqueueParams{Queue: "fail.q", MaxAttempts: &max}) //nolint:errcheck
	job, _ := Claim(ctx, pool, []string{"fail.q"}, "worker-1", 0)         // attempts=1

	result, err := Fail(ctx, pool, *job, errors.New("boom"), FailOptions{})
	if err != nil {
		t.Fatalf("Fail: %v", err)
	}
	if result.Outcome != FailOutcomeRetry {
		t.Fatalf("Outcome = %q, want retry (attempts=1 < maxAttempts=3)", result.Outcome)
	}

	var status string
	var lastError string
	pool.QueryRow(ctx, "SELECT status, last_error FROM job_queue WHERE id = $1", job.ID).Scan(&status, &lastError) //nolint:errcheck
	if status != "pending" {
		t.Errorf("status = %q, want pending", status)
	}
	if lastError != "boom" {
		t.Errorf("last_error = %q, want boom", lastError)
	}
}

func TestFailDeadLettersOnceAttemptsAreSpent(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	cleanQueue(t, ctx, pool)

	max := 1
	Enqueue(ctx, pool, EnqueueParams{Queue: "dead.q", MaxAttempts: &max}) //nolint:errcheck
	job, _ := Claim(ctx, pool, []string{"dead.q"}, "worker-1", 0)         // attempts=1, equals maxAttempts=1

	result, err := Fail(ctx, pool, *job, errors.New("permanent failure"), FailOptions{})
	if err != nil {
		t.Fatalf("Fail: %v", err)
	}
	if result.Outcome != FailOutcomeDead {
		t.Fatalf("Outcome = %q, want dead (attempts=1 >= maxAttempts=1)", result.Outcome)
	}

	var status string
	pool.QueryRow(ctx, "SELECT status FROM job_queue WHERE id = $1", job.ID).Scan(&status) //nolint:errcheck
	if status != "dead" {
		t.Errorf("status = %q, want dead", status)
	}
}

func TestFailBackoffIsWithinExpectedBounds(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	cleanQueue(t, ctx, pool)

	max := 5
	Enqueue(ctx, pool, EnqueueParams{Queue: "backoff.q", MaxAttempts: &max}) //nolint:errcheck
	job, _ := Claim(ctx, pool, []string{"backoff.q"}, "worker-1", 0)         // attempts=1

	before := time.Now()
	result, err := Fail(ctx, pool, *job, errors.New("x"), FailOptions{BaseDelay: 30 * time.Second, MaxDelay: time.Hour})
	if err != nil {
		t.Fatalf("Fail: %v", err)
	}

	// attempts=1: backoff = min(30s * 2^0, 1h) = 30s, plus up to 30% jitter -> [30s, 39s).
	delay := result.RetryAt.Sub(before)
	if delay < 30*time.Second || delay >= 40*time.Second {
		t.Errorf("retry delay = %v, want in [30s, 40s)", delay)
	}
}

// TestClaimUnderConcurrencyNeverDoubleClaims proves the FOR UPDATE SKIP
// LOCKED property Go's own Claim relies on: many goroutines racing for
// the same small set of jobs each get a distinct one, none overlap.
func TestClaimUnderConcurrencyNeverDoubleClaims(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	cleanQueue(t, ctx, pool)

	const numJobs = 20
	for i := 0; i < numJobs; i++ {
		if _, err := Enqueue(ctx, pool, EnqueueParams{Queue: "race.q", Payload: map[string]any{"i": i}}); err != nil {
			t.Fatalf("seeding job %d: %v", i, err)
		}
	}

	var mu sync.Mutex
	claimed := map[string]int{} // job id -> number of times claimed

	var wg sync.WaitGroup
	for w := 0; w < 10; w++ {
		wg.Add(1)
		go func(workerID string) {
			defer wg.Done()
			for {
				job, err := Claim(ctx, pool, []string{"race.q"}, workerID, 0)
				if err != nil || job == nil {
					return
				}
				mu.Lock()
				claimed[job.ID]++
				mu.Unlock()
				Complete(ctx, pool, job.ID) //nolint:errcheck
			}
		}(fmt.Sprintf("worker-%d", w))
	}
	wg.Wait()

	if len(claimed) != numJobs {
		t.Errorf("claimed %d distinct jobs, want %d", len(claimed), numJobs)
	}
	for id, count := range claimed {
		if count != 1 {
			t.Errorf("job %s was claimed %d times, want exactly 1", id, count)
		}
	}
}

// TestClaimInteropWithTSStyleQuery proves the two languages' claim
// queries can safely race on the same table - not by spawning a real
// Node process, but by running Go's Claim() concurrently against a
// second implementation built from the LITERAL SQL in
// packages/db/src/repositories/queue.ts's claim() function (copied, not
// paraphrased). If the two queries disagreed about locking semantics,
// this test would show double claims; FOR UPDATE SKIP LOCKED is
// per-statement, not per-language, so they don't.
func TestClaimInteropWithTSStyleQuery(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	cleanQueue(t, ctx, pool)

	const numJobs = 20
	for i := 0; i < numJobs; i++ {
		if _, err := Enqueue(ctx, pool, EnqueueParams{Queue: "interop.q"}); err != nil {
			t.Fatalf("seeding job %d: %v", i, err)
		}
	}

	// Verbatim copy of queue.ts's claim() SQL - see that file, same
	// query text, run directly here rather than through Go's Claim().
	const tsStyleClaimSQL = `
		UPDATE job_queue q
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
		RETURNING q.id`

	var mu sync.Mutex
	claimed := map[string]int{}

	var wg sync.WaitGroup
	for w := 0; w < 5; w++ {
		wg.Add(1)
		go func(workerID string) {
			defer wg.Done()
			for {
				job, err := Claim(ctx, pool, []string{"interop.q"}, workerID, 0)
				if err != nil || job == nil {
					return
				}
				mu.Lock()
				claimed[job.ID]++
				mu.Unlock()
				Complete(ctx, pool, job.ID) //nolint:errcheck
			}
		}(fmt.Sprintf("go-worker-%d", w))
	}
	for w := 0; w < 5; w++ {
		wg.Add(1)
		go func(workerID string) {
			defer wg.Done()
			for {
				var id string
				err := pool.QueryRow(ctx, tsStyleClaimSQL, []string{"interop.q"}, workerID, "300000").Scan(&id)
				if err != nil {
					return // no more rows
				}
				mu.Lock()
				claimed[id]++
				mu.Unlock()
				Complete(ctx, pool, id) //nolint:errcheck
			}
		}(fmt.Sprintf("ts-style-worker-%d", w))
	}
	wg.Wait()

	if len(claimed) != numJobs {
		t.Errorf("claimed %d distinct jobs across both query styles, want %d", len(claimed), numJobs)
	}
	for id, count := range claimed {
		if count != 1 {
			t.Errorf("job %s was claimed %d times across the two query styles, want exactly 1", id, count)
		}
	}
}
