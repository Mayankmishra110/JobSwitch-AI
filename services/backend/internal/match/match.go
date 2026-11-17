// Package match orchestrates the D-21 pipeline for one account:
// hard constraints -> hybrid retrieval -> structured ranking -> persisted
// job_match rows.
package match

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/events"
	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/queue"
	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/rank"
	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/repo"
)

// explainTopN caps how many of one run's matches get an LLM explanation
// queued - Stage 4 of the pipeline (specs/matching-pipeline.md). An LLM
// call per candidate/posting pair is real money; a posting ranked 200th
// in a single account's run is unlikely to be surfaced prominently enough
// to be worth explaining.
const explainTopN = 20

// MatcherVersion is bumped whenever the ranking formula changes, so every
// job_match row from before the change is recognizably stale without a
// data migration (job_match.matcher_version - see migration 0011's
// comment). Phase 5.2 was the structured-only baseline: version 1. Version
// 2 (Phase 5.3) is this same formula with Vector/Keyword now real
// (repo.HybridRetrieve) instead of hardcoded 0 under DefaultWeights'
// nonzero weight for them - a materially different score for the same
// candidate/posting pair, so every version-1 row is correctly stale.
const MatcherVersion = 2

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
//
// publisher may be nil - D-26's match.computed event is genuinely optional
// here (a nil publisher just skips it, see events.Publisher's own doc
// comment), so every existing test that predates the event bus, and never
// cared about it, keeps passing without needing a running NATS server.
func RunForAccount(ctx context.Context, matcherPool *pgxpool.Pool, accountID string, publisher *events.Publisher) (RunResult, error) {
	facts, err := repo.LoadCandidateFacts(ctx, matcherPool, accountID)
	if err != nil {
		return RunResult{}, fmt.Errorf("loading facts for %s: %w", accountID, err)
	}

	candidates, err := repo.PrefilterCandidates(ctx, matcherPool, accountID, facts)
	if err != nil {
		return RunResult{}, fmt.Errorf("prefiltering for %s: %w", accountID, err)
	}

	embeddings, err := repo.LoadCandidateEmbeddings(ctx, matcherPool, accountID)
	if err != nil {
		return RunResult{}, fmt.Errorf("loading candidate embeddings for %s: %w", accountID, err)
	}

	candidateIDs := make([]string, len(candidates))
	for i, c := range candidates {
		candidateIDs[i] = c.JobPostingID
	}

	retrieval, err := repo.HybridRetrieve(ctx, matcherPool, candidateIDs, facts, embeddings)
	if err != nil {
		return RunResult{}, fmt.Errorf("hybrid retrieval for %s: %w", accountID, err)
	}

	candidateLevel := CandidateLevel(facts.CurrentTitle, facts.DesiredTitles)
	hasLocationConstraint := HasLocationConstraint(facts)
	now := time.Now()

	writes := make([]repo.MatchWrite, 0, len(candidates))
	for _, c := range candidates {
		r := retrieval[c.JobPostingID]
		signals := rank.Signals{
			Vector:       r.Vector,
			Keyword:      r.Keyword,
			SkillOverlap: SkillOverlapScore(facts.Skills, c.DescriptionText),
			Seniority:    SeniorityScore(candidateLevel, c.Seniority),
			Location:     LocationScore(hasLocationConstraint),
			Freshness:    FreshnessScore(c.FirstSeenAt, now),
			Comp:         CompScore(facts.DesiredSalaryMin, c.SalaryMax),
		}

		total, breakdown := rank.Score(signals, rank.DefaultWeights())

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

	if err := enqueueTopExplanations(ctx, matcherPool, writes); err != nil {
		// The job_match rows above are already committed and correct even
		// if this fails - returning an error here only means the caller
		// (internal/worker/schedule.go's runMatchingTick) logs this run as
		// failed and tries the whole account again next tick, which is a
		// safe, idempotent retry: UpsertMatches upserts, and Enqueue's own
		// dedup key means a second attempt at explanations is a no-op for
		// whichever ones already went out.
		return RunResult{}, fmt.Errorf("enqueueing explanations for %s: %w", accountID, err)
	}

	// D-26's match.computed - after UpsertMatches commits, per the event
	// catalog. Best-effort and never fatal to the run: the job_match rows
	// are already correct and persisted; a bus hiccup should cost the
	// candidate a live UI refresh, not the match computation itself.
	if err := publisher.Publish(accountID, events.MatchComputed, events.MatchComputedPayload{
		AccountID:      accountID,
		MatchesWritten: len(writes),
	}); err != nil {
		// slog.Default() rather than a logger threaded through this
		// function's signature - cmd/worker's main.go already installs
		// the process-wide JSON logger via slog.SetDefault, so this reaches
		// the same structured output every other log line in this binary
		// does, without RunForAccount needing its own logger parameter for
		// what is a single best-effort log line.
		slog.Default().Error("publishing match.computed failed", "accountId", accountID, "err", err)
	}

	return RunResult{
		AccountID:            accountID,
		CandidatesConsidered: len(candidates),
		MatchesWritten:       len(writes),
	}, nil
}

type explainMatchPayload struct {
	AccountID           string `json:"accountId"`
	JobPostingVersionID string `json:"jobPostingVersionId"`
}

// enqueueTopExplanations queues Stage 4 for the explainTopN highest-scoring
// matches from this run. Dedup-keyed on (account, version) - the same pair
// match_explanation is cached by (D-09) - so a version already explained,
// or already queued and still pending, is a safe no-op rather than a
// second LLM call.
func enqueueTopExplanations(ctx context.Context, matcherPool *pgxpool.Pool, writes []repo.MatchWrite) error {
	sorted := make([]repo.MatchWrite, len(writes))
	copy(sorted, writes)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Score > sorted[j].Score })

	n := explainTopN
	if n > len(sorted) {
		n = len(sorted)
	}

	for _, w := range sorted[:n] {
		dedupKey := fmt.Sprintf("%s:%s:%s", repo.ExplainMatchQueue, w.AccountID, w.JobPostingVersionID)
		if _, err := queue.Enqueue(ctx, matcherPool, queue.EnqueueParams{
			Queue: repo.ExplainMatchQueue,
			Payload: explainMatchPayload{
				AccountID:           w.AccountID,
				JobPostingVersionID: w.JobPostingVersionID,
			},
			DedupKey: &dedupKey,
		}); err != nil {
			return fmt.Errorf("enqueueing explain.match for %s/%s: %w", w.AccountID, w.JobPostingVersionID, err)
		}
	}
	return nil
}
