package match

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Integration tests against the same real Postgres the rest of this
// project uses - no mocks for anything RLS/tenancy touches (the project's
// standing rule, and match.RunForAccount is exactly that).

func adminURL() string {
	if v := os.Getenv("DATABASE_URL_TEST"); v != "" {
		return v
	}
	return "postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test"
}

func matcherURL() string {
	if v := os.Getenv("DATABASE_URL_TEST_MATCHER"); v != "" {
		return v
	}
	return "postgres://app_matcher_test:matcherpassword@127.0.0.1:5432/jobswitch_test"
}

func setupPools(t *testing.T) (admin, matcherPool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()

	admin, err := pgxpool.New(ctx, adminURL())
	if err != nil {
		t.Fatalf("connecting admin pool: %v", err)
	}
	t.Cleanup(admin.Close)

	_, err = admin.Exec(ctx, `
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_matcher_test') THEN
				CREATE ROLE app_matcher_test LOGIN PASSWORD 'matcherpassword';
			END IF;
		END
		$$;
	`)
	if err != nil {
		t.Fatalf("ensuring app_matcher_test role: %v", err)
	}
	if _, err := admin.Exec(ctx, "GRANT app_matcher TO app_matcher_test"); err != nil {
		t.Fatalf("granting app_matcher to app_matcher_test: %v", err)
	}
	// BYPASSRLS is a role ATTRIBUTE, not a privilege - Postgres deliberately
	// does not let it propagate through GRANT membership (unlike table
	// privileges, which do inherit). A login role that is merely a member
	// of app_matcher still has rolbypassrls = false for its own sessions;
	// it must be granted directly. This is exactly the misconfiguration
	// internal/db's own doc comment warns a shared web+matcher pool would
	// risk - found here by this very test failing against real Postgres,
	// not by re-reading that comment. docs/DEPLOYMENT.md's real provisioning
	// step for app_matcher_prod needs this same explicit ALTER, not just
	// the GRANT membership pattern app_web/app_ingest use.
	if _, err := admin.Exec(ctx, "ALTER ROLE app_matcher_test BYPASSRLS"); err != nil {
		t.Fatalf("granting BYPASSRLS to app_matcher_test: %v", err)
	}

	matcherPool, err = pgxpool.New(ctx, matcherURL())
	if err != nil {
		t.Fatalf("connecting matcher pool: %v", err)
	}
	t.Cleanup(matcherPool.Close)

	return admin, matcherPool
}

// seededAccount is a full fixture: an account with a candidate_profile and
// profile_skill rows, set up via the owner pool (bypasses RLS/grants,
// legitimate for test setup - the code under test never uses this pool).
type seededAccount struct {
	accountID string
}

func seedAccount(t *testing.T, ctx context.Context, admin *pgxpool.Pool, opts struct {
	currentTitle     *string
	desiredLocations []string
	desiredWorkMode  *string
	desiredSalaryMin *int
	skills           []string
}) seededAccount {
	t.Helper()

	var accountID string
	if err := admin.QueryRow(ctx,
		`INSERT INTO account (type) VALUES ('personal') RETURNING id`,
	).Scan(&accountID); err != nil {
		t.Fatalf("inserting account: %v", err)
	}

	if _, err := admin.Exec(ctx,
		`INSERT INTO candidate_profile (account_id, current_title, desired_locations, desired_work_mode, desired_salary_min)
		 VALUES ($1, $2, $3, $4, $5)`,
		accountID, opts.currentTitle, opts.desiredLocations, opts.desiredWorkMode, opts.desiredSalaryMin,
	); err != nil {
		t.Fatalf("inserting candidate_profile: %v", err)
	}

	for _, skill := range opts.skills {
		if _, err := admin.Exec(ctx,
			`INSERT INTO profile_skill (account_id, skill) VALUES ($1, $2)`,
			accountID, skill,
		); err != nil {
			t.Fatalf("inserting profile_skill %q: %v", skill, err)
		}
	}

	return seededAccount{accountID: accountID}
}

type seededPosting struct {
	jobPostingID        string
	jobPostingVersionID string
}

