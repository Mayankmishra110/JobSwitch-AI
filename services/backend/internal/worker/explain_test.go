package worker

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/clients"
)

func TestHandleExplainMatchRejectsInvalidPayload(t *testing.T) {
	handler := HandleExplainMatch(nil, nil)

	if err := handler(context.Background(), json.RawMessage(`{"accountId":"x"}`)); err == nil {
		t.Error("expected an error for a payload with no jobPostingVersionId")
	}
	if err := handler(context.Background(), json.RawMessage(`{"jobPostingVersionId":"y"}`)); err == nil {
		t.Error("expected an error for a payload with no accountId")
	}
}

func TestHandleExplainMatchSkipsWhenAlreadyCached(t *testing.T) {
	admin, matcherPool := setupEmbedProfilePools(t)
	ctx := context.Background()

	accountID := seedBareAccount(t, ctx, admin)
	companyID, versionID := seedExplainFixture(t, ctx, admin)
	t.Cleanup(func() {
		admin.Exec(ctx, "DELETE FROM account WHERE id = $1", accountID) //nolint:errcheck
		admin.Exec(ctx, "DELETE FROM company WHERE id = $1", companyID) //nolint:errcheck
	})

	if _, err := admin.Exec(ctx,
		`INSERT INTO match_explanation (account_id, job_posting_version_id, summary, evidence, model, prompt_version)
		 VALUES ($1, $2, 'Already explained.', '[]'::jsonb, 'previous-model', 1)`,
		accountID, versionID,
	); err != nil {
		t.Fatalf("seeding match_explanation: %v", err)
	}

	// An unreachable AI client is the proof: if the cache check didn't
	// skip, this would fail with a connection error instead of succeeding.
	handler := HandleExplainMatch(matcherPool, unreachableAIClient())
	payload, _ := json.Marshal(map[string]string{"accountId": accountID, "jobPostingVersionId": versionID})
	if err := handler(ctx, payload); err != nil {
		t.Errorf("HandleExplainMatch on an already-cached explanation should skip, not error: %v", err)
	}

	var model string
	if err := admin.QueryRow(ctx,
		"SELECT model FROM match_explanation WHERE account_id = $1 AND job_posting_version_id = $2",
		accountID, versionID,
	).Scan(&model); err != nil {
		t.Fatalf("reading back match_explanation: %v", err)
	}
	if model != "previous-model" {
		t.Errorf("model = %q, want it untouched (\"previous-model\") since the cache hit should have skipped the call", model)
	}
}

// seedExplainFixture inserts a company -> career_source -> job_posting ->
// job_posting_version chain, returning the company and version ids.
func seedExplainFixture(t *testing.T, ctx context.Context, admin *pgxpool.Pool) (companyID, versionID string) {
	t.Helper()

	var sourceID, postingID string
	if err := admin.QueryRow(ctx,
		`INSERT INTO company (name, normalized_domain) VALUES ('Explain Cache Test Co', 'explaincachetest.example') RETURNING id`,
	).Scan(&companyID); err != nil {
		t.Fatalf("seeding company: %v", err)
	}
	if err := admin.QueryRow(ctx,
		`INSERT INTO career_source (company_id, ats_type, board_identifier) VALUES ($1, 'greenhouse', 'explaincachetest') RETURNING id`,
		companyID,
	).Scan(&sourceID); err != nil {
		t.Fatalf("seeding career_source: %v", err)
	}
	if err := admin.QueryRow(ctx,
		`INSERT INTO job_posting (career_source_id, company_id, source_job_id, canonical_title, normalized_title, apply_url)
		 VALUES ($1, $2, 'job-1', 'Engineer', 'engineer', 'https://example.com/apply')
		 RETURNING id`,
		sourceID, companyID,
	).Scan(&postingID); err != nil {
		t.Fatalf("seeding job_posting: %v", err)
	}
	if err := admin.QueryRow(ctx,
		`INSERT INTO job_posting_version (job_posting_id, content_fingerprint, title, description_text)
		 VALUES ($1, 'fp1', 'Engineer', 'Some description.')
		 RETURNING id`,
		postingID,
	).Scan(&versionID); err != nil {
		t.Fatalf("seeding job_posting_version: %v", err)
	}
	if _, err := admin.Exec(ctx, `UPDATE job_posting SET current_version_id = $2 WHERE id = $1`, postingID, versionID); err != nil {
		t.Fatalf("setting current_version_id: %v", err)
	}
	return companyID, versionID
}

func requireRealAIServiceForExplain(t *testing.T, baseURL string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/healthz", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Skipf("services/ai is not reachable at %s: %v", baseURL, err)
	}
	resp.Body.Close()
}

