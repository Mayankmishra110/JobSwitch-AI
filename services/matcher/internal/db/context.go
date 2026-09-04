package db

import (
	"context"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// uuidRe mirrors packages/core/src/ids.ts's isUuid - a second barrier before
// interpolating an account id into the tenant context, even though
// set_config is always called with a bound parameter, never string
// concatenation.
var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func IsUUID(s string) bool {
	return uuidRe.MatchString(s)
}

// WithAccount runs fn inside a transaction scoped to one tenant, on the Web
// pool. Mirrors packages/db/src/context.ts's withAccount exactly:
// SELECT set_config('app.current_account_id', $1, true) as the transaction's
// first statement. The third argument (true) is is_local - equivalent to
// SET LOCAL - so the setting is released automatically at COMMIT/ROLLBACK
// and never leaks to whichever request the pooled connection serves next.
//
// This is the only sanctioned way for request-path code to touch a
// tenant-scoped table through the Web pool. There is no compiler
// enforcement of that rule here, same as the TS side - it is a code-review
// convention, not a type-level one.
func WithAccount[T any](
	ctx context.Context,
	pool *pgxpool.Pool,
	accountID string,
	fn func(context.Context, pgx.Tx) (T, error),
) (T, error) {
	var zero T
	if !IsUUID(accountID) {
		return zero, fmt.Errorf("WithAccount requires a UUID account id, got %q", accountID)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return zero, fmt.Errorf("beginning transaction: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op if already committed

	if _, err := tx.Exec(ctx, "SELECT set_config('app.current_account_id', $1, true)", accountID); err != nil {
		return zero, fmt.Errorf("setting tenant context: %w", err)
	}

	result, err := fn(ctx, tx)
	if err != nil {
		return zero, err
	}

	if err := tx.Commit(ctx); err != nil {
		return zero, fmt.Errorf("committing transaction: %w", err)
	}

	return result, nil
}

// WithoutTenantContext runs fn in a plain transaction with no tenant
// context set - legitimate only for Layer 0 work (session validation),
// which by definition happens before an account is known. Named
// explicitly, mirroring packages/db/src/context.ts's own function of the
// same name and rationale: reaching for this in request-path tenant-data
// code is a bug, and the name is meant to make that a visible decision
// rather than an accident.
func WithoutTenantContext[T any](
	ctx context.Context,
	pool *pgxpool.Pool,
	fn func(context.Context, pgx.Tx) (T, error),
) (T, error) {
	var zero T
	tx, err := pool.Begin(ctx)
	if err != nil {
		return zero, fmt.Errorf("beginning transaction: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	result, err := fn(ctx, tx)
	if err != nil {
		return zero, err
	}

	if err := tx.Commit(ctx); err != nil {
		return zero, fmt.Errorf("committing transaction: %w", err)
	}

	return result, nil
}
