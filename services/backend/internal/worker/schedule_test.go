package worker

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/repo"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(testWriter{}, nil))
}

// testWriter discards output - these tests assert on database state, not
// log lines, and a quiet test run is easier to read.
type testWriter struct{}

func (testWriter) Write(p []byte) (int, error) { return len(p), nil }

func TestFindDormantActiveSessionsAndSweep(t *testing.T) {
	admin, matcherPool := setupEmbedProfilePools(t)
	ctx := context.Background()

	dormantAccount := seedBareAccount(t, ctx, admin)
	freshAccount := seedBareAccount(t, ctx, admin)
	stoppedAccount := seedBareAccount(t, ctx, admin)
	t.Cleanup(func() {
		for _, id := range []string{dormantAccount, freshAccount, stoppedAccount} {
			admin.Exec(ctx, "DELETE FROM account WHERE id = $1", id) //nolint:errcheck
		}
	})

	// Dormant: active, started 120 days ago.
	if _, err := admin.Exec(ctx,
		`INSERT INTO job_search_session (account_id, status, started_at) VALUES ($1, 'active', now() - interval '120 days')`,
		dormantAccount,
	); err != nil {
		t.Fatalf("seeding dormant session: %v", err)
	}
	// Fresh: active, started today - must not be swept.
	if _, err := admin.Exec(ctx,
		`INSERT INTO job_search_session (account_id, status, started_at) VALUES ($1, 'active', now())`,
		freshAccount,
	); err != nil {
		t.Fatalf("seeding fresh session: %v", err)
	}
	// Already stopped, old - must not be re-swept (status isn't 'active').
	if _, err := admin.Exec(ctx,
		`INSERT INTO job_search_session (account_id, status, started_at, stopped_at, stop_reason)
		 VALUES ($1, 'stopped', now() - interval '120 days', now(), 'user_action')`,
		stoppedAccount,
	); err != nil {
		t.Fatalf("seeding already-stopped session: %v", err)
	}

	// Purge-target fixtures on the dormant account only, to prove the
	// sweep actually deletes them and not just marks the session stopped.
	if _, err := admin.Exec(ctx,
		`INSERT INTO resume_upload (account_id, filename, raw_text) VALUES ($1, 'r.pdf', 'Some resume text.')`,
		dormantAccount,
	); err != nil {
		t.Fatalf("seeding resume_upload: %v", err)
	}
	if _, err := admin.Exec(ctx,
		`INSERT INTO profile_embedding (account_id, kind, embedding, source_hash, embedding_model)
		 VALUES
		   ($1, 'resume', array_fill(0::real, ARRAY[384])::vector, 'h1', 'test-model'),
		   ($1, 'desired_role', array_fill(0::real, ARRAY[384])::vector, 'h2', 'test-model')`,
		dormantAccount,
	); err != nil {
		t.Fatalf("seeding profile_embedding: %v", err)
	}
	if _, err := admin.Exec(ctx,
		`INSERT INTO candidate_profile (account_id, current_title) VALUES ($1, 'Engineer')`,
		dormantAccount,
	); err != nil {
		t.Fatalf("seeding candidate_profile: %v", err)
	}

	dormant, err := repo.FindDormantActiveSessions(ctx, matcherPool, 90)
	if err != nil {
		t.Fatalf("FindDormantActiveSessions: %v", err)
	}
	if !containsID(dormant, dormantAccount) {
		t.Errorf("expected dormant account %s in %v", dormantAccount, dormant)
	}
	if containsID(dormant, freshAccount) {
		t.Errorf("fresh account %s should not be dormant", freshAccount)
	}
	if containsID(dormant, stoppedAccount) {
		t.Errorf("already-stopped account %s should not be listed (status isn't active)", stoppedAccount)
	}

	stopped, err := repo.SweepDormantSession(ctx, matcherPool, dormantAccount)
	if err != nil {
		t.Fatalf("SweepDormantSession: %v", err)
	}
	if !stopped {
		t.Fatal("expected SweepDormantSession to report it stopped the session")
	}

	var status, reason string
	if err := admin.QueryRow(ctx,
		"SELECT status, stop_reason FROM job_search_session WHERE account_id = $1", dormantAccount,
	).Scan(&status, &reason); err != nil {
		t.Fatalf("reading swept session: %v", err)
	}
	if status != "stopped" || reason != "scheduled_sweep_inactivity" {
		t.Errorf("session = (%q, %q), want (stopped, scheduled_sweep_inactivity)", status, reason)
	}

	var resumeCount, resumeKindCount, desiredRoleKindCount, profileCount int
	admin.QueryRow(ctx, "SELECT count(*) FROM resume_upload WHERE account_id = $1", dormantAccount).Scan(&resumeCount)                                        //nolint:errcheck
	admin.QueryRow(ctx, "SELECT count(*) FROM profile_embedding WHERE account_id = $1 AND kind = 'resume'", dormantAccount).Scan(&resumeKindCount)            //nolint:errcheck
	admin.QueryRow(ctx, "SELECT count(*) FROM profile_embedding WHERE account_id = $1 AND kind = 'desired_role'", dormantAccount).Scan(&desiredRoleKindCount) //nolint:errcheck
	admin.QueryRow(ctx, "SELECT count(*) FROM candidate_profile WHERE account_id = $1", dormantAccount).Scan(&profileCount)                                   //nolint:errcheck

	if resumeCount != 0 {
		t.Errorf("resume_upload rows = %d, want 0 (purged)", resumeCount)
	}
	if resumeKindCount != 0 {
		t.Errorf("profile_embedding 'resume' rows = %d, want 0 (purged)", resumeKindCount)
	}
	if desiredRoleKindCount != 1 {
		t.Errorf("profile_embedding 'desired_role' rows = %d, want 1 (retained - derived from biography, not search activity)", desiredRoleKindCount)
	}
	if profileCount != 1 {
		t.Errorf("candidate_profile rows = %d, want 1 (retained)", profileCount)
	}

	// A second sweep of the same (now-stopped) account is a benign no-op.
	stoppedAgain, err := repo.SweepDormantSession(ctx, matcherPool, dormantAccount)
	if err != nil {
		t.Fatalf("second SweepDormantSession: %v", err)
	}
	if stoppedAgain {
		t.Error("expected the second sweep to report false (nothing active left to stop)")
	}
}

