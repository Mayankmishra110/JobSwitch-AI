package repo

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CandidateEmbeddings holds one account's query-side vectors
// (profile_embedding, migration 0010) as pgvector text ("[0.1,0.2,...]"),
// the same textual representation internal/repo/embeddings.go's
// formatVector already writes and WriteEmbedding already casts back with
// ::vector - so a value read here can be passed straight back into another
// query's ::vector parameter with no parsing in Go on either side.
//
// Either field may be nil: nothing has necessarily embedded that kind for
// this account yet (a resume-less profile, or one with no title/skills to
// build a desired-role text from - see DesiredRoleText) - "no row yet" is
// a real, reachable state, not an error.
type CandidateEmbeddings struct {
	Resume      *string
	DesiredRole *string
}

// LoadCandidateEmbeddings reads one account's query vectors. Explicit
// account_id filter, per this package's own rule (see candidate.go's
// package doc comment) - this pool holds BYPASSRLS.
func LoadCandidateEmbeddings(ctx context.Context, pool *pgxpool.Pool, accountID string) (CandidateEmbeddings, error) {
	rows, err := pool.Query(ctx,
		`SELECT kind, embedding::text FROM profile_embedding WHERE account_id = $1`,
		accountID,
	)
	if err != nil {
		return CandidateEmbeddings{}, fmt.Errorf("loading profile_embedding for %s: %w", accountID, err)
	}
	defer rows.Close()

	var out CandidateEmbeddings
	for rows.Next() {
		var kind, vector string
		if err := rows.Scan(&kind, &vector); err != nil {
			return CandidateEmbeddings{}, fmt.Errorf("scanning profile_embedding row for %s: %w", accountID, err)
		}
		switch kind {
		case "resume":
			v := vector
			out.Resume = &v
		case "desired_role":
			v := vector
			out.DesiredRole = &v
		}
	}
	return out, rows.Err()
}

// RetrievalScores is Stage 2's per-posting hybrid retrieval output (see
// specs/matching-pipeline.md) - the Vector and Keyword halves of
// rank.Signals, computed here rather than in internal/rank because both
// need a database round trip; internal/rank stays pure and DB-free per its
// own doc comment.
type RetrievalScores struct {
	Vector  float64
	Keyword float64
}

// rrfK is Reciprocal Rank Fusion's smoothing constant, matching the plan's
// own formula (Sigma 1/(60+rank_i)) verbatim - large enough that the gap
// between rank 1 and rank 2 doesn't dominate the fused score the way it
// would with a small or zero constant.
const rrfK = 60.0

// neutralRetrievalScore is what a candidate posting scores on a dimension
// nobody has computed yet - not 0, matching every other "unknown" signal
// in this package's sibling internal/match/signals.go (LocationScore,
// SeniorityScore's either-side-unknown case): a posting must never be
// penalized for a fact that simply hasn't been computed, whether that's
// because embed.job_version hasn't reached it yet or because
// embed.profile doesn't exist yet to give the candidate a query vector at
// all.
const neutralRetrievalScore = 0.5

