// Package config loads and validates environment configuration.
//
// Mirrors apps/web/src/config.ts's own rule: the process refuses to start on
// invalid config rather than failing on the first request that needed it.
// Two database URLs are required, not one, because the matcher holds two
// distinct roles for two distinct reasons - see internal/db's doc comment.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	// DATABASE_URL - a login role granted app_web. RLS-enforced. Used for
	// every request-path query and for session validation, exactly like
	// apps/web's own connection.
	DatabaseURL string

	// DATABASE_URL_MATCHER - a login role granted app_matcher, which holds
	// BYPASSRLS (migration 0001). Used ONLY by cmd/worker's per-account
	// batch loop (ADR D-13) - never by cmd/api, and never for anything that
	// skips an explicit account_id filter. See internal/db.
	DatabaseURLMatcher string

	// SessionCookieName must match apps/web/src/config.ts's
	// SESSION_COOKIE_NAME default exactly, or a session issued by the web
	// process is invisible to this one.
	SessionCookieName string

	Port int

	// InternalToken authenticates calls between services on the internal
	// network (services/ai, apps/tailor) once they exist. Optional for now
	// - Phase 5.2 has no internal caller yet.
	InternalToken string

	// MatchTickInterval - how often cmd/worker's scheduled-tasks loop runs:
	// compute matches for every active job search, then sweep dormant ones
	// (specs/ephemeral-retention.md's safety net). Mirrors
	// apps/scheduler's own SCHEDULER_TICK_MS, but doesn't need that
	// process's sub-minute precision - matching is naturally a coarser,
	// more expensive operation. Optional, defaults to 5 minutes.
	MatchTickInterval time.Duration

	// DormantSessionStaleDays - job_search_session.started_at age past
	// which an active session is swept. Optional, defaults to 90 -
	// docs/BUILD_PLAN.md's own number for the scheduled sweep.
	DormantSessionStaleDays int

	// NatsURL - D-26's event bus. Optional: cmd/main.go treats a failed
	// connection as a warning, not a startup failure (events.Publisher's
	// nil-safety means match.RunForAccount degrades to "no live UI push"
	// rather than "matcher-worker won't start"). Mirrors apps/web's own
	// NATS_URL default so both sides of one docker-compose need no
	// per-service override.
	NatsURL string
}

func envOr(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func requireEnv(key string) (string, error) {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return "", fmt.Errorf("%s is required", key)
	}
	return v, nil
}

// Load reads and validates configuration from the process environment.
// Returns every missing/invalid variable at once rather than the first one
// found, so a misconfigured deploy is diagnosable from a single error
// rather than a fix-one-restart-repeat loop.
func Load() (Config, error) {
	var errs []error
	cfg := Config{}

	dbURL, err := requireEnv("DATABASE_URL")
	if err != nil {
		errs = append(errs, err)
	}
	cfg.DatabaseURL = dbURL

	dbURLMatcher, err := requireEnv("DATABASE_URL_MATCHER")
	if err != nil {
		errs = append(errs, err)
	}
	cfg.DatabaseURLMatcher = dbURLMatcher

	cfg.SessionCookieName = envOr("SESSION_COOKIE_NAME", "js_session")
	cfg.InternalToken = envOr("INTERNAL_TOKEN", "")

	portStr := envOr("PORT", "8080")
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		errs = append(errs, fmt.Errorf("PORT must be an integer in 1..65535, got %q", portStr))
	}
	cfg.Port = port

	tickMsStr := envOr("MATCH_TICK_MS", "300000")
	tickMs, err := strconv.Atoi(tickMsStr)
	if err != nil || tickMs < 1 {
		errs = append(errs, fmt.Errorf("MATCH_TICK_MS must be a positive integer, got %q", tickMsStr))
	}
	cfg.MatchTickInterval = time.Duration(tickMs) * time.Millisecond

	staleDaysStr := envOr("DORMANT_SESSION_STALE_DAYS", "90")
	staleDays, err := strconv.Atoi(staleDaysStr)
	if err != nil || staleDays < 1 {
		errs = append(errs, fmt.Errorf("DORMANT_SESSION_STALE_DAYS must be a positive integer, got %q", staleDaysStr))
	}
	cfg.DormantSessionStaleDays = staleDays

	cfg.NatsURL = envOr("NATS_URL", "nats://127.0.0.1:4222")

	if len(errs) > 0 {
		msg := "invalid environment configuration:"
		for _, e := range errs {
			msg += "\n  " + e.Error()
		}
		return Config{}, fmt.Errorf("%s", msg)
	}

	return cfg, nil
}