// TestHandleExplainMatchEndToEnd is the full-loop proof, no fakes: a real
// posting, a real candidate_profile/profile_skill pair, a real call to the
// real Python service (and, transitively, a real LLM provider - this is
// the one test in the suite that costs a real token budget), and a real
// row read back from match_explanation.
func TestHandleExplainMatchEndToEnd(t *testing.T) {
	aiURL := os.Getenv("AI_SERVICE_URL")
	if aiURL == "" {
		aiURL = "http://127.0.0.1:8100"
	}
	requireRealAIServiceForExplain(t, aiURL)

	admin, matcherPool := setupEmbedProfilePools(t)
	ctx := context.Background()

	accountID := seedBareAccount(t, ctx, admin)
	var companyID, sourceID, postingID, versionID string
	if err := admin.QueryRow(ctx,
		`INSERT INTO company (name, normalized_domain) VALUES ('Explain Test Co', 'explaintest.example') RETURNING id`,
	).Scan(&companyID); err != nil {
		t.Fatalf("seeding company: %v", err)
	}
	if err := admin.QueryRow(ctx,
		`INSERT INTO career_source (company_id, ats_type, board_identifier) VALUES ($1, 'greenhouse', 'explaintest') RETURNING id`,
		companyID,
	).Scan(&sourceID); err != nil {
		t.Fatalf("seeding career_source: %v", err)
	}
	if err := admin.QueryRow(ctx,
		`INSERT INTO job_posting (career_source_id, company_id, source_job_id, canonical_title, normalized_title, apply_url)
		 VALUES ($1, $2, 'job-1', 'Senior Backend Engineer', 'senior backend engineer', 'https://example.com/apply')
		 RETURNING id`,
		sourceID, companyID,
	).Scan(&postingID); err != nil {
		t.Fatalf("seeding job_posting: %v", err)
	}
	if err := admin.QueryRow(ctx,
		`INSERT INTO job_posting_version (job_posting_id, content_fingerprint, title, description_text)
		 VALUES ($1, 'fp1', 'Senior Backend Engineer', 'Build APIs in Go and Postgres.')
		 RETURNING id`,
		postingID,
	).Scan(&versionID); err != nil {
		t.Fatalf("seeding job_posting_version: %v", err)
	}
	if _, err := admin.Exec(ctx, `UPDATE job_posting SET current_version_id = $2 WHERE id = $1`, postingID, versionID); err != nil {
		t.Fatalf("setting current_version_id: %v", err)
	}
	if _, err := admin.Exec(ctx,
		`INSERT INTO candidate_profile (account_id, current_title) VALUES ($1, 'Backend Engineer')`,
		accountID,
	); err != nil {
		t.Fatalf("seeding candidate_profile: %v", err)
	}
	if _, err := admin.Exec(ctx,
		`INSERT INTO profile_skill (account_id, skill) VALUES ($1, 'Go')`,
		accountID,
	); err != nil {
		t.Fatalf("seeding profile_skill: %v", err)
	}
	t.Cleanup(func() {
		admin.Exec(ctx, "DELETE FROM account WHERE id = $1", accountID) //nolint:errcheck
		admin.Exec(ctx, "DELETE FROM company WHERE id = $1", companyID) //nolint:errcheck
	})

	aiClient := clients.NewAIClient(aiURL, "", &http.Client{Timeout: 30 * time.Second})
	handler := HandleExplainMatch(matcherPool, aiClient)

	payload, _ := json.Marshal(map[string]string{"accountId": accountID, "jobPostingVersionId": versionID})
	if err := handler(ctx, payload); err != nil {
		t.Fatalf("HandleExplainMatch: %v", err)
	}

	var summary, model string
	var promptVersion int
	var evidence []byte
	if err := admin.QueryRow(ctx,
		"SELECT summary, evidence, model, prompt_version FROM match_explanation WHERE account_id = $1 AND job_posting_version_id = $2",
		accountID, versionID,
	).Scan(&summary, &evidence, &model, &promptVersion); err != nil {
		t.Fatalf("reading back match_explanation: %v", err)
	}
	if summary == "" {
		t.Error("summary is empty, want a real explanation")
	}
	if model == "" {
		t.Error("model is empty, want a real provider model name")
	}
	if promptVersion < 1 {
		t.Errorf("prompt_version = %d, want >= 1", promptVersion)
	}

	var parsedEvidence []map[string]any
	if err := json.Unmarshal(evidence, &parsedEvidence); err != nil {
		t.Fatalf("evidence is not valid JSON: %v", err)
	}

	// Calling it again must be a cache hit (D-09) - confirmed by an
	// unreachable client succeeding anyway.
	cachedHandler := HandleExplainMatch(matcherPool, unreachableAIClient())
	if err := cachedHandler(ctx, payload); err != nil {
		t.Errorf("second call should hit the D-09 cache and skip the AI call: %v", err)
	}
}
