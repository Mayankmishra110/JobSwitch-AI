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

func requireRealAIService(t *testing.T, baseURL string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/healthz", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Skipf("services/ai is not reachable at %s (run `uv run uvicorn app.main:app --port 8100` in services/ai): %v", baseURL, err)
	}
	resp.Body.Close()
}

// TestHandleEmbedJobVersionEndToEnd is the full-loop proof: a real posting
// seeded in Postgres, a real call to the real Python embedding service,
// and a real vector read back from job_posting_version.embedding - no
// fakes anywhere in this test.
func TestHandleEmbedJobVersionEndToEnd(t *testing.T) {
	aiURL := os.Getenv("AI_SERVICE_URL")
	if aiURL == "" {
		aiURL = "http://127.0.0.1:8100"
	}
	requireRealAIService(t, aiURL)

	adminURL := os.Getenv("DATABASE_URL_TEST")
	if adminURL == "" {
		adminURL = "postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test"
	}
	admin, err := pgxpool.New(context.Background(), adminURL)
	if err != nil {
		t.Fatalf("connecting admin pool: %v", err)
	}
	defer admin.Close()

	matcherURL := os.Getenv("DATABASE_URL_TEST_MATCHER")
	if matcherURL == "" {
		matcherURL = "postgres://app_matcher_test:matcherpassword@127.0.0.1:5432/jobswitch_test"
	}
	ctx := context.Background()

	if _, err := admin.Exec(ctx, `
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_matcher_test') THEN
				CREATE ROLE app_matcher_test LOGIN PASSWORD 'matcherpassword';
			END IF;
		END
		$$;
	`); err != nil {
		t.Fatalf("ensuring app_matcher_test role: %v", err)
	}
	admin.Exec(ctx, "GRANT app_matcher TO app_matcher_test") //nolint:errcheck
	admin.Exec(ctx, "ALTER ROLE app_matcher_test BYPASSRLS") //nolint:errcheck // see specs/matching-pipeline.md's BYPASSRLS finding

	matcherPool, err := pgxpool.New(ctx, matcherURL)
	if err != nil {
		t.Fatalf("connecting matcher pool: %v", err)
	}
	defer matcherPool.Close()

	admin.Exec(ctx, "DELETE FROM company WHERE normalized_domain = 'embedtest.example'") //nolint:errcheck

	var companyID, sourceID, postingID, versionID string
	admin.QueryRow(ctx, //nolint:errcheck
		`INSERT INTO company (name, normalized_domain) VALUES ('Embed Test Co', 'embedtest.example') RETURNING id`,
	).Scan(&companyID)
	admin.QueryRow(ctx, //nolint:errcheck
		`INSERT INTO career_source (company_id, ats_type, board_identifier) VALUES ($1, 'greenhouse', 'embedtest') RETURNING id`,
		companyID,
	).Scan(&sourceID)
	admin.QueryRow(ctx, //nolint:errcheck
		`INSERT INTO job_posting (career_source_id, company_id, source_job_id, canonical_title, normalized_title, apply_url)
		 VALUES ($1, $2, 'job-1', 'Senior React Engineer', 'senior react engineer', 'https://example.com/apply')
		 RETURNING id`,
		sourceID, companyID,
	).Scan(&postingID)
	admin.QueryRow(ctx, //nolint:errcheck
		`INSERT INTO job_posting_version (job_posting_id, content_fingerprint, title, description_text)
		 VALUES ($1, 'fp1', 'Senior React Engineer', 'Build product surfaces in React and TypeScript.')
		 RETURNING id`,
		postingID,
	).Scan(&versionID)
	admin.Exec(ctx, `UPDATE job_posting SET current_version_id = $2 WHERE id = $1`, postingID, versionID) //nolint:errcheck

	aiClient := clients.NewAIClient(aiURL, "", &http.Client{Timeout: 30 * time.Second})
	handler := HandleEmbedJobVersion(matcherPool, aiClient)

	payload, _ := json.Marshal(map[string]string{"versionId": versionID})
	if err := handler(ctx, payload); err != nil {
		t.Fatalf("HandleEmbedJobVersion: %v", err)
	}

	var embeddingModel string
	var embeddedAt *time.Time
	var dim int
	if err := admin.QueryRow(ctx,
		`SELECT embedding_model, embedded_at, vector_dims(embedding) FROM job_posting_version WHERE id = $1`,
		versionID,
	).Scan(&embeddingModel, &embeddedAt, &dim); err != nil {
		t.Fatalf("reading back embedding: %v", err)
	}

	if embeddingModel != "BAAI/bge-small-en-v1.5" {
		t.Errorf("embedding_model = %q, want BAAI/bge-small-en-v1.5", embeddingModel)
	}
	if embeddedAt == nil {
		t.Error("embedded_at is nil, want a timestamp")
	}
	if dim != 384 {
		t.Errorf("vector_dims(embedding) = %d, want 384", dim)
	}
}

func TestHandleEmbedJobVersionRejectsAMissingVersionID(t *testing.T) {
	handler := HandleEmbedJobVersion(nil, nil)
	err := handler(context.Background(), json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("expected an error for a payload with no versionId")
	}
}
