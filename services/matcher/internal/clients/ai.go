// Package clients holds outbound HTTP clients to this system's other
// internal services. Just one today: services/ai.
package clients

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// EmbedKind mirrors services/ai's app/models.py EmbedRequest.kind exactly
// - "job" and "profile" are the only two values that service accepts.
type EmbedKind string

const (
	EmbedKindJob     EmbedKind = "job"
	EmbedKindProfile EmbedKind = "profile"
)

// AIClient calls services/ai over HTTP. Stateless on both ends - no
// session, no retry-with-backoff beyond what the caller's own queue
// handler does at the job_queue level (see ADR: don't build a second
// retry system on top of the one job_queue already has).
type AIClient struct {
	baseURL       string
	internalToken string
	httpClient    *http.Client
}

func NewAIClient(baseURL, internalToken string, httpClient *http.Client) *AIClient {
	return &AIClient{baseURL: baseURL, internalToken: internalToken, httpClient: httpClient}
}

type embedRequest struct {
	Texts []string  `json:"texts"`
	Kind  EmbedKind `json:"kind"`
}

type embedResponse struct {
	Model   string      `json:"model"`
	Dim     int         `json:"dim"`
	Vectors [][]float32 `json:"vectors"`
}

// Embed calls POST /v1/embed. Returns one vector per input text, in the
// same order, plus the model name the response reported - callers persist
// that alongside the vector (job_posting_version.embedding_model,
// profile_embedding.embedding_model) so a future model swap is
// detectable per-row, not just assumed.
func (c *AIClient) Embed(ctx context.Context, texts []string, kind EmbedKind) (vectors [][]float32, model string, err error) {
	if len(texts) == 0 {
		return nil, "", nil
	}

	body, err := json.Marshal(embedRequest{Texts: texts, Kind: kind})
	if err != nil {
		return nil, "", fmt.Errorf("marshaling embed request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/embed", bytes.NewReader(body))
	if err != nil {
		return nil, "", fmt.Errorf("building embed request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.internalToken != "" {
		req.Header.Set("X-Internal-Token", c.internalToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("calling services/ai /v1/embed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1000))
		return nil, "", fmt.Errorf("services/ai /v1/embed returned %d: %s", resp.StatusCode, respBody)
	}

	var parsed embedResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, "", fmt.Errorf("decoding embed response: %w", err)
	}
	if len(parsed.Vectors) != len(texts) {
		return nil, "", fmt.Errorf(
			"services/ai returned %d vectors for %d input texts", len(parsed.Vectors), len(texts),
		)
	}

	return parsed.Vectors, parsed.Model, nil
}
