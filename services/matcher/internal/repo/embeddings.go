package repo

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostingVersionText is what a job_posting_version needs to embed - just
// enough to build the text sent to services/ai, nothing else. Runs on the
// Matcher pool: Layer 1 (job index) already grants app_matcher SELECT on
// job_posting_version (migration 0005), so no new grant was needed for
// this read.
type PostingVersionText struct {
	Title           string
	DescriptionText *string
}

func GetPostingVersionText(ctx context.Context, pool *pgxpool.Pool, versionID string) (PostingVersionText, error) {
	var t PostingVersionText
	err := pool.QueryRow(ctx,
		`SELECT title, description_text FROM job_posting_version WHERE id = $1`,
		versionID,
	).Scan(&t.Title, &t.DescriptionText)
	if err != nil {
		if err == pgx.ErrNoRows {
			return PostingVersionText{}, fmt.Errorf("job_posting_version %s not found", versionID)
		}
		return PostingVersionText{}, fmt.Errorf("loading job_posting_version %s: %w", versionID, err)
	}
	return t, nil
}

// EmbeddingText is the deterministic string actually sent for embedding -
// title plus description, same shape a hybrid keyword search's
// search_tsv already indexes (migration 0010), so the two retrieval
// signals are computed from consistent input.
func (t PostingVersionText) EmbeddingText() string {
	if t.DescriptionText != nil && *t.DescriptionText != "" {
		return t.Title + "\n\n" + *t.DescriptionText
	}
	return t.Title
}

// formatVector renders a Go float32 slice as pgvector's text input format
// - "[0.1,0.2,-0.3]" - bound as a query parameter and cast with ::vector
// in SQL. Avoids taking a dependency on a pgvector-specific pgx type
// extension for the one thing this service needs from it: writing a
// vector column, never querying by similarity from Go yet (that's Stage 2,
// not built in this slice - see specs/matching-pipeline.md's known gaps).
func formatVector(v []float32) string {
	parts := make([]string, len(v))
	for i, f := range v {
		parts[i] = strconv.FormatFloat(float64(f), 'f', -1, 32)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// WriteEmbedding persists a job_posting_version's embedding via the
// column-level grant migration 0010 gives app_matcher: UPDATE
// (embedding, embedding_model, embedded_at) only - this role cannot
// touch title, description, or anything else about the posting through
// this or any other statement, by grant, not by convention.
func WriteEmbedding(ctx context.Context, pool *pgxpool.Pool, versionID string, vector []float32, model string) error {
	_, err := pool.Exec(ctx,
		`UPDATE job_posting_version
		 SET embedding = $1::vector, embedding_model = $2, embedded_at = now()
		 WHERE id = $3`,
		formatVector(vector), model, versionID,
	)
	if err != nil {
		return fmt.Errorf("writing embedding for job_posting_version %s: %w", versionID, err)
	}
	return nil
}
