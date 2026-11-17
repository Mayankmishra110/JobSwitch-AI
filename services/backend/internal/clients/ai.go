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

// Fact mirrors services/ai's app/models.py Fact exactly - every fact sent
// to /v1/match/explain must carry its provenance (ADR D-22), enforced by
// that service's own pydantic schema requiring the field, not by
// convention on this end.
type Fact struct {
	Ref        string `json:"ref"`
	Text       string `json:"text"`
	Provenance string `json:"provenance"`
}

// JobContext mirrors app/models.py's JobContext.
type JobContext struct {
	Title       string  `json:"title"`
	Company     *string `json:"company,omitempty"`
	Description string  `json:"description"`
}

type explainRequest struct {
	Job   JobContext `json:"job"`
	Facts []Fact     `json:"facts"`
}

// Evidence mirrors app/models.py's Evidence - one cited claim, the fact it
// was grounded in, and that fact's own provenance.
type Evidence struct {
	Claim      string `json:"claim"`
	FactRef    string `json:"fact_ref"`
	Provenance string `json:"provenance"`
}

type ExplainResult struct {
	Summary       string
	Evidence      []Evidence
	Model         string
	PromptVersion int
}

type explainResponse struct {
	Summary       string     `json:"summary"`
	Evidence      []Evidence `json:"evidence"`
	Model         string     `json:"model"`
	PromptVersion int        `json:"prompt_version"`
}

// Explain calls POST /v1/match/explain. Maps the service's own documented
// error shapes (specs/embeddings-and-explanation.md) into a plain Go
// error - the caller (internal/worker's queue handler) doesn't need to
// distinguish "not configured" (503) from "provider returned garbage"
// (502) beyond deciding to retry, which job_queue's own backoff already
// does uniformly for any error.
func (c *AIClient) Explain(ctx context.Context, job JobContext, facts []Fact) (ExplainResult, error) {
	if facts == nil {
		facts = []Fact{}
	}

	body, err := json.Marshal(explainRequest{Job: job, Facts: facts})
	if err != nil {
		return ExplainResult{}, fmt.Errorf("marshaling explain request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/match/explain", bytes.NewReader(body))
	if err != nil {
		return ExplainResult{}, fmt.Errorf("building explain request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.internalToken != "" {
		req.Header.Set("X-Internal-Token", c.internalToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return ExplainResult{}, fmt.Errorf("calling services/ai /v1/match/explain: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1000))
		return ExplainResult{}, fmt.Errorf("services/ai /v1/match/explain returned %d: %s", resp.StatusCode, respBody)
	}

	var parsed explainResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return ExplainResult{}, fmt.Errorf("decoding explain response: %w", err)
	}

	return ExplainResult{
		Summary:       parsed.Summary,
		Evidence:      parsed.Evidence,
		Model:         parsed.Model,
		PromptVersion: parsed.PromptVersion,
	}, nil
}
