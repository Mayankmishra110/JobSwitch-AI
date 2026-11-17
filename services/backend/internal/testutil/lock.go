// Package testutil holds cross-package test infrastructure for
// services/backend - currently just the shared-Postgres serialization lock
// below.
package testutil

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

// dbTestLockKey is a session-level Postgres advisory lock id reserved for
// serializing this module's test packages against each other. Distinct
// from every advisory lock the running application itself takes
// (apps/scheduler's SCHEDULER_ADVISORY_LOCK 8_240_119,
// internal/worker/schedule.go's scheduledTasksAdvisoryLock 8_240_221) so a
// test run can never be masked by, or interfere with, an app-level lock.
const dbTestLockKey = 8_240_930

// AdminURL returns the shared test Postgres connection string every
// integration test package already falls back to individually
// (DATABASE_URL_TEST, defaulting to the same local jobswitch_test
// database) - centralized here so the lock below and each package's own
// setup helper agree on which database they're serializing access to.
func AdminURL() string {
	if v := os.Getenv("DATABASE_URL_TEST"); v != "" {
		return v
	}
	return "postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test"
}

// WithSerializedDBAccess runs m.Run() while holding a blocking Postgres
// advisory lock, and is meant to be called from every test package's
// TestMain that talks to the shared test Postgres (currently: session,
// queue, match, worker).
//
// Why this exists: `go test ./...` runs each package's tests in a
// separate process, in parallel by default (controlled by -p, which
// defaults to GOMAXPROCS) - but these packages' integration tests do
// broad, unscoped cleanup (DELETE FROM <table>, not scoped to rows a
// single test created) against the one shared real Postgres database.
// Two packages' tests running concurrently then race each other's
// cleanup/seed steps, which is exactly the failure this fixes: it was
// diagnosed by reproducing real, intermittent failures
// (TestResolveValidSession, TestHandleEmbedProfileEndToEnd) under plain
// `go test ./...`, confirming they vanished under `go test -p 1 ./...`,
// and then replacing "remember to pass -p 1" with something the test
// binaries enforce themselves. Mirrors two precedents already in this
// codebase: packages/db/vitest.config.ts's fileParallelism: false (same
// problem, TS side, same "serial is correct here, not a workaround"
// reasoning) and apps/scheduler's own pg_try_advisory_lock pattern -
// this is that pattern's blocking sibling, since a test package should
// wait its turn rather than skip its run entirely.
//
// A session-level advisory lock is tied to the specific connection that
// took it, not to the pool - so this holds one *Conn checked out from the
// pool for the entire duration of m.Run(), and releases the identical
// connection at the end. Fatal on any setup failure (os.Exit, matching
// TestMain's own contract): a test run that can't even acquire its
// serialization lock has nothing trustworthy to report.
func WithSerializedDBAccess(m interface{ Run() int }) int {
	ctx := context.Background()

	pool, err := pgxpool.New(ctx, AdminURL())
	if err != nil {
		fmt.Fprintf(os.Stderr, "testutil: connecting for advisory lock: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()

	conn, err := pool.Acquire(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "testutil: acquiring a connection for the advisory lock: %v\n", err)
		os.Exit(1)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", dbTestLockKey); err != nil {
		fmt.Fprintf(os.Stderr, "testutil: acquiring advisory lock: %v\n", err)
		os.Exit(1)
	}
	defer conn.Exec(ctx, "SELECT pg_advisory_unlock($1)", dbTestLockKey) //nolint:errcheck // best-effort on the way out

	return m.Run()
}