// HybridRetrieve scores Stage 1's prefiltered candidates (see
// PrefilterCandidates) for semantic and lexical relevance against one
// account's facts and query embeddings.
//
// Vector fusion is Reciprocal Rank Fusion, named explicitly per D-32
// rather than hand-blending cosine distances: up to two independent
// rankings - by cosine distance to the resume embedding, and to the
// desired-role embedding - are combined as Sigma 1/(60+rank_i), summed
// over whichever of the two the candidate actually has a query vector for
// ("vector search twice ... fused via RRF" in the plan). The result is
// normalized against the maximum a candidate could achieve with however
// many of those two rankers actually ran, so an account with only a
// resume embedding is judged on the same [0,1] scale as one with both,
// rather than being structurally capped below it.
//
// Keyword stays a separate, independently-weighted signal rather than
// being folded into that same RRF sum - this is the actual reason D-32
// names RRF at all: ts_rank_cd and cosine distance live on incomparable
// scales, and forcing them into one blended number would mean silently
// deciding how many keyword-rank positions equal one embedding-rank
// position. Postgres's own normalization option 32 (rank/(rank+1)) bounds
// ts_rank_cd to [0,1) without that guess; combining it with Vector at
// genuinely different scales is rank.Score's job (a renormalized weighted
// average - this codebase's already-established way to combine signals of
// different kinds), not this function's.
//
// A posting whose version has no embedding yet, or an account with no
// query embedding at all, scores neutralRetrievalScore on that dimension -
// never 0, for the reason that constant's own doc comment gives.
func HybridRetrieve(
	ctx context.Context,
	pool *pgxpool.Pool,
	candidateIDs []string,
	facts CandidateFacts,
	embeddings CandidateEmbeddings,
) (map[string]RetrievalScores, error) {
	out := make(map[string]RetrievalScores, len(candidateIDs))
	for _, id := range candidateIDs {
		out[id] = RetrievalScores{Vector: neutralRetrievalScore, Keyword: neutralRetrievalScore}
	}
	if len(candidateIDs) == 0 {
		return out, nil
	}

	rankerCount := 0
	if embeddings.Resume != nil {
		rankerCount++
	}
	if embeddings.DesiredRole != nil {
		rankerCount++
	}

	// Same keyword floor Stage 1 already searched with (buildKeywordFloor,
	// postings.go) - nil when the candidate gave nothing to search for,
	// which leaves every posting at the neutral default above rather than
	// a computed-but-meaningless ts_rank_cd against an empty query.
	keywordQuery := buildKeywordFloor(facts)

	rows, err := pool.Query(ctx, `
		WITH candidates AS (
			SELECT unnest($1::text[])::uuid AS job_posting_id
		),
		versions AS (
			SELECT c.job_posting_id, v.embedding, v.search_tsv
			FROM candidates c
			JOIN job_posting p ON p.id = c.job_posting_id
			JOIN job_posting_version v ON v.id = p.current_version_id
		),
		resume_rank AS (
			SELECT job_posting_id, RANK() OVER (ORDER BY embedding <=> $2::vector) AS rnk
			FROM versions
			WHERE $2::vector IS NOT NULL AND embedding IS NOT NULL
		),
		role_rank AS (
			SELECT job_posting_id, RANK() OVER (ORDER BY embedding <=> $3::vector) AS rnk
			FROM versions
			WHERE $3::vector IS NOT NULL AND embedding IS NOT NULL
		),
		keyword_scores AS (
			SELECT job_posting_id,
			       ts_rank_cd(search_tsv, websearch_to_tsquery('english', $4::text), 32) AS score
			FROM versions
			WHERE $4::text IS NOT NULL
		)
		SELECT v.job_posting_id, (v.embedding IS NOT NULL) AS has_embedding,
		       rr.rnk, ro.rnk, ks.score
		FROM versions v
		LEFT JOIN resume_rank rr ON rr.job_posting_id = v.job_posting_id
		LEFT JOIN role_rank ro ON ro.job_posting_id = v.job_posting_id
		LEFT JOIN keyword_scores ks ON ks.job_posting_id = v.job_posting_id`,
		candidateIDs, embeddings.Resume, embeddings.DesiredRole, keywordQuery,
	)
	if err != nil {
		return nil, fmt.Errorf("hybrid retrieval: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var jobPostingID string
		var hasEmbedding bool
		var resumeRank, roleRank *int64
		var keywordScore *float64
		if err := rows.Scan(&jobPostingID, &hasEmbedding, &resumeRank, &roleRank, &keywordScore); err != nil {
			return nil, fmt.Errorf("scanning hybrid retrieval row: %w", err)
		}

		scores := out[jobPostingID]

		if keywordScore != nil {
			scores.Keyword = *keywordScore
		}

		if hasEmbedding && rankerCount > 0 {
			var rrf float64
			if resumeRank != nil {
				rrf += 1.0 / (rrfK + float64(*resumeRank))
			}
			if roleRank != nil {
				rrf += 1.0 / (rrfK + float64(*roleRank))
			}
			maxRRF := float64(rankerCount) / (rrfK + 1.0)
			scores.Vector = rrf / maxRRF
		}

		out[jobPostingID] = scores
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// embed.profile (internal/worker) - the write side of profile_embedding.
// LoadCandidateEmbeddings above is Stage 2's read side of the same table.
// ---------------------------------------------------------------------------

// GetResumeText reads an account's current résumé text (resume_upload,
// granted to app_matcher by migration 0013 specifically so this could be
// built). No row is a real, reachable state - no active job search yet,
// or one that hasn't uploaded a résumé - not an error; the caller treats
// "" as "nothing to embed."
func GetResumeText(ctx context.Context, pool *pgxpool.Pool, accountID string) (string, error) {
	var text string
	err := pool.QueryRow(ctx,
		`SELECT raw_text FROM resume_upload WHERE account_id = $1`, accountID,
	).Scan(&text)
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", nil
		}
		return "", fmt.Errorf("loading resume_upload for %s: %w", accountID, err)
	}
	return text, nil
}

// DesiredRoleText builds the text embedded as profile_embedding's
// 'desired_role' kind, from exactly the fields buildKeywordFloor already
// treats as the candidate's role-intent signal (current_title,
// desired_titles, skills) - so the embedding and Stage 1's keyword floor
// agree on what "the role this candidate wants" means, rather than each
// inventing its own definition. Empty when the candidate has given none
// of these - nothing to embed, not an error.
func DesiredRoleText(facts CandidateFacts) string {
	parts := make([]string, 0, 1+len(facts.DesiredTitles)+len(facts.Skills))
	if facts.CurrentTitle != nil && *facts.CurrentTitle != "" {
		parts = append(parts, *facts.CurrentTitle)
	}
	parts = append(parts, facts.DesiredTitles...)
	parts = append(parts, facts.Skills...)
	return strings.Join(parts, ", ")
}

// GetProfileEmbeddingSourceHash reads the source_hash last embedded for
// one (account, kind) pair - profile_embedding.source_hash's own doc
// comment (migration 0010) names exactly this use: skip re-embedding text
// that hasn't actually changed. "" (not found) is a real, reachable state
// - nothing has been embedded for this account/kind yet.
func GetProfileEmbeddingSourceHash(ctx context.Context, pool *pgxpool.Pool, accountID, kind string) (string, error) {
	var hash string
	err := pool.QueryRow(ctx,
		`SELECT source_hash FROM profile_embedding WHERE account_id = $1 AND kind = $2`,
		accountID, kind,
	).Scan(&hash)
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", nil
		}
		return "", fmt.Errorf("loading profile_embedding source_hash for %s/%s: %w", accountID, kind, err)
	}
	return hash, nil
}

// WriteProfileEmbedding upserts one (account, kind) row. profile_embedding's
// primary key is exactly that pair (migration 0010), so this is always a
// full replace of whichever kind changed, never a partial update -
// mirroring internal/repo/embeddings.go's WriteEmbedding for the job side.
func WriteProfileEmbedding(ctx context.Context, pool *pgxpool.Pool, accountID, kind string, vector []float32, model, sourceHash string) error {
	_, err := pool.Exec(ctx,
		`INSERT INTO profile_embedding (account_id, kind, embedding, source_hash, embedding_model, updated_at)
		 VALUES ($1, $2, $3::vector, $4, $5, now())
		 ON CONFLICT (account_id, kind) DO UPDATE SET
		   embedding = EXCLUDED.embedding,
		   source_hash = EXCLUDED.source_hash,
		   embedding_model = EXCLUDED.embedding_model,
		   updated_at = now()`,
		accountID, kind, formatVector(vector), sourceHash, model,
	)
	if err != nil {
		return fmt.Errorf("writing profile_embedding for %s/%s: %w", accountID, kind, err)
	}
	return nil
}
