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

	if len(errs) > 0 {
		msg := "invalid environment configuration:"
		for _, e := range errs {
			msg += "\n  " + e.Error()
		}
		return Config{}, fmt.Errorf("%s", msg)
	}

	return cfg, nil
}
