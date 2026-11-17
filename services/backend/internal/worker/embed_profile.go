package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/clients"
	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/repo"
)

// EmbedProfileQueue mirrors packages/core/src/profile.ts's
// EMBED_PROFILE_QUEUE exactly - a cross-language contract enforced by
// matching this string (and embedProfilePayload's shape below) on both
// sides, the same way EmbedJobVersionQueue already works. Enqueued from
// packages/db/src/repositories/jobSearch.ts (kind "resume", on every
// résumé upload) and profile.ts (kind "desired_role", on every profile/
// skills write) - see specs/matching-pipeline.md.
const EmbedProfileQueue = "embed.profile"

type embedProfilePayload struct {
	AccountID string `json:"accountId"`
	Kind      string `json:"kind"` // "resume" | "desired_role"
}

// HandleEmbedProfile (re-)computes one of an account's two
// profile_embedding rows. Idempotent in the sense that matters twice
// over: safe to re-run (upserts on the (account_id, kind) primary key,
// same as HandleEmbedJobVersion), and cheap to re-run unnecessarily - a
// sha256 of the text about to be embedded is compared against
// profile_embedding.source_hash first, and the real AI call is skipped
// entirely when nothing has actually changed since the last run. This is
// what makes it safe for the TS producers to enqueue unconditionally on
// every write rather than each reasoning about which specific field
// change is "worth" a re-embed.
func HandleEmbedProfile(matcherPool *pgxpool.Pool, ai *clients.AIClient) func(context.Context, json.RawMessage) error {
	return func(ctx context.Context, rawPayload json.RawMessage) error {
		var payload embedProfilePayload
		if err := json.Unmarshal(rawPayload, &payload); err != nil {
			return fmt.Errorf("unmarshaling embed.profile payload: %w", err)
		}
		if payload.AccountID == "" {
			return fmt.Errorf("embed.profile payload missing accountId")
		}
		if payload.Kind != "resume" && payload.Kind != "desired_role" {
			return fmt.Errorf("embed.profile payload has unknown kind %q", payload.Kind)
		}

		var text string
		switch payload.Kind {
		case "resume":
			t, err := repo.GetResumeText(ctx, matcherPool, payload.AccountID)
			if err != nil {
				return err
			}
			text = t
		case "desired_role":
			facts, err := repo.LoadCandidateFacts(ctx, matcherPool, payload.AccountID)
			if err != nil {
				return fmt.Errorf("loading facts for %s: %w", payload.AccountID, err)
			}
			text = repo.DesiredRoleText(facts)
		}

		if text == "" {
			// Nothing to embed yet (no résumé uploaded, or no title/desired
			// titles/skills given) - a real, reachable state, not an error.
			// Leaves any previously-written embedding in place rather than
			// clearing it: an account that had a résumé and then somehow
			// reads back empty text is a bug to investigate, not a signal
			// to silently discard the last real embedding.
			return nil
		}

		hash := sha256Hex(text)
		existingHash, err := repo.GetProfileEmbeddingSourceHash(ctx, matcherPool, payload.AccountID, payload.Kind)
		if err != nil {
			return err
		}
		if existingHash == hash {
			return nil // Unchanged since the last run - skip the AI call.
		}

		vectors, model, err := ai.Embed(ctx, []string{text}, clients.EmbedKindProfile)
		if err != nil {
			return fmt.Errorf("embedding profile %s/%s: %w", payload.AccountID, payload.Kind, err)
		}
		if len(vectors) != 1 {
			return fmt.Errorf("services/ai returned %d vectors for 1 input text", len(vectors))
		}

		return repo.WriteProfileEmbedding(ctx, matcherPool, payload.AccountID, payload.Kind, vectors[0], model, hash)
	}
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
