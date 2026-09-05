// Package worker holds job_queue handlers for the matcher-worker binary
// (cmd/worker). Each handler has the same shape: parse payload, do the
// work, return an error - queue.go's own claim/complete/fail loop (see
// cmd/worker/main.go) owns retry/backoff/dead-lettering, so a handler
// never needs its own retry logic.
package worker

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mayankmishra110/jobswitch-ai/services/matcher/internal/clients"
	"github.com/mayankmishra110/jobswitch-ai/services/matcher/internal/repo"
)

// EmbedJobVersionQueue is the queue name apps/worker's TS side would
// enqueue onto after committing a new/changed job_posting_version - see
// specs/matching-pipeline.md's known-gaps list: nothing enqueues onto
// this yet, so today this handler only ever runs when something calls it
// directly (a test, or a future backfill command), not from a live
// scheduler-driven pipeline.
const EmbedJobVersionQueue = "embed.job_version"

type embedJobVersionPayload struct {
	VersionID string `json:"versionId"`
}

// HandleEmbedJobVersion embeds one job_posting_version's title+description
// and writes the result back. Idempotent in the sense that matters: safe
// to re-run on an already-embedded version (it just overwrites with the
// same or a newer embedding_model), which is what makes this safe to
// retry under the queue's own backoff on a transient AI-service failure.
func HandleEmbedJobVersion(matcherPool *pgxpool.Pool, ai *clients.AIClient) func(context.Context, json.RawMessage) error {
	return func(ctx context.Context, rawPayload json.RawMessage) error {
		var payload embedJobVersionPayload
		if err := json.Unmarshal(rawPayload, &payload); err != nil {
			return fmt.Errorf("unmarshaling embed.job_version payload: %w", err)
		}
		if payload.VersionID == "" {
			return fmt.Errorf("embed.job_version payload missing versionId")
		}

		text, err := repo.GetPostingVersionText(ctx, matcherPool, payload.VersionID)
		if err != nil {
			return err
		}

		vectors, model, err := ai.Embed(ctx, []string{text.EmbeddingText()}, clients.EmbedKindJob)
		if err != nil {
			return fmt.Errorf("embedding job_posting_version %s: %w", payload.VersionID, err)
		}
		if len(vectors) != 1 {
			return fmt.Errorf("services/ai returned %d vectors for 1 input text", len(vectors))
		}

		return repo.WriteEmbedding(ctx, matcherPool, payload.VersionID, vectors[0], model)
	}
}