func containsID(ids []string, id string) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

// TestRunScheduledTasksYieldsToAnExistingLockHolder proves the advisory
// lock actually guards this loop: a second "instance" (a raw connection
// holding the same lock id) makes RunScheduledTasks return immediately
// without ever computing a match or sweeping anything, rather than racing
// the lock holder.
func TestRunScheduledTasksYieldsToAnExistingLockHolder(t *testing.T) {
	_, matcherPool := setupEmbedProfilePools(t)
	ctx := context.Background()

	holder, err := matcherPool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquiring lock-holder connection: %v", err)
	}
	defer holder.Release()

	var locked bool
	if err := holder.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", scheduledTasksAdvisoryLock).Scan(&locked); err != nil {
		t.Fatalf("acquiring advisory lock: %v", err)
	}
	if !locked {
		t.Fatal("expected to acquire the lock as the sole holder")
	}
	// A plain `defer holder.QueryRow(...).Scan(...)` would send the unlock
	// query immediately (QueryRow executes eagerly; only .Scan on its
	// result is what defer would postpone) - wrapped in a closure so the
	// unlock genuinely waits for this function to return.
	defer func() {
		var unlocked bool
		holder.QueryRow(ctx, "SELECT pg_advisory_unlock($1)", scheduledTasksAdvisoryLock).Scan(&unlocked) //nolint:errcheck
	}()

	done := make(chan struct{})
	go func() {
		RunScheduledTasks(ctx, matcherPool, testLogger(), time.Hour, 90, nil)
		close(done)
	}()

	select {
	case <-done:
		// Correct: it returned immediately because the lock was held.
	case <-time.After(3 * time.Second):
		t.Fatal("RunScheduledTasks did not yield within 3s of finding the lock held")
	}
}