// seedPosting inserts a full company -> career_source -> job_posting ->
// job_posting_version -> job_posting_location chain via the owner pool.
func seedPosting(t *testing.T, ctx context.Context, admin *pgxpool.Pool, opts struct {
	title       string
	description string
	city        string
	workMode    string // "onsite" | "remote" | "hybrid"
	salaryMax   *float64
	closed      bool
	firstSeenAt time.Time
	lastSeenAt  time.Time
	sourceJobID string
}) seededPosting {
	t.Helper()

	var companyID string
	if err := admin.QueryRow(ctx,
		`INSERT INTO company (name, normalized_domain) VALUES ($1, $2) RETURNING id`,
		"Match Test Co "+opts.sourceJobID, "matchtestco-"+opts.sourceJobID+".example",
	).Scan(&companyID); err != nil {
		t.Fatalf("inserting company: %v", err)
	}

	var sourceID string
	if err := admin.QueryRow(ctx,
		`INSERT INTO career_source (company_id, ats_type, board_identifier) VALUES ($1, 'greenhouse', $2) RETURNING id`,
		companyID, "matchtestco-"+opts.sourceJobID,
	).Scan(&sourceID); err != nil {
		t.Fatalf("inserting career_source: %v", err)
	}

	var closedAt *time.Time
	if opts.closed {
		t := time.Now()
		closedAt = &t
	}

	var postingID string
	if err := admin.QueryRow(ctx,
		`INSERT INTO job_posting
		   (career_source_id, company_id, source_job_id, canonical_title, normalized_title,
		    apply_url, first_seen_at, last_seen_at, closed_at)
		 VALUES ($1, $2, $3, $4, $4, 'https://example.com/apply', $5, $6, $7)
		 RETURNING id`,
		sourceID, companyID, opts.sourceJobID, opts.title, opts.firstSeenAt, opts.lastSeenAt, closedAt,
	).Scan(&postingID); err != nil {
		t.Fatalf("inserting job_posting: %v", err)
	}

	var versionID string
	if err := admin.QueryRow(ctx,
		`INSERT INTO job_posting_version (job_posting_id, content_fingerprint, title, description_text, salary_max)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		postingID, "fp-"+opts.sourceJobID, opts.title, opts.description, opts.salaryMax,
	).Scan(&versionID); err != nil {
		t.Fatalf("inserting job_posting_version: %v", err)
	}

	if _, err := admin.Exec(ctx,
		`UPDATE job_posting SET current_version_id = $2 WHERE id = $1`,
		postingID, versionID,
	); err != nil {
		t.Fatalf("setting current_version_id: %v", err)
	}

	if _, err := admin.Exec(ctx,
		`INSERT INTO job_posting_location (job_posting_id, raw, city, work_mode)
		 VALUES ($1, $2, $2, $3)`,
		postingID, opts.city, opts.workMode,
	); err != nil {
		t.Fatalf("inserting job_posting_location: %v", err)
	}

	return seededPosting{jobPostingID: postingID, jobPostingVersionID: versionID}
}

func cleanFixtures(t *testing.T, ctx context.Context, admin *pgxpool.Pool) {
	t.Helper()
	for _, table := range []string{
		"job_match", "job_application", "profile_skill", "candidate_profile",
		"job_posting_location", "job_posting_version", "job_posting",
		"career_source", "company", "account_member", "app_user", "account",
	} {
		if _, err := admin.Exec(ctx, "DELETE FROM "+table); err != nil {
			t.Fatalf("cleaning %s: %v", table, err)
		}
	}
}

func TestRunForAccountMatchesOnLocationAndSkills(t *testing.T) {
	admin, matcherPool := setupPools(t)
	ctx := context.Background()
	cleanFixtures(t, ctx, admin)
	t.Cleanup(func() { cleanFixtures(t, ctx, admin) })

	currentTitle := "Senior Software Engineer"
	accountA := seedAccount(t, ctx, admin, struct {
		currentTitle     *string
		desiredLocations []string
		desiredWorkMode  *string
		desiredSalaryMin *int
		skills           []string
	}{
		currentTitle:     &currentTitle,
		desiredLocations: []string{"Bengaluru"},
		skills:           []string{"React", "TypeScript"},
	})

	now := time.Now()
	bengaluruFresh := seedPosting(t, ctx, admin, struct {
		title       string
		description string
		city        string
		workMode    string
		salaryMax   *float64
		closed      bool
		firstSeenAt time.Time
		lastSeenAt  time.Time
		sourceJobID string
	}{
		title:       "Senior Frontend Engineer",
		description: "Build products using React and TypeScript.",
		city:        "Bengaluru", workMode: "onsite",
		firstSeenAt: now.Add(-1 * 24 * time.Hour), lastSeenAt: now,
		sourceJobID: "posting-1",
	})

	_ = seedPosting(t, ctx, admin, struct { // wrong city - must NOT match account A
		title       string
		description string
		city        string
		workMode    string
		salaryMax   *float64
		closed      bool
		firstSeenAt time.Time
		lastSeenAt  time.Time
		sourceJobID string
	}{
		title: "Python Developer", description: "Python and Django.",
		city: "Mumbai", workMode: "onsite",
		firstSeenAt: now.Add(-1 * 24 * time.Hour), lastSeenAt: now,
		sourceJobID: "posting-2",
	})

	_ = seedPosting(t, ctx, admin, struct { // closed - must NOT match
		title       string
		description string
		city        string
		workMode    string
		salaryMax   *float64
		closed      bool
		firstSeenAt time.Time
		lastSeenAt  time.Time
		sourceJobID string
	}{
		title: "Senior Frontend Engineer (Closed)", description: "React role, but closed.",
		city: "Bengaluru", workMode: "onsite", closed: true,
		firstSeenAt: now.Add(-10 * 24 * time.Hour), lastSeenAt: now,
		sourceJobID: "posting-3",
	})

	_ = seedPosting(t, ctx, admin, struct { // stale (>30 days unseen) - must NOT match
		title       string
		description string
		city        string
		workMode    string
		salaryMax   *float64
		closed      bool
		firstSeenAt time.Time
		lastSeenAt  time.Time
		sourceJobID string
	}{
		title: "Senior Frontend Engineer (Stale)", description: "React role, but stale.",
		city: "Bengaluru", workMode: "onsite",
		firstSeenAt: now.Add(-90 * 24 * time.Hour), lastSeenAt: now.Add(-40 * 24 * time.Hour),
		sourceJobID: "posting-4",
	})

	result, err := RunForAccount(ctx, matcherPool, accountA.accountID)
	if err != nil {
		t.Fatalf("RunForAccount: %v", err)
	}
	if result.MatchesWritten != 1 {
		t.Fatalf("MatchesWritten = %d, want 1 (only the fresh, open, right-city, closed postings excluded)", result.MatchesWritten)
	}

	rows, err := admin.Query(ctx, `SELECT job_posting_id, score, skill_score, seniority_score FROM job_match WHERE account_id = $1`, accountA.accountID)
	if err != nil {
		t.Fatalf("querying job_match: %v", err)
	}
	defer rows.Close()

	var found bool
	for rows.Next() {
		var postingID string
		var score, skillScore, seniorityScore float64
		if err := rows.Scan(&postingID, &score, &skillScore, &seniorityScore); err != nil {
			t.Fatalf("scanning job_match row: %v", err)
		}
		if postingID != bengaluruFresh.jobPostingID {
			t.Errorf("unexpected job_match row for posting %s (want only %s)", postingID, bengaluruFresh.jobPostingID)
		}
		if score <= 0 || score > 1 {
			t.Errorf("score = %v, want in (0, 1]", score)
		}
		if skillScore != 1.0 {
			t.Errorf("skillScore = %v, want 1.0 (both React and TypeScript are in the description)", skillScore)
		}
		found = true
	}
	if !found {
		t.Fatal("expected a job_match row for the matching posting, found none")
	}
}

// TestRunForAccountCrossTenantIsolation is the must-have test the plan
// calls out explicitly: seed two accounts with different profiles, run a
// full matching pass for each, and assert zero cross-account writes. The
// matcher pool holds BYPASSRLS, so this property is entirely a function of
// every query in internal/repo correctly filtering by account_id - there
// is no database-level backstop here the way there is for app_web.
func TestRunForAccountCrossTenantIsolation(t *testing.T) {
	admin, matcherPool := setupPools(t)
	ctx := context.Background()
	cleanFixtures(t, ctx, admin)
	t.Cleanup(func() { cleanFixtures(t, ctx, admin) })

	accountA := seedAccount(t, ctx, admin, struct {
		currentTitle     *string
		desiredLocations []string
		desiredWorkMode  *string
		desiredSalaryMin *int
		skills           []string
	}{desiredLocations: []string{"Bengaluru"}, skills: []string{"React"}})

	accountB := seedAccount(t, ctx, admin, struct {
		currentTitle     *string
		desiredLocations []string
		desiredWorkMode  *string
		desiredSalaryMin *int
		skills           []string
	}{desiredLocations: []string{"Mumbai"}, skills: []string{"Python"}})

	now := time.Now()
	postingA := seedPosting(t, ctx, admin, struct {
		title       string
		description string
		city        string
		workMode    string
		salaryMax   *float64
		closed      bool
		firstSeenAt time.Time
		lastSeenAt  time.Time
		sourceJobID string
	}{
		title: "React Engineer", description: "React role in Bengaluru.",
		city: "Bengaluru", workMode: "onsite",
		firstSeenAt: now, lastSeenAt: now, sourceJobID: "iso-a",
	})
	postingB := seedPosting(t, ctx, admin, struct {
		title       string
		description string
		city        string
		workMode    string
		salaryMax   *float64
		closed      bool
		firstSeenAt time.Time
		lastSeenAt  time.Time
		sourceJobID string
	}{
		title: "Python Engineer", description: "Python role in Mumbai.",
		city: "Mumbai", workMode: "onsite",
		firstSeenAt: now, lastSeenAt: now, sourceJobID: "iso-b",
	})

	if _, err := RunForAccount(ctx, matcherPool, accountA.accountID); err != nil {
		t.Fatalf("RunForAccount(A): %v", err)
	}
	if _, err := RunForAccount(ctx, matcherPool, accountB.accountID); err != nil {
		t.Fatalf("RunForAccount(B): %v", err)
	}

	// Zero cross-account writes: A's posting must never appear under B's
	// account_id, and vice versa.
	var leaked int
	if err := admin.QueryRow(ctx,
		`SELECT count(*) FROM job_match
		 WHERE (account_id = $1 AND job_posting_id = $3)
		    OR (account_id = $2 AND job_posting_id = $4)`,
		accountA.accountID, accountB.accountID, postingB.jobPostingID, postingA.jobPostingID,
	).Scan(&leaked); err != nil {
		t.Fatalf("checking for cross-tenant leakage: %v", err)
	}
	if leaked != 0 {
		t.Fatalf("cross-tenant leakage: found %d job_match row(s) attributing one account's match to the other", leaked)
	}

	// And the positive case: each account got exactly its own match.
	var aCount, bCount int
	admin.QueryRow(ctx, `SELECT count(*) FROM job_match WHERE account_id = $1 AND job_posting_id = $2`,
		accountA.accountID, postingA.jobPostingID).Scan(&aCount)
	admin.QueryRow(ctx, `SELECT count(*) FROM job_match WHERE account_id = $1 AND job_posting_id = $2`,
		accountB.accountID, postingB.jobPostingID).Scan(&bCount)
	if aCount != 1 {
		t.Errorf("account A's own match count = %d, want 1", aCount)
	}
	if bCount != 1 {
		t.Errorf("account B's own match count = %d, want 1", bCount)
	}
}

func TestRunForAccountWithNoCandidateProfileYet(t *testing.T) {
	admin, matcherPool := setupPools(t)
	ctx := context.Background()
	cleanFixtures(t, ctx, admin)
	t.Cleanup(func() { cleanFixtures(t, ctx, admin) })

	var accountID string
	if err := admin.QueryRow(ctx, `INSERT INTO account (type) VALUES ('personal') RETURNING id`).Scan(&accountID); err != nil {
		t.Fatalf("inserting account: %v", err)
	}
	// Deliberately no candidate_profile row - a freshly signed-up account.

	result, err := RunForAccount(ctx, matcherPool, accountID)
	if err != nil {
		t.Fatalf("RunForAccount for a profile-less account should not error: %v", err)
	}
	// No hard constraints at all means every open, fresh posting in the
	// index is a candidate - this just proves the pipeline doesn't crash
	// on a nil profile, not any particular count.
	_ = result
}
