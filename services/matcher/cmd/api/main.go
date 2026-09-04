// Command api is the matcher's HTTP entrypoint - one of three subcommands
// sharing the module's internal packages (api/worker/mcp), mirroring the
// existing TS side's "one image, three entrypoints" pattern (apps/web,
// apps/worker, apps/scheduler) rather than inventing a new shape for Go.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/mayankmishra110/jobswitch-ai/services/matcher/internal/config"
	"github.com/mayankmishra110/jobswitch-ai/services/matcher/internal/db"
	"github.com/mayankmishra110/jobswitch-ai/services/matcher/internal/httpx"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pools, err := db.NewPools(ctx, cfg.DatabaseURL, cfg.DatabaseURLMatcher)
	if err != nil {
		logger.Error("connecting to postgres", "err", err)
		os.Exit(1)
	}
	defer pools.Close()

	mux := http.NewServeMux()

	// Liveness: touches nothing, same reasoning as apps/web's own /healthz -
	// a database blip should not get a healthy process killed.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// Readiness: checks both pools can actually be reached. Deliberately
	// does NOT replicate apps/web's pending-migrations check - migration
	// state is TS's schema_migration table and TS's own concern
	// (packages/db/src/migrate.ts); this service reads a schema that
	// process is responsible for keeping current, and re-deriving pending-
	// migration logic here would be a second, driftable copy of that logic
	// for no benefit this service needs.
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		webErr := pools.Web.Ping(r.Context())
		matcherErr := pools.Matcher.Ping(r.Context())
		if webErr != nil || matcherErr != nil {
			logger.Error("readiness check failed", "webErr", webErr, "matcherErr", matcherErr)
			httpx.JSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// A temporary smoke-test route, not a product endpoint: it exists to
	// prove the full session chain (cookie -> Resolve -> Principal) works
	// end to end against a real deploy, and is meant to be replaced by the
	// first real authenticated route (GET /api/v1/matches) rather than
	// grown into one.
	mux.HandleFunc("GET /api/v1/_internal/whoami", httpx.RequireAuth(
		pools.Web, cfg.SessionCookieName,
		func(w http.ResponseWriter, r *http.Request) {
			principal, ok := httpx.PrincipalFromContext(r.Context())
			if !ok {
				httpx.Internal(w)
				return
			}
			httpx.JSON(w, http.StatusOK, map[string]any{
				"userId":    principal.UserID,
				"accountId": principal.AccountID,
				"role":      principal.Role,
				"sessionId": principal.SessionID,
			})
		},
	))

	addr := ":" + strconv.Itoa(cfg.Port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("matcher api listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "err", err)
	}
}
