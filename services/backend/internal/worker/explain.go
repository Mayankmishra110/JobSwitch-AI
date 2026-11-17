package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/clients"
	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/repo"
)

type explainMatchPayload struct {
	AccountID           string `json:"accountId"`
	JobPostingVersionID string `json:"jobPostingVersionId"`
}

// HandleExplainMatch calls services/ai's real /v1/match/explain and
// persists the result. Payload carries only the two ids, never job text
// or candidate facts by value (D-26's load-bearing payload rule) - both
// are re-fetched fresh at claim time from the Matcher pool, the same
// pattern HandleEmbedProfile already uses for the same reason.
func HandleExplainMatch(matcherPool *pgxpool.Pool, ai *clients.AIClient) func(context.Context, json.RawMessage) error {
	return func(ctx context.Context, rawPayload json.RawMessage) error {
		var payload explainMatchPayload
		if err := json.Unmarshal(rawPayload, &payload); err != nil {
			return fmt.Errorf("unmarshaling explain.match payload: %w", err)
		}
		if payload.AccountID == "" || payload.JobPostingVersionID == "" {
			return fmt.Errorf("explain.match payload missing accountId or jobPostingVersionId")
		}

		cached, err := repo.HasMatchExplanation(ctx, matcherPool, payload.AccountID, payload.JobPostingVersionID)
		if err != nil {
			return err
		}
		if cached {
			// D-09: keyed on the version, which is immutable once written -
			// an existing row means nothing has changed since it was
			// generated, so there is nothing new to explain.
			return nil
		}

		jobCtx, err := repo.GetJobExplanationContext(ctx, matcherPool, payload.JobPostingVersionID)
		if err != nil {
			return err
		}

		facts, err := repo.LoadCandidateFacts(ctx, matcherPool, payload.AccountID)
		if err != nil {
			return fmt.Errorf("loading facts for %s: %w", payload.AccountID, err)
		}

		description := ""
		if jobCtx.Description != nil {
			description = *jobCtx.Description
		}

		result, err := ai.Explain(ctx,
			clients.JobContext{Title: jobCtx.Title, Company: jobCtx.Company, Description: description},
			explanationFacts(facts),
		)
		if err != nil {
			return fmt.Errorf("explaining match %s/%s: %w", payload.AccountID, payload.JobPostingVersionID, err)
		}

		return repo.WriteMatchExplanation(
			ctx, matcherPool, payload.AccountID, payload.JobPostingVersionID,
			result.Summary, result.Evidence, result.Model, result.PromptVersion,
		)
	}
}

// explanationFacts turns one account's CandidateFacts into the
// provenance-tagged list /v1/match/explain requires - D-22 made
// structural: every fact sent carries the provenance it was actually
// recorded with (candidate_profile/profile_skill's own columns), never a
// hardcoded guess. desired_titles/desired_locations/desired_work_mode/
// desired_salary_* have no per-row provenance column because they are
// always 'preference' by definition (see packages/db/migrations/0009's
// COMMENT ON COLUMN) - hardcoding that one value is not a guess, it is
// the schema's own documented invariant.
func explanationFacts(facts repo.CandidateFacts) []clients.Fact {
	var out []clients.Fact

	if facts.CurrentTitle != nil && *facts.CurrentTitle != "" {
		out = append(out, clients.Fact{
			Ref: "current_title", Text: *facts.CurrentTitle, Provenance: facts.CurrentTitleProvenance,
		})
	}
	if facts.YearsExperience != nil {
		out = append(out, clients.Fact{
			Ref:        "years_experience",
			Text:       fmt.Sprintf("%d years of experience", *facts.YearsExperience),
			Provenance: facts.YearsExperienceProvenance,
		})
	}
	if len(facts.DesiredTitles) > 0 {
		out = append(out, clients.Fact{
			Ref: "desired_titles", Text: strings.Join(facts.DesiredTitles, ", "), Provenance: "preference",
		})
	}
	for _, s := range facts.SkillDetails {
		out = append(out, clients.Fact{
			Ref: "skill:" + s.Skill, Text: s.Skill, Provenance: s.Provenance,
		})
	}

	return out
}
