package repo

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CandidatePosting is one open posting that survived the Stage 1 hard-
// constraint prefilter (ADR: the matching pipeline design) - the input to
// Stage 3's structured-only ranking in internal/match.
type CandidatePosting struct {
	JobPostingID        string
	JobPostingVersionID string
	CanonicalTitle      string
	Seniority           *string
	FirstSeenAt         time.Time
	DescriptionText     *string
	SalaryMin           *float64
	SalaryMax           *float64
}

// PrefilterCandidates runs Stage 1: a single CTE applying every hard
// constraint before anything expensive runs. No embeddings, no LLM, no
// per-row round trip - one query, cheap, on the full open index.
//
// Constraints applied, in the order the plan specifies:
//   - closed_at IS NULL, last_seen_at within 30 days (a stale posting is
//     not worth ranking even if technically still "open").
//   - Location/work-mode: skipped entirely when the candidate gave neither
//     a desired location nor a specific (non-"any") work mode - there is
//     nothing to constrain against. Otherwise a posting must either match
//     a desired city or be remote while the candidate accepts remote/any.
//     Deliberately conservative: a candidate who names cities without
//     opting into remote is assumed to want those cities specifically, not
//     "those cities, or remote as a bonus" - a real product judgment call,
//     easy to revisit, not a technical constraint.
//   - Comp floor: NULL posting salary is "unknown," never a failure - most
//     rows are NULL since only the Ashby adapter emits structured salary
//     (see packages/ingest). A NULL candidate floor means no constraint.
//   - Keyword floor: only applied when the candidate has desired titles or
//     skills to search for at all; skipped otherwise rather than matching
//     nothing.
//   - Dedup via job_group: only the group's representative posting is
//     considered a candidate - the same "one card per group" rule the
//     product already applies everywhere else (ADR D-03/D-04).
//   - Excludes anything already dismissed or already tracked as an
//     application for this account.
//
// LIMIT 2000 bounds worst-case memory/CPU for Stage 3's in-process ranking
// - the plan's own estimate is 200-2000 survivors from a 25k-posting index;
// this is a safety cap, not an expected steady-state truncation. Phase
// 5.3's embedding retrieval is what narrows this further and by relevance,
// not by an arbitrary cutoff.
func PrefilterCandidates(
	ctx context.Context,
	pool *pgxpool.Pool,
	accountID string,
	facts CandidateFacts,
) ([]CandidatePosting, error) {
	lowerLocations := make([]string, len(facts.DesiredLocations))
	for i, loc := range facts.DesiredLocations {
		lowerLocations[i] = strings.ToLower(loc)
	}

	var workMode *string
	if facts.DesiredWorkMode != nil {
		workMode = facts.DesiredWorkMode
	}

	var salaryFloor *int32
	if facts.DesiredSalaryMin != nil {
		salaryFloor = facts.DesiredSalaryMin
	}

	keywordQuery := buildKeywordFloor(facts)

	rows, err := pool.Query(ctx, `
		WITH prefiltered AS (
			SELECT p.id AS job_posting_id, p.current_version_id AS job_posting_version_id,
			       p.canonical_title, p.seniority, p.first_seen_at,
			       v.description_text, v.salary_min, v.salary_max
			FROM job_posting p
			JOIN job_posting_version v ON v.id = p.current_version_id
			WHERE p.closed_at IS NULL
			  AND p.last_seen_at > now() - interval '30 days'
			  AND (
			    (cardinality($2::text[]) = 0 AND ($3::text IS NULL OR $3::text = 'any'))
			    OR EXISTS (
			      SELECT 1 FROM job_posting_location l
			      WHERE l.job_posting_id = p.id
			        AND (
			          (cardinality($2::text[]) > 0 AND lower(l.city) = ANY($2::text[]))
			          OR (l.work_mode = 'remote' AND $3::text IN ('remote', 'any'))
			        )
			    )
			  )
			  AND (v.salary_max IS NULL OR $4::int IS NULL OR v.salary_max >= $4::int)
			  AND ($5::text IS NULL OR v.search_tsv @@ websearch_to_tsquery('english', $5::text))
			  AND NOT EXISTS (
			    SELECT 1 FROM job_group_link gl
			    JOIN job_group g ON g.id = gl.job_group_id
			    WHERE gl.job_posting_id = p.id
			      AND g.representative_posting_id IS DISTINCT FROM p.id
			  )
			  AND NOT EXISTS (
			    SELECT 1 FROM job_match m
			    WHERE m.account_id = $1 AND m.job_posting_id = p.id AND m.dismissed_at IS NOT NULL
			  )
			  AND NOT EXISTS (
			    SELECT 1 FROM job_application a
			    WHERE a.account_id = $1 AND a.job_posting_id = p.id
			  )
		)
		SELECT job_posting_id, job_posting_version_id, canonical_title, seniority,
		       first_seen_at, description_text, salary_min, salary_max
		FROM prefiltered
		LIMIT 2000`,
		accountID, lowerLocations, workMode, salaryFloor, keywordQuery,
	)
	if err != nil {
		return nil, fmt.Errorf("prefiltering candidates for %s: %w", accountID, err)
	}
	defer rows.Close()

	var out []CandidatePosting
	for rows.Next() {
		var c CandidatePosting
		var salaryMin, salaryMax *float64
		if err := rows.Scan(
			&c.JobPostingID, &c.JobPostingVersionID, &c.CanonicalTitle, &c.Seniority,
			&c.FirstSeenAt, &c.DescriptionText, &salaryMin, &salaryMax,
		); err != nil {
			return nil, fmt.Errorf("scanning candidate posting: %w", err)
		}
		c.SalaryMin, c.SalaryMax = salaryMin, salaryMax
		out = append(out, c)
	}
	return out, rows.Err()
}

