package clients

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestEmbedSendsCorrectRequestShapeAndHeader(t *testing.T) {
	var gotReq embedRequest
	var gotToken string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Internal-Token")
		if err := json.NewDecoder(r.Body).Decode(&gotReq); err != nil {
			t.Fatalf("decoding request body: %v", err)
		}
		json.NewEncoder(w).Encode(embedResponse{ //nolint:errcheck
			Model:   "test-model",
			Dim:     3,
			Vectors: [][]float32{{0.1, 0.2, 0.3}},
		})
	}))
	defer server.Close()

	client := NewAIClient(server.URL, "secret-token", server.Client())
	vectors, model, err := client.Embed(context.Background(), []string{"hello"}, EmbedKindJob)
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}

	if gotToken != "secret-token" {
		t.Errorf("X-Internal-Token = %q, want %q", gotToken, "secret-token")
	}
	if gotReq.Kind != EmbedKindJob {
		t.Errorf("request kind = %q, want %q", gotReq.Kind, EmbedKindJob)
	}
	if model != "test-model" {
		t.Errorf("model = %q, want %q", model, "test-model")
	}
	if len(vectors) != 1 || len(vectors[0]) != 3 {
		t.Errorf("vectors = %v, want one 3-dim vector", vectors)
	}
}

func TestEmbedWithEmptyTextsIsANoOp(t *testing.T) {
	// No server needed - Embed must not even make a request for zero texts.
	client := NewAIClient("http://should-never-be-called.invalid", "", http.DefaultClient)
	vectors, model, err := client.Embed(context.Background(), nil, EmbedKindJob)
	if err != nil {
		t.Fatalf("Embed with no texts should not error: %v", err)
	}
	if vectors != nil || model != "" {
		t.Errorf("Embed with no texts = (%v, %q), want (nil, \"\")", vectors, model)
	}
}

func TestEmbedRejectsANonOKStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"detail":"model not loaded"}`)) //nolint:errcheck
	}))
	defer server.Close()

	client := NewAIClient(server.URL, "", server.Client())
	_, _, err := client.Embed(context.Background(), []string{"hello"}, EmbedKindJob)
	if err == nil {
		t.Fatal("expected an error for a 503 response, got nil")
	}
}

func TestEmbedRejectsAVectorCountMismatch(t *testing.T) {
	// A defensive check against a services/ai bug, not something the real
	// service is expected to ever do - if it did, silently zipping
	// mismatched vectors to texts would attribute the wrong embedding to
	// the wrong job posting, a much worse failure than a loud error here.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(embedResponse{ //nolint:errcheck
			Model: "test-model", Dim: 3, Vectors: [][]float32{{0.1, 0.2, 0.3}},
		})
	}))
	defer server.Close()

	client := NewAIClient(server.URL, "", server.Client())
	_, _, err := client.Embed(context.Background(), []string{"one", "two"}, EmbedKindJob)
	if err == nil {
		t.Fatal("expected an error when the response has fewer vectors than input texts, got nil")
	}
}

// TestEmbedAgainstRealAIService is a genuine cross-language integration
// test: Go calling the real, running Python service, no fakes on either
// side. Skipped automatically if nothing is listening - this test is
// meant to be run deliberately (`uv run uvicorn app.main:app --port 8100`
// in services/ai first), not as part of a routine `go test ./...` that
// might run with no Python service anywhere nearby.
func TestEmbedAgainstRealAIService(t *testing.T) {
	baseURL := os.Getenv("AI_SERVICE_URL")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8100"
	}

	probeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(probeCtx, http.MethodGet, baseURL+"/healthz", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Skipf("services/ai is not reachable at %s (run `uv run uvicorn app.main:app --port 8100` in services/ai to enable this test): %v", baseURL, err)
	}
	resp.Body.Close()

	client := NewAIClient(baseURL, "", &http.Client{Timeout: 30 * time.Second})
	vectors, model, err := client.Embed(context.Background(), []string{"Senior React Engineer"}, EmbedKindJob)
	if err != nil {
		t.Fatalf("Embed against the real service: %v", err)
	}
	if model != "BAAI/bge-small-en-v1.5" {
		t.Errorf("model = %q, want BAAI/bge-small-en-v1.5", model)
	}
	if len(vectors) != 1 || len(vectors[0]) != 384 {
		t.Errorf("vectors = %d vectors of dim %d, want 1 vector of dim 384", len(vectors), len(vectors[0]))
	}
}
