// Package db provides the matcher's two Postgres connection pools.
//
// Two pools, not one, and this is deliberate rather than incidental
// (mirrors the TS side's packages/db/src/context.ts split):
//
//   - Web:     connects as a login role granted app_web. RLS-enforced.
//     Every request-path query goes through WithAccount, which
//     sets app.current_account_id as the first statement of the
//     transaction - exactly like packages/db/src/context.ts's
//     withAccount.
//   - Matcher: connects as a login role granted app_matcher, which holds
//     BYPASSRLS (migration 0001). Used ONLY by the batch worker's
//     per-account loop (ADR D-13). BYPASSRLS makes set_config
//     decorative for this role, so tenant isolation here is a
//     property of the SQL itself (an explicit WHERE account_id = $1
//     on every query), not of RLS - see internal/repo.
//
// Mixing both privileges into one pooled role via SET ROLE was considered
// and rejected: BYPASSRLS is a role *attribute*, not something inherited
// through GRANT membership, so a shared pool would make it easy to run a
// Matcher-privileged query by accident on a connection meant for Web. Two
// separate pgxpool.Pool values make that class of mistake a compile-time
// question ("which pool did I pass in") instead of a runtime one.
package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Pools struct {
	Web     *pgxpool.Pool
	Matcher *pgxpool.Pool
}

func NewPools(ctx context.Context, webURL, matcherURL string) (*Pools, error) {
	web, err := pgxpool.New(ctx, webURL)
	if err != nil {
		return nil, fmt.Errorf("connecting web pool: %w", err)
	}

	matcher, err := pgxpool.New(ctx, matcherURL)
	if err != nil {
		web.Close()
		return nil, fmt.Errorf("connecting matcher pool: %w", err)
	}

	return &Pools{Web: web, Matcher: matcher}, nil
}

func (p *Pools) Close() {
	if p.Web != nil {
		p.Web.Close()
	}
	if p.Matcher != nil {
		p.Matcher.Close()
	}
}
