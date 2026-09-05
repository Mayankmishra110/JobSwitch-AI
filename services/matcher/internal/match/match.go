// Package match orchestrates the D-21 pipeline for one account:
// hard constraints -> (Phase 5.3: retrieval) -> structured ranking ->
// persisted job_match rows.
package match

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mayankmishra110/jobswitch-ai/services/matcher/internal/rank"
	"github.com/mayankmishra110/jobswitch-ai/services/matcher/internal/repo"
)

// MatcherVersion is bumped whenever the ranking formula changes, so every
// job_match row from before the change is recognizably stale without a
// data migration (job_match.matcher_version - see migration 0011's
// comment). Phase 5.2 is the structured-only baseline: version 1.
const MatcherVersion = 1

// structuredOnlyWeights excludes Vector and Keyword entirely (weight 0) -
// Phase 5.2 has no embedding retrieval yet, and every Signals value this
// package builds carries them as 0. Passing DefaultWeights() here would
// silently under-score every candidate by 40% of the total weight for a
// dimension that was never evaluated - the same mistake
// internal/rank's own tests exist to catch. Phase 5.3 swaps this for
// DefaultWeights() once Vector/Keyword are real.
var structuredOnlyWeights = rank.Weights{
	Skill: 0.45, Seniority: 0.25, Location: 0.15, Comp: 0.05, Freshness: 0.10,
}

// RunResult summarizes one account's matching pass.
type RunResult struct {
	AccountID            string
	CandidatesConsidered int
	MatchesWritten       int
}

// RunForAccount executes the full pipeline for one account and persists
// the result. Read side uses the Matcher pool (BYPASSRLS) with an explicit
// account_id filter at every step - repo's own discipline, see its doc
// comment - never the Web pool, and never without that filter.
func RunForAccount(ctx context.Context, matcherPool *pgxpool.Pool, accountID string) (RunResult, error) {
	facts, err := repo.LoadCandidateFacts(ctx, matcherPool, accountID)
	if err != nil {
		return RunResult{}, fmt.Errorf("loading facts for %s: %w", accountID, err)
	}

	candidates, err := repo.PrefilterCandidates(ctx, matcherPool, accountID, facts)
	if err != nil {
		return RunResult{}, fmt.Errorf("prefiltering for %s: %w", accountID, err)
	}

	candidateLevel := CandidateLevel(facts.CurrentTitle, facts.DesiredTitles)
	hasLocationConstraint := HasLocationConstraint(facts)
	now := time.Now()

	writes := make([]repo.MatchWrite, 0, len(candidates))
	for _, c := range candidates {
		signals := rank.Signals{
			Vector:       0, // Phase 5.3
			Keyword:      0, // Phase 5.3
			SkillOverlap: SkillOverlapScore(facts.Skills, c.DescriptionText),
			Seniority:    SeniorityScore(candidateLevel, c.Seniority),
			Location:     LocationScore(hasLocationConstraint),
			Freshness:    FreshnessScore(c.FirstSeenAt, now),
			Comp:         CompScore(facts.DesiredSalaryMin, c.SalaryMax),
		}

		total, breakdown := rank.Score(signals, structuredOnlyWeights)

		writes = append(writes, repo.MatchWrite{
			AccountID:           accountID,
			JobPostingID:        c.JobPostingID,
			JobPostingVersionID: c.JobPostingVersionID,
			Score:               total,
			VectorScore:         breakdown["vector"],
			KeywordScore:        breakdown["keyword"],
			SkillScore:          breakdown["skill"],
			SeniorityScore:      breakdown["seniority"],
			LocationScore:       breakdown["location"],
			CompScore:           signals.Comp,
			FreshnessScore:      breakdown["freshness"],
			MatcherVersion:      MatcherVersion,
		})
	}

	if err := repo.UpsertMatches(ctx, matcherPool, writes); err != nil {
		return RunResult{}, fmt.Errorf("persisting matches for %s: %w", accountID, err)
	}

	return RunResult{
		AccountID:            accountID,
		CandidatesConsidered: len(candidates),
		MatchesWritten:       len(writes),
	}, nil
}