// buildKeywordFloor turns desired titles + skills into one
// websearch_to_tsquery-compatible string ("term1 OR term2 OR ..."), or nil
// if the candidate has given nothing to search for - an empty floor means
// "don't filter," not "match nothing."
func buildKeywordFloor(facts CandidateFacts) *string {
	terms := make([]string, 0, len(facts.DesiredTitles)+len(facts.Skills))
	terms = append(terms, facts.DesiredTitles...)
	terms = append(terms, facts.Skills...)
	if len(terms) == 0 {
		return nil
	}
	q := strings.Join(terms, " OR ")
	return &q
}

// MatchWrite is one row's worth of Stage 3 output, ready to persist.
type MatchWrite struct {
	AccountID           string
	JobPostingID        string
	JobPostingVersionID string
	Score               float64
	VectorScore         float64
	KeywordScore        float64
	SkillScore          float64
	SeniorityScore      float64
	LocationScore       float64
	CompScore           *float64
	FreshnessScore      float64
	MatcherVersion      int
}

// UpsertMatches writes a batch of job_match rows, one per candidate posting
// that survived Stage 1 and was scored in Stage 3.
//
// ON CONFLICT (account_id, job_posting_id) DO UPDATE, never touching
// dismissed_at: a dismissed posting is already excluded by
// PrefilterCandidates's own NOT EXISTS clause, so this function is never
// even called for one - there is nothing here that could "undismiss" it,
// which is a property of the query shape, not a special case in this
// function.
//
// Pipelined via pgx.Batch rather than one round trip per row - correct
// enough at Phase 5.2's hundreds-to-low-thousands-of-rows scale. A single
// multi-row VALUES statement would cut this further; left as a documented
// option for when real batch-worker latency numbers justify it, rather
// than optimizing ahead of a measurement.
func UpsertMatches(ctx context.Context, pool *pgxpool.Pool, matches []MatchWrite) error {
	if len(matches) == 0 {
		return nil
	}

	batch := &pgx.Batch{}
	const stmt = `
		INSERT INTO job_match
		  (account_id, job_posting_id, job_posting_version_id, score, vector_score,
		   keyword_score, skill_score, seniority_score, location_score, comp_score,
		   freshness_score, matcher_version, ranked_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
		ON CONFLICT (account_id, job_posting_id) DO UPDATE SET
		  job_posting_version_id = EXCLUDED.job_posting_version_id,
		  score = EXCLUDED.score,
		  vector_score = EXCLUDED.vector_score,
		  keyword_score = EXCLUDED.keyword_score,
		  skill_score = EXCLUDED.skill_score,
		  seniority_score = EXCLUDED.seniority_score,
		  location_score = EXCLUDED.location_score,
		  comp_score = EXCLUDED.comp_score,
		  freshness_score = EXCLUDED.freshness_score,
		  matcher_version = EXCLUDED.matcher_version,
		  ranked_at = now()`

	for _, m := range matches {
		batch.Queue(stmt,
			m.AccountID, m.JobPostingID, m.JobPostingVersionID, m.Score, m.VectorScore,
			m.KeywordScore, m.SkillScore, m.SeniorityScore, m.LocationScore, m.CompScore,
			m.FreshnessScore, m.MatcherVersion,
		)
	}

	br := pool.SendBatch(ctx, batch)
	defer br.Close()

	for range matches {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("upserting job_match batch: %w", err)
		}
	}
	return nil
}
