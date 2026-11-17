package repo

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// FindDormantActiveSessions lists accounts whose job_search_session is
// still 'active' but started more than staleDays ago with no explicit
// stop - ADR D-31's safety net (specs/ephemeral-retention.md), so an
// abandoned account doesn't keep its résumé indefinitely just because
// nobody clicked "stop."
//
// A genuinely cross-tenant query by nature - it must see every account's
// active sessions to find the dormant ones - which only returns correct,
// complete results under a BYPASSRLS role with no tenant context set,
// exactly like ActiveJobSearchAccountIDs above. Mirrors
// packages/db/src/repositories/jobSearch.ts's own findDormantActiveSessions
// (same WHERE clause), which exists and is tested on the TS side but was
// deliberately left unwired until this worker existed to call it safely.
func FindDormantActiveSessions(ctx context.Context, pool *pgxpool.Pool, staleDays int) ([]string, error) {
	rows, err := pool.Query(ctx,
		`SELECT account_id FROM job_search_session
		 WHERE status = 'active' AND started_at < now() - make_interval(days => $1)`,
		staleDays,
	)
	if err != nil {
		return nil, fmt.Errorf("finding dormant active sessions: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scanning dormant session account id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// purgeTables mirrors packages/db/src/repositories/jobSearch.ts's own
// PURGE_TABLES constant exactly - both lists MUST be extended together
// whenever a new purge-eligible table is added; letting them drift is
// exactly the kind of silent gap D-31 exists to prevent.
var purgeTables = []string{
	"resume_upload",
	"resume_source",
	"resume_artifact",
	"job_application",
	"job_match",
	"match_explanation",
}

// SweepDormantSession stops one dormant session and hard-deletes
// everything it touched, in one transaction - the Go port of
// jobSearch.ts's stopJobSearch, used for the *scheduled* trigger
// (stop_reason 'scheduled_sweep_inactivity') rather than the explicit
// POST /api/v1/job-search/stop (stop_reason 'user_action', which stays
// exclusively app_web's job - this function is never called from a
// request path).
//
// Returns false, nil if the session was no longer active by the time
// this ran (already stopped explicitly between the find and the sweep) -
// a real, benign race, not an error.
func SweepDormantSession(ctx context.Context, pool *pgxpool.Pool, accountID string) (bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("beginning sweep transaction for %s: %w", accountID, err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	tag, err := tx.Exec(ctx,
		`UPDATE job_search_session
		 SET status = 'stopped', stopped_at = now(), stop_reason = 'scheduled_sweep_inactivity'
		 WHERE account_id = $1 AND status = 'active'`,
		accountID,
	)
	if err != nil {
		return false, fmt.Errorf("stopping dormant session for %s: %w", accountID, err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}

	for _, table := range purgeTables {
		if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE account_id = $1`, accountID); err != nil {
			return false, fmt.Errorf("purging %s for %s: %w", table, accountID, err)
		}
	}

	// Kind-scoped, same reasoning as jobSearch.ts's own stopJobSearch:
	// 'desired_role' is derived from candidate_profile/profile_skill -
	// retained biography, not search activity - and must survive.
	if _, err := tx.Exec(ctx,
		`DELETE FROM profile_embedding WHERE account_id = $1 AND kind = 'resume'`, accountID,
	); err != nil {
		return false, fmt.Errorf("purging profile_embedding for %s: %w", accountID, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("committing sweep for %s: %w", accountID, err)
	}
	return true, nil
}
