package repo

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/clients"
)

// ExplainMatchQueue is Stage 4's job_queue name. Defined here rather than
// in internal/worker (where every other queue name lives) because this is
// the one queue both a Go producer (internal/match.RunForAccount, the top
// 20 matches per run) and a Go consumer (internal/worker.HandleExplainMatch)
// need to agree on - worker already imports match (schedule.go calls
// RunForAccount), so match importing worker back for this one constant
// would be a cycle. repo is the shared dependency both already have.
const ExplainMatchQueue = "explain.match"

// JobExplanationContext is what /v1/match/explain needs to know about the
// posting - title, company, and description. No new grant was needed:
// company already carries a SELECT grant to app_matcher from migration
// 0005 (Layer 1, shared), same as job_posting/job_posting_version.
type JobExplanationContext struct {
	Title       string
	Company     *string
	Description *string
}

// GetJobExplanationContext joins job_posting_version -> job_posting ->
// company - the one place in this package that reaches past Layer 1's
// two usual tables, because a match explanation naming "Acme Corp"
// reads better than one that doesn't.
func GetJobExplanationContext(ctx context.Context, pool *pgxpool.Pool, jobPostingVersionID string) (JobExplanationContext, error) {
	var c JobExplanationContext
	err := pool.QueryRow(ctx,
		`SELECT v.title, co.name, v.description_text
		 FROM job_posting_version v
		 JOIN job_posting p ON p.id = v.job_posting_id
		 JOIN company co ON co.id = p.company_id
		 WHERE v.id = $1`,
		jobPostingVersionID,
	).Scan(&c.Title, &c.Company, &c.Description)
	if err != nil {
		if err == pgx.ErrNoRows {
			return JobExplanationContext{}, fmt.Errorf("job_posting_version %s not found", jobPostingVersionID)
		}
		return JobExplanationContext{}, fmt.Errorf("loading job context for %s: %w", jobPostingVersionID, err)
	}
	return c, nil
}

// HasMatchExplanation is D-09's version-keyed cache check: an explanation
// already on file for this exact (account, version) pair means the
// version hasn't changed since it was generated, so there is nothing new
// to say - skip the LLM call entirely rather than paying for an identical
// answer.
func HasMatchExplanation(ctx context.Context, pool *pgxpool.Pool, accountID, jobPostingVersionID string) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx,
		`SELECT EXISTS (
		   SELECT 1 FROM match_explanation
		   WHERE account_id = $1 AND job_posting_version_id = $2
		 )`,
		accountID, jobPostingVersionID,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("checking match_explanation cache for %s/%s: %w", accountID, jobPostingVersionID, err)
	}
	return exists, nil
}

// WriteMatchExplanation upserts one explanation. ON CONFLICT DO UPDATE
// rather than DO NOTHING - safe to re-run on retry (the queue's own
// backoff might call this twice for the same job), and correct if this
// ever runs for a version whose cached row is somehow stale.
func WriteMatchExplanation(
	ctx context.Context,
	pool *pgxpool.Pool,
	accountID, jobPostingVersionID string,
	summary string,
	evidence []clients.Evidence,
	model string,
	promptVersion int,
) error {
	if evidence == nil {
		evidence = []clients.Evidence{}
	}
	evidenceJSON, err := json.Marshal(evidence)
	if err != nil {
		return fmt.Errorf("marshaling evidence for %s/%s: %w", accountID, jobPostingVersionID, err)
	}

	_, err = pool.Exec(ctx,
		`INSERT INTO match_explanation
		   (account_id, job_posting_version_id, summary, evidence, model, prompt_version, generated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, now())
		 ON CONFLICT (account_id, job_posting_version_id) DO UPDATE SET
		   summary = EXCLUDED.summary,
		   evidence = EXCLUDED.evidence,
		   model = EXCLUDED.model,
		   prompt_version = EXCLUDED.prompt_version,
		   generated_at = now()`,
		accountID, jobPostingVersionID, summary, evidenceJSON, model, promptVersion,
	)
	if err != nil {
		return fmt.Errorf("writing match_explanation for %s/%s: %w", accountID, jobPostingVersionID, err)
	}
	return nil
}
