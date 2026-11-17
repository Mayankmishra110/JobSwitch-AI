package worker

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/events"
	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/match"
	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/repo"
)

// scheduledTasksAdvisoryLock is cmd/worker's own singleton guard, distinct
// from apps/scheduler's SCHEDULER_ADVISORY_LOCK (8_240_119) - two
// unrelated periodic loops, two unrelated lock ids, so accidentally
// running one twice can never be masked by the other's lock.
const scheduledTasksAdvisoryLock = 8_240_221

// RunScheduledTasks is cmd/worker's periodic, non-queue-driven half:
// compute matches for every account currently searching, then sweep
// sessions dormant past staleDays (ADR D-31's safety net). Mirrors
// apps/scheduler's own tick+advisory-lock shape (specs/ingestion.md), but
// lives inside this binary rather than a separate process - per
// specs/ephemeral-retention.md's own note, the dormancy sweep is "one
// more per-account task in the Go matcher-worker's existing BYPASSRLS
// batch loop," not a new service.
//
// Guarded by a session-scoped Postgres advisory lock held for the
// lifetime of this call, exactly like apps/scheduler: a second replica
// started during a deploy (matcher-worker is meant to run as exactly one,
// per docs/BUILD_PLAN.md's D-29 sizing table, but this is defense in
// depth, not the only guard) finds the lock held and returns immediately
// - it does NOT exit the whole process, unlike apps/scheduler, because
// this binary's primary job (claiming from job_queue) must keep running
// regardless of whether this particular replica also owns the schedule.
func RunScheduledTasks(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger, tickInterval time.Duration, staleDays int, publisher *events.Publisher) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		logger.Error("scheduled tasks: acquiring a connection for the advisory lock failed", "err", err)
		return
	}
	defer conn.Release()

	var locked bool
	if err := conn.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", scheduledTasksAdvisoryLock).Scan(&locked); err != nil {
		logger.Error("scheduled tasks: acquiring advisory lock failed", "err", err)
		return
	}
	if !locked {
		logger.Warn("scheduled tasks: another instance holds the lock; this replica will not run them")
		return
	}

	logger.Info("scheduled tasks started", "tickInterval", tickInterval.String(), "dormantStaleDays", staleDays)

	for {
		runMatchingTick(ctx, pool, logger, publisher)
		sweepDormantTick(ctx, pool, logger, staleDays)

		select {
		case <-ctx.Done():
			return
		case <-time.After(tickInterval):
		}
	}
}

// runMatchingTick computes matches for every account currently searching.
// One account's failure is logged and skipped, never fatal to the batch -
// the same per-account isolation ADR D-13 already establishes for this
// pool's every other operation.
func runMatchingTick(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger, publisher *events.Publisher) {
	accountIDs, err := repo.ActiveJobSearchAccountIDs(ctx, pool)
	if err != nil {
		logger.Error("scheduled tasks: listing active job search accounts failed", "err", err)
		return
	}

	for _, accountID := range accountIDs {
		result, err := match.RunForAccount(ctx, pool, accountID, publisher)
		if err != nil {
			logger.Error("scheduled match run failed", "accountId", accountID, "err", err)
			continue
		}
		logger.Info("scheduled match run complete",
			"accountId", accountID,
			"candidatesConsidered", result.CandidatesConsidered,
			"matchesWritten", result.MatchesWritten,
		)
	}
}

// sweepDormantTick stops and purges sessions dormant past staleDays.
func sweepDormantTick(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger, staleDays int) {
	accountIDs, err := repo.FindDormantActiveSessions(ctx, pool, staleDays)
	if err != nil {
		logger.Error("scheduled tasks: finding dormant sessions failed", "err", err)
		return
	}

	for _, accountID := range accountIDs {
		stopped, err := repo.SweepDormantSession(ctx, pool, accountID)
		if err != nil {
			logger.Error("dormant session sweep failed", "accountId", accountID, "err", err)
			continue
		}
		if stopped {
			logger.Info("swept dormant session", "accountId", accountID)
		}
	}
}
