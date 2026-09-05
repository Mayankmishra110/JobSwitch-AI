// Package repo holds the matcher's read/write access to Postgres.
//
// Every function here runs on the Matcher pool (app_matcher, BYPASSRLS -
// see internal/db's doc comment) and therefore MUST filter by account_id
// explicitly in its own WHERE clause. RLS is not doing that job for this
// role; the SQL is. This is the one discipline every function in this
// package is required to hold, and the cross-tenant leakage test in
// internal/match exists specifically to catch a violation of it.
package repo

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CandidateFacts is the subset of a candidate's profile the matcher reads.
// Every field is exactly what candidate_profile/profile_skill already
// store - this is a read model, not a new source of truth.
type CandidateFacts struct {
	AccountID        string
	CurrentTitle     *string
	YearsExperience  *int16
	DesiredTitles    []string
	DesiredLocations []string
	DesiredWorkMode  *string // "remote" | "hybrid" | "onsite" | "any" | nil
	DesiredSalaryMin *int32
	DesiredSalaryMax *int32
	Skills           []string
}

// LoadCandidateFacts reads one account's matching-relevant profile data.
// Explicit account_id filter, per this package's own rule above.
func LoadCandidateFacts(ctx context.Context, pool *pgxpool.Pool, accountID string) (CandidateFacts, error) {
	f := CandidateFacts{AccountID: accountID}

	err := pool.QueryRow(ctx,
		`SELECT current_title, years_experience, desired_titles, desired_locations,
		        desired_work_mode, desired_salary_min, desired_salary_max
		 FROM candidate_profile
		 WHERE account_id = $1`,
		accountID,
	).Scan(
		&f.CurrentTitle, &f.YearsExperience, &f.DesiredTitles, &f.DesiredLocations,
		&f.DesiredWorkMode, &f.DesiredSalaryMin, &f.DesiredSalaryMax,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			// No profile row yet is a real, reachable state (a freshly
			// signed-up account) - not an error. Every field stays at its
			// zero value, which the prefilter treats as "no constraint."
			return f, nil
		}
		return CandidateFacts{}, fmt.Errorf("loading candidate_profile for %s: %w", accountID, err)
	}

	rows, err := pool.Query(ctx,
		`SELECT skill FROM profile_skill WHERE account_id = $1`,
		accountID,
	)
	if err != nil {
		return CandidateFacts{}, fmt.Errorf("loading profile_skill for %s: %w", accountID, err)
	}
	defer rows.Close()

	for rows.Next() {
		var skill string
		if err := rows.Scan(&skill); err != nil {
			return CandidateFacts{}, fmt.Errorf("scanning skill row for %s: %w", accountID, err)
		}
		f.Skills = append(f.Skills, skill)
	}
	if err := rows.Err(); err != nil {
		return CandidateFacts{}, fmt.Errorf("iterating skill rows for %s: %w", accountID, err)
	}

	return f, nil
}

// ActiveJobSearchAccountIDs lists every account currently searching
// (job_search_session.status = 'active').
//
// A genuinely cross-tenant query by nature - it must see every account to
// find the active ones - which only returns correct, complete results
// under a BYPASSRLS role with no tenant context set. This is exactly the
// shape packages/db/src/repositories/jobSearch.ts's own
// findDormantActiveSessions was written for and deliberately left unwired
// until this service existed to call it correctly (see that file's doc
// comment on the TS side). The matcher-worker is that caller.
func ActiveJobSearchAccountIDs(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx,
		`SELECT account_id FROM job_search_session WHERE status = 'active'`,
	)
	if err != nil {
		return nil, fmt.Errorf("listing active job search accounts: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scanning account id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
