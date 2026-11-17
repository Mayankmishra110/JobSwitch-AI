// Package session validates the same js_session cookie apps/web issues.
//
// This is the highest-risk integration point in the whole matcher service:
// every detail here has to match packages/db/src/repositories/sessions.ts
// and packages/db/src/repositories/identity.ts exactly, or a session that
// works against apps/web silently fails (or worse, silently resolves to the
// wrong account) against this service. None of the following is arbitrary:
//
//  1. The cookie holds the RAW base64url token, unsigned. apps/web
//     registers @fastify/cookie with a secret, but the session hook never
//     calls unsignCookie - so there is nothing to unsign here either.
//  2. The stored hash is sha256 of the COOKIE STRING itself (UTF-8 bytes of
//     the base64url text), not of the decoded token bytes. Hashing the
//     decoded bytes would silently produce a hash that never matches.
//  3. The hash is stored and compared as raw bytes (Postgres bytea), never
//     hex- or base64-encoded first.
//  4. Role is joined live from account_member on every call, never cached -
//     a revoked membership must take effect on the very next request.
package session

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type MemberRole string

const (
	RoleOwner  MemberRole = "owner"
	RoleAdmin  MemberRole = "admin"
	RoleMember MemberRole = "member"
)

// Principal mirrors packages/core/src/identity.ts's Principal exactly:
// userId, accountId, role, sessionId.
type Principal struct {
	UserID    string
	AccountID string
	Role      MemberRole
	SessionID string
}

var ErrNoSession = errors.New("session: no matching, unrevoked, unexpired session")

// HashToken reproduces packages/db/src/repositories/identity.ts's
// hashToken: sha256(rawTokenString, utf8). The input here is the exact
// string read from the cookie - not decoded, not trimmed beyond what a
// cookie parser already does.
func HashToken(rawCookieValue string) [32]byte {
	return sha256.Sum256([]byte(rawCookieValue))
}

// Resolve validates a raw session-cookie value and returns the Principal it
// names, or ErrNoSession if the token does not match any live, unrevoked,
// unexpired session. Runs on the Web pool with no tenant context - Layer 0
// work, same as apps/web/src/services/auth.ts's resolveSession.
//
// Reproduces packages/db/src/repositories/sessions.ts's validation query
// verbatim, including which tables are joined and in what order, and its
// two soft-delete checks (app_user.deleted_at, account.deleted_at).
func Resolve(ctx context.Context, pool *pgxpool.Pool, rawCookieValue string) (Principal, error) {
	hash := HashToken(rawCookieValue)

	var p Principal
	err := pool.QueryRow(ctx,
		`SELECT s.id, s.user_id, s.account_id, am.role, s.expires_at
		 FROM user_session s
		 JOIN app_user u ON u.id = s.user_id AND u.deleted_at IS NULL
		 JOIN account a ON a.id = s.account_id AND a.deleted_at IS NULL
		 JOIN account_member am
		   ON am.account_id = s.account_id AND am.user_id = s.user_id
		 WHERE s.token_hash = $1
		   AND s.revoked_at IS NULL
		   AND s.expires_at > now()`,
		hash[:],
	).Scan(&p.SessionID, &p.UserID, &p.AccountID, &p.Role, new(time.Time))

	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Principal{}, ErrNoSession
		}
		return Principal{}, fmt.Errorf("resolving session: %w", err)
	}

	return p, nil
}
