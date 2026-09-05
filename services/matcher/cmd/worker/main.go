// Command worker is the matcher's queue-driven background process -
// mirrors apps/worker's own claim/execute/complete-or-fail loop
// (specs/ingestion.md), operating on the same job_queue table via a
// disjoint set of queue names, so the two workers (TS and Go) need no
// coordination beyond FOR UPDATE SKIP LOCKED itself.
//
// Runs on the Matcher pool only - this binary is the one place in the
// whole system that legitimately holds BYPASSRLS, per ADR D-13's
// per-account batch pattern. cmd/api never touches this pool.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mayankmishra110/jobswitch-ai/services/matcher/internal/clients"
	"github.com/mayankmishra110/jobswitch-ai/services/matcher/internal/config"
	"github.com/mayankmishra110/jobswitch-ai/services/matcher/internal/queue"
	"github.com/mayankmishra110/jobswitch-ai/services/matcher/internal/worker"

	"github.com/jackc/pgx/v5/pgxpool"
)

type handlerFunc func(context.Context, json.RawMessage) error

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "err", err)
		os.Exit(1)
	}

	aiServiceURL := os.Getenv("AI_SERVICE_URL")
	if aiServiceURL == "" {
		aiServiceURL = "http://127.0.0.1:8100"
	}
	internalToken := os.Getenv("INTERNAL_TOKEN")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	matcherPool, err := pgxpool.New(ctx, cfg.DatabaseURLMatcher)
	if err != nil {
		logger.Error("connecting matcher pool", "err", err)
		os.Exit(1)
	}
	defer matcherPool.Close()

	aiClient := clients.NewAIClient(aiServiceURL, internalToken, &http.Client{Timeout: 30 * time.Second})

	handlers := map[string]handlerFunc{
		worker.EmbedJobVersionQueue: worker.HandleEmbedJobVersion(matcherPool, aiClient),
	}
	queueNames := make([]string, 0, len(handlers))
	for name := range handlers {
		queueNames = append(queueNames, name)
	}

	workerID := os.Getenv("WORKER_ID")
	if workerID == "" {
		workerID = "matcher-worker-local"
	}

	logger.Info("matcher worker started", "workerId", workerID, "queues", queueNames)
	runLoop(ctx, logger, matcherPool, handlers, queueNames, workerID)
	logger.Info("matcher worker stopped")
}

func runLoop(
	ctx context.Context,
	logger *slog.Logger,
	pool *pgxpool.Pool,
	handlers map[string]handlerFunc,
	queueNames []string,
	workerID string,
) {
	const idleDelay = 2 * time.Second

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		job, err := queue.Claim(ctx, pool, queueNames, workerID, 5*time.Minute)
		if err != nil {
			logger.Error("claim failed", "err", err)
			sleep(ctx, idleDelay*2)
			continue
		}
		if job == nil {
			sleep(ctx, idleDelay)
			continue
		}

		handler, ok := handlers[job.Queue]
		if !ok {
			// An unroutable job is a deployment problem (a queue whose
			// handler was removed), same reasoning as apps/worker's own
			// Worker.execute - dead-letter immediately rather than
			// retrying five times to reach the same conclusion.
			if _, err := queue.Fail(ctx, pool, queue.Job{ID: job.ID, Attempts: job.MaxAttempts, MaxAttempts: job.MaxAttempts},
				errors.New("no handler registered for this queue"), queue.FailOptions{}); err != nil {
				logger.Error("dead-lettering unroutable job failed", "jobId", job.ID, "err", err)
			}
			logger.Error("unroutable job", "jobId", job.ID, "queue", job.Queue)
			continue
		}

		if err := handler(ctx, job.Payload); err != nil {
			result, failErr := queue.Fail(ctx, pool, *job, err, queue.FailOptions{})
			if failErr != nil {
				logger.Error("recording failure failed", "jobId", job.ID, "err", failErr)
				continue
			}
			if result.Outcome == queue.FailOutcomeDead {
				logger.Error("job dead-lettered", "jobId", job.ID, "queue", job.Queue, "err", err)
			} else {
				logger.Warn("job failed, will retry", "jobId", job.ID, "queue", job.Queue, "retryAt", result.RetryAt, "err", err)
			}
			continue
		}

		if err := queue.Complete(ctx, pool, job.ID); err != nil {
			logger.Error("marking job complete failed", "jobId", job.ID, "err", err)
			continue
		}
		logger.Info("job completed", "jobId", job.ID, "queue", job.Queue)
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
