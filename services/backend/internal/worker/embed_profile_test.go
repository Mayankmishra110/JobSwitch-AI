package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/clients"
)

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

// setupEmbedProfilePools mirrors internal/match's own setupPools (same
// role/grant/BYPASSRLS provisioning), duplicated rather than imported
// across package boundaries - each package seeds what its own tests need.
func setupEmbedProfilePools(t *testing.T) (admin, matcherPool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()

	admin, err := pgxpool.New(ctx, adminURL())
	if err != nil {
		t.Fatalf("connecting admin pool: %v", err)
	}
	t.Cleanup(admin.Close)

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
	if _, err := admin.Exec(ctx, "GRANT app_matcher TO app_matcher_test"); err != nil {
		t.Fatalf("granting app_matcher to app_matcher_test: %v", err)
	}
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

func seedBareAccount(t *testing.T, ctx context.Context, admin *pgxpool.Pool) string {
	t.Helper()
	var accountID string
	if err := admin.QueryRow(ctx, `INSERT INTO account (type) VALUES ('personal') RETURNING id`).Scan(&accountID); err != nil {
		t.Fatalf("inserting account: %v", err)
	}
	return accountID
}

func unreachableAIClient() *clients.AIClient {
	return clients.NewAIClient("http://127.0.0.1:1", "", &http.Client{Timeout: 2 * time.Second})
}

func TestHandleEmbedProfileRejectsInvalidPayload(t *testing.T) {
	handler := HandleEmbedProfile(nil, nil)

	if err := handler(context.Background(), json.RawMessage(`{"kind":"resume"}`)); err == nil {
		t.Error("expected an error for a payload with no accountId")
	}
	if err := handler(context.Background(), json.RawMessage(`{"accountId":"x","kind":"bogus"}`)); err == nil {
		t.Error("expected an error for an unknown kind")
	}
}

func TestHandleEmbedProfileNoContentIsANoOp(t *testing.T) {
	admin, matcherPool := setupEmbedProfilePools(t)
	ctx := context.Background()
	accountID := seedBareAccount(t, ctx, admin)
	t.Cleanup(func() {
		admin.Exec(ctx, "DELETE FROM account WHERE id = $1", accountID) //nolint:errcheck
	})

	// No resume_upload row and no candidate_profile row - both kinds have
	// nothing to embed. The unreachable AI client proves no HTTP call is
	// even attempted; a real call there would time out and fail the test.
	handler := HandleEmbedProfile(matcherPool, unreachableAIClient())

	payload, _ := json.Marshal(map[string]string{"accountId": accountID, "kind": "resume"})
	if err := handler(ctx, payload); err != nil {
		t.Errorf("HandleEmbedProfile(resume, no upload): %v", err)
	}
	payload, _ = json.Marshal(map[string]string{"accountId": accountID, "kind": "desired_role"})
	if err := handler(ctx, payload); err != nil {
		t.Errorf("HandleEmbedProfile(desired_role, no profile): %v", err)
	}

	var count int
	if err := admin.QueryRow(ctx, "SELECT count(*) FROM profile_embedding WHERE account_id = $1", accountID).Scan(&count); err != nil {
		t.Fatalf("counting profile_embedding rows: %v", err)
	}
	if count != 0 {
		t.Errorf("profile_embedding rows = %d, want 0 (nothing should have been written)", count)
	}
}

func TestHandleEmbedProfileSkipsTheAICallWhenUnchanged(t *testing.T) {
	admin, matcherPool := setupEmbedProfilePools(t)
	ctx := context.Background()
	accountID := seedBareAccount(t, ctx, admin)
	t.Cleanup(func() {
		admin.Exec(ctx, "DELETE FROM account WHERE id = $1", accountID) //nolint:errcheck
	})

	const resumeText = "Experienced platform engineer."
	if _, err := admin.Exec(ctx,
		`INSERT INTO resume_upload (account_id, filename, raw_text) VALUES ($1, 'r.pdf', $2)`,
		accountID, resumeText,
	); err != nil {
		t.Fatalf("seeding resume_upload: %v", err)
	}

	sum := sha256.Sum256([]byte(resumeText))
	hash := hex.EncodeToString(sum[:])
	if _, err := admin.Exec(ctx,
		`INSERT INTO profile_embedding (account_id, kind, embedding, source_hash, embedding_model)
		 VALUES ($1, 'resume', array_fill(0::real, ARRAY[384])::vector, $2, 'previous-model')`,
		accountID, hash,
	); err != nil {
		t.Fatalf("seeding profile_embedding: %v", err)
	}

	// The unreachable client is the proof: if the handler's hash check did
	// not skip the AI call, this would fail with a connection error rather
	// than succeeding silently.
	handler := HandleEmbedProfile(matcherPool, unreachableAIClient())
	payload, _ := json.Marshal(map[string]string{"accountId": accountID, "kind": "resume"})
	if err := handler(ctx, payload); err != nil {
		t.Errorf("HandleEmbedProfile with an unchanged hash should skip the AI call, not error: %v", err)
	}

	var model string
	if err := admin.QueryRow(ctx,
		"SELECT embedding_model FROM profile_embedding WHERE account_id = $1 AND kind = 'resume'", accountID,
	).Scan(&model); err != nil {
		t.Fatalf("reading back profile_embedding: %v", err)
	}
	if model != "previous-model" {
		t.Errorf("embedding_model = %q, want it untouched (\"previous-model\") since the AI call should have been skipped", model)
	}
}

func requireRealAIServiceForProfile(t *testing.T, baseURL string) {
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

// TestHandleEmbedProfileEndToEnd is the full-loop proof for both kinds, no
// fakes: a real résumé upload and a real candidate_profile/profile_skill
// pair, a real call to the real Python embedding service, and real
// vectors read back from profile_embedding.
func TestHandleEmbedProfileEndToEnd(t *testing.T) {
	aiURL := os.Getenv("AI_SERVICE_URL")
	if aiURL == "" {
		aiURL = "http://127.0.0.1:8100"
	}
	requireRealAIServiceForProfile(t, aiURL)

	admin, matcherPool := setupEmbedProfilePools(t)
	ctx := context.Background()
	accountID := seedBareAccount(t, ctx, admin)
	t.Cleanup(func() {
		admin.Exec(ctx, "DELETE FROM account WHERE id = $1", accountID) //nolint:errcheck
	})

	if _, err := admin.Exec(ctx,
		`INSERT INTO resume_upload (account_id, filename, raw_text) VALUES ($1, 'r.pdf', 'Senior Kubernetes platform engineer.')`,
		accountID,
	); err != nil {
		t.Fatalf("seeding resume_upload: %v", err)
	}
	currentTitle := "Platform Engineer"
	if _, err := admin.Exec(ctx,
		`INSERT INTO candidate_profile (account_id, current_title, desired_titles) VALUES ($1, $2, $3)`,
		accountID, currentTitle, []string{"Senior Platform Engineer"},
	); err != nil {
		t.Fatalf("seeding candidate_profile: %v", err)
	}

	aiClient := clients.NewAIClient(aiURL, "", &http.Client{Timeout: 30 * time.Second})
	handler := HandleEmbedProfile(matcherPool, aiClient)

	for _, kind := range []string{"resume", "desired_role"} {
		payload, _ := json.Marshal(map[string]string{"accountId": accountID, "kind": kind})
		if err := handler(ctx, payload); err != nil {
			t.Fatalf("HandleEmbedProfile(%s): %v", kind, err)
		}
	}

	rows, err := admin.Query(ctx,
		`SELECT kind, embedding_model, vector_dims(embedding), source_hash
		 FROM profile_embedding WHERE account_id = $1`,
		accountID,
	)
	if err != nil {
		t.Fatalf("querying profile_embedding: %v", err)
	}
	defer rows.Close()

	seen := map[string]bool{}
	for rows.Next() {
		var kind, model, hash string
		var dim int
		if err := rows.Scan(&kind, &model, &dim, &hash); err != nil {
			t.Fatalf("scanning profile_embedding row: %v", err)
		}
		if model != "BAAI/bge-small-en-v1.5" {
			t.Errorf("%s: embedding_model = %q, want BAAI/bge-small-en-v1.5", kind, model)
		}
		if dim != 384 {
			t.Errorf("%s: vector_dims(embedding) = %d, want 384", kind, dim)
		}
		if hash == "" {
			t.Errorf("%s: source_hash is empty, want a real sha256", kind)
		}
		seen[kind] = true
	}
	if !seen["resume"] || !seen["desired_role"] {
		t.Errorf("expected both kinds embedded, got %v", seen)
	}
}
