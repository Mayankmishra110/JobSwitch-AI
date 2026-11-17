package match

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"

	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/events"
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

func natsTestURL() string {
	if v := os.Getenv("NATS_URL_TEST"); v != "" {
		return v
	}
	return "nats://127.0.0.1:4222"
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
		"job_match", "job_application", "profile_embedding", "profile_skill",
		"candidate_profile", "job_posting_location", "job_posting_version",
		"job_posting", "career_source", "company", "account_member",
		"app_user", "account",
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

	result, err := RunForAccount(ctx, matcherPool, accountA.accountID, nil)
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

	if _, err := RunForAccount(ctx, matcherPool, accountA.accountID, nil); err != nil {
		t.Fatalf("RunForAccount(A): %v", err)
	}
	if _, err := RunForAccount(ctx, matcherPool, accountB.accountID, nil); err != nil {
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

// unitAxisVector builds a pgvector text literal (384 dims, matching
// migration 0010) that is 1.0 at one index and 0 elsewhere. Cosine
// distance depends only on direction, not magnitude, so two of these at
// different indices are exactly orthogonal (distance 1) and two at the
// same index are identical (distance 0) - deterministic, human-checkable
// fixtures with no dependency on a real embedding model.
func unitAxisVector(hotIndex int) string {
	parts := make([]string, 384)
	for i := range parts {
		if i == hotIndex {
			parts[i] = "1"
		} else {
			parts[i] = "0"
		}
	}
	var b strings.Builder
	b.WriteByte('[')
	for i, p := range parts {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(p)
	}
	b.WriteByte(']')
	return b.String()
}

// TestRunForAccountUsesHybridRetrieval is Stage 2's own proof, no fakes:
// a real profile_embedding row, real job_posting_version.embedding values,
// and a real ts_rank_cd/pgvector round trip through the same Postgres the
// rest of this suite uses. Before this test existed, vector_score and
// keyword_score were hardcoded 0 for every candidate (see
// specs/matching-pipeline.md's former known-gaps entry) - this asserts
// they are now real, and that the closer posting outranks the farther one.
func TestRunForAccountUsesHybridRetrieval(t *testing.T) {
	admin, matcherPool := setupPools(t)
	ctx := context.Background()
	cleanFixtures(t, ctx, admin)
	t.Cleanup(func() { cleanFixtures(t, ctx, admin) })

	account := seedAccount(t, ctx, admin, struct {
		currentTitle     *string
		desiredLocations []string
		desiredWorkMode  *string
		desiredSalaryMin *int
		skills           []string
	}{desiredLocations: []string{}, skills: []string{"Kubernetes"}})

	if _, err := admin.Exec(ctx,
		`INSERT INTO profile_embedding (account_id, kind, embedding, source_hash, embedding_model)
		 VALUES ($1, 'resume', $2::vector, 'test-hash', 'test-model')`,
		account.accountID, unitAxisVector(0),
	); err != nil {
		t.Fatalf("seeding profile_embedding: %v", err)
	}

	now := time.Now()
	near := seedPosting(t, ctx, admin, struct {
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
		title:       "Platform Engineer",
		description: "Kubernetes Kubernetes Kubernetes: deep cluster operations and platform ownership.",
		city:        "Bengaluru", workMode: "remote",
		firstSeenAt: now, lastSeenAt: now, sourceJobID: "hybrid-near",
	})
	// Both postings must mention the candidate's only skill ("Kubernetes")
	// at least once, or Stage 1's own keyword floor (repo.PrefilterCandidates)
	// would exclude "far" before Stage 2 ever runs it - the point of this
	// fixture is a Stage 2 ranking difference, not a Stage 1 exclusion.
	far := seedPosting(t, ctx, admin, struct {
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
		title: "Sales Development Representative",
		description: "Outbound prospecting and pipeline generation for enterprise accounts, " +
			"occasionally touching a Kubernetes-based internal tool maintained by another team.",
		city: "Bengaluru", workMode: "remote",
		firstSeenAt: now, lastSeenAt: now, sourceJobID: "hybrid-far",
	})

	if _, err := admin.Exec(ctx,
		`UPDATE job_posting_version SET embedding = $1::vector, embedding_model = 'test-model', embedded_at = now()
		 WHERE job_posting_id = $2`,
		unitAxisVector(0), near.jobPostingID,
	); err != nil {
		t.Fatalf("seeding near posting's embedding: %v", err)
	}
	if _, err := admin.Exec(ctx,
		`UPDATE job_posting_version SET embedding = $1::vector, embedding_model = 'test-model', embedded_at = now()
		 WHERE job_posting_id = $2`,
		unitAxisVector(1), far.jobPostingID,
	); err != nil {
		t.Fatalf("seeding far posting's embedding: %v", err)
	}

	if _, err := RunForAccount(ctx, matcherPool, account.accountID, nil); err != nil {
		t.Fatalf("RunForAccount: %v", err)
	}

	scores := map[string]struct{ vector, keyword float64 }{}
	rows, err := admin.Query(ctx,
		`SELECT job_posting_id, vector_score, keyword_score FROM job_match WHERE account_id = $1`,
		account.accountID,
	)
	if err != nil {
		t.Fatalf("querying job_match: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var postingID string
		var vectorScore, keywordScore float64
		if err := rows.Scan(&postingID, &vectorScore, &keywordScore); err != nil {
			t.Fatalf("scanning job_match row: %v", err)
		}
		scores[postingID] = struct{ vector, keyword float64 }{vectorScore, keywordScore}
	}

	nearScores, ok := scores[near.jobPostingID]
	if !ok {
		t.Fatal("expected a job_match row for the near posting")
	}
	farScores, ok := scores[far.jobPostingID]
	if !ok {
		t.Fatal("expected a job_match row for the far posting")
	}

	// The near posting's embedding is identical to the candidate's resume
	// vector (cosine distance 0, rank 1); the far one is orthogonal
	// (distance 1, rank 2). RRF must rank the near one strictly higher on
	// this one-ranker fixture (no desired_role vector was seeded).
	if nearScores.vector <= farScores.vector {
		t.Errorf("near.vector = %v, far.vector = %v; want near strictly higher", nearScores.vector, farScores.vector)
	}
	if nearScores.vector != 1.0 {
		t.Errorf("near.vector = %v, want 1.0 (rank 1 of 1 active ranker)", nearScores.vector)
	}
	if nearScores.vector == 0.5 || farScores.vector == 0.5 {
		t.Error("a seeded embedding must never fall back to the neutral 0.5 default")
	}

	// Only the near posting's description mentions the candidate's skill.
	if nearScores.keyword <= farScores.keyword {
		t.Errorf("near.keyword = %v, far.keyword = %v; want near strictly higher", nearScores.keyword, farScores.keyword)
	}
}

// TestRunForAccountEnqueuesExplainMatchCappedAtTop20 is Stage 4's own
// enqueue proof: a run with more matches than explainTopN must queue
// exactly explainTopN explain.match jobs, never one per candidate - an
// LLM call per match would be real, uncapped cost for an account with a
// large open feed.
func TestRunForAccountEnqueuesExplainMatchCappedAtTop20(t *testing.T) {
	admin, matcherPool := setupPools(t)
	ctx := context.Background()
	cleanFixtures(t, ctx, admin)
	t.Cleanup(func() { cleanFixtures(t, ctx, admin) })
	admin.Exec(ctx, "DELETE FROM job_queue WHERE queue = 'explain.match'") //nolint:errcheck

	account := seedAccount(t, ctx, admin, struct {
		currentTitle     *string
		desiredLocations []string
		desiredWorkMode  *string
		desiredSalaryMin *int
		skills           []string
	}{desiredLocations: []string{}, skills: []string{"Go"}})

	now := time.Now()
	const postingCount = 25
	for i := 0; i < postingCount; i++ {
		seedPosting(t, ctx, admin, struct {
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
			title: "Go Engineer", description: "Build backend services in Go.",
			city: "Bengaluru", workMode: "remote",
			firstSeenAt: now, lastSeenAt: now,
			sourceJobID: "explain-cap-" + strconv.Itoa(i),
		})
	}

	result, err := RunForAccount(ctx, matcherPool, account.accountID, nil)
	if err != nil {
		t.Fatalf("RunForAccount: %v", err)
	}
	if result.MatchesWritten != postingCount {
		t.Fatalf("MatchesWritten = %d, want %d", result.MatchesWritten, postingCount)
	}

	rows, err := admin.Query(ctx,
		`SELECT count(*)::int FROM job_queue WHERE queue = 'explain.match' AND payload ->> 'accountId' = $1`,
		account.accountID,
	)
	if err != nil {
		t.Fatalf("counting explain.match jobs: %v", err)
	}
	defer rows.Close()
	var enqueued int
	if rows.Next() {
		if err := rows.Scan(&enqueued); err != nil {
			t.Fatalf("scanning count: %v", err)
		}
	}
	if enqueued != explainTopN {
		t.Errorf("enqueued %d explain.match jobs for %d matches, want exactly %d (explainTopN)", enqueued, postingCount, explainTopN)
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

	result, err := RunForAccount(ctx, matcherPool, accountID, nil)
	if err != nil {
		t.Fatalf("RunForAccount for a profile-less account should not error: %v", err)
	}
	// No hard constraints at all means every open, fresh posting in the
	// index is a candidate - this just proves the pipeline doesn't crash
	// on a nil profile, not any particular count.
	_ = result
}

// TestRunForAccountPublishesMatchComputed proves D-26's event actually
// reaches a real NATS server end to end - a raw nats.Conn subscriber here
// plays the SSE bridge's role (apps/web/src/routes/events.ts subscribes to
// the exact same account.<id>.> wildcard), against the same docker-compose
// nats service the rest of this project already runs tests against. No
// mock: a publish that silently failed to reach the wire is exactly the
// kind of bug a fake Publisher would hide.
func TestRunForAccountPublishesMatchComputed(t *testing.T) {
	admin, matcherPool := setupPools(t)
	ctx := context.Background()
	cleanFixtures(t, ctx, admin)
	t.Cleanup(func() { cleanFixtures(t, ctx, admin) })

	nc, err := nats.Connect(natsTestURL())
	if err != nil {
		t.Skipf("no NATS reachable at %s, skipping: %v", natsTestURL(), err)
	}
	defer nc.Close()
	publisher, err := events.Connect(natsTestURL())
	if err != nil {
		t.Fatalf("events.Connect: %v", err)
	}
	defer publisher.Close()

	account := seedAccount(t, ctx, admin, struct {
		currentTitle     *string
		desiredLocations []string
		desiredWorkMode  *string
		desiredSalaryMin *int
		skills           []string
	}{desiredLocations: []string{}, skills: []string{"Go"}})

	now := time.Now()
	seedPosting(t, ctx, admin, struct {
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
		title: "Go Engineer", description: "Build backend services in Go.",
		city: "Bengaluru", workMode: "remote",
		firstSeenAt: now, lastSeenAt: now,
		sourceJobID: "match-computed-event",
	})

	sub, err := nc.SubscribeSync(events.AccountSubject(account.accountID, ">"))
	if err != nil {
		t.Fatalf("subscribing: %v", err)
	}
	defer sub.Unsubscribe() //nolint:errcheck

	result, err := RunForAccount(ctx, matcherPool, account.accountID, publisher)
	if err != nil {
		t.Fatalf("RunForAccount: %v", err)
	}

	msg, err := sub.NextMsg(5 * time.Second)
	if err != nil {
		t.Fatalf("waiting for match.computed on the real bus: %v", err)
	}
	wantSubject := events.AccountSubject(account.accountID, events.MatchComputed)
	if msg.Subject != wantSubject {
		t.Fatalf("subject = %q, want %q", msg.Subject, wantSubject)
	}

	var payload events.MatchComputedPayload
	if err := json.Unmarshal(msg.Data, &payload); err != nil {
		t.Fatalf("unmarshaling payload: %v", err)
	}
	if payload.AccountID != account.accountID {
		t.Errorf("payload.AccountID = %q, want %q", payload.AccountID, account.accountID)
	}
	if payload.MatchesWritten != result.MatchesWritten {
		t.Errorf("payload.MatchesWritten = %d, want %d", payload.MatchesWritten, result.MatchesWritten)
	}
}
