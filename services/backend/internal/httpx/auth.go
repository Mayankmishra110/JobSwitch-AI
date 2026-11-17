package httpx

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/session"
)

type principalKey struct{}

// PrincipalFromContext retrieves the authenticated principal a handler
// wrapped in RequireAuth can rely on being present.
func PrincipalFromContext(ctx context.Context) (session.Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(session.Principal)
	return p, ok
}

// RequireAuth mirrors apps/web/src/server.ts's requireAuth: reads the same
// js_session cookie, resolves it against the Web pool, and returns 401 JSON
// on any failure - never a redirect, since this service has no pages. On
// success the resolved Principal is attached to the request context for
// the wrapped handler to read via PrincipalFromContext.
func RequireAuth(webPool *pgxpool.Pool, cookieName string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(cookieName)
		if err != nil || cookie.Value == "" {
			Unauthenticated(w)
			return
		}

		principal, err := session.Resolve(r.Context(), webPool, cookie.Value)
		if err != nil {
			if !errors.Is(err, session.ErrNoSession) {
				// A real DB/query failure, not "no such session" - worth a
				// log line, still answers 401 to the caller either way,
				// same as apps/web's own hook never throwing on a lookup
				// failure.
				slog.Error("session resolution failed", "err", err)
			}
			Unauthenticated(w)
			return
		}

		ctx := context.WithValue(r.Context(), principalKey{}, principal)
		next(w, r.WithContext(ctx))
	}
}
