package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Integration tests against the same real Postgres the TS suite uses -
// this project's standing rule (packages/db's own tests) is no mocks for
// anything RLS or auth touches, and session resolution is exactly that.
//
// Uses the same DATABASE_URL_TEST / DATABASE_URL_TEST_WEB env vars and the
// same app_web_test role the TS suite's rls.test.ts/profile.test.ts create
// idempotently - reproduced here too so this test is runnable standalone.

func adminURL() string {
	if v := os.Getenv("DATABASE_URL_TEST"); v != "" {
		return v
	}
	return "postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test"
}

func webURL() string {
	if v := os.Getenv("DATABASE_URL_TEST_WEB"); v != "" {
		return v
	}
	return "postgres://app_web_test:webpassword@127.0.0.1:5432/jobswitch_test"
}

func setupPools(t *testing.T) (admin, web *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()

	admin, err := pgxpool.New(ctx, adminURL())
	if err != nil {
		t.Fatalf("connecting admin pool: %v", err)
	}
	t.Cleanup(admin.Close)

	_, err = admin.Exec(ctx, `
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_web_test') THEN
				CREATE ROLE app_web_test LOGIN PASSWORD 'webpassword';
			END IF;
		END
		$$;
	`)
	if err != nil {
		t.Fatalf("ensuring app_web_test role: %v", err)
	}
	if _, err := admin.Exec(ctx, "GRANT app_web TO app_web_test"); err != nil {
		t.Fatalf("granting app_web to app_web_test: %v", err)
	}

	web, err = pgxpool.New(ctx, webURL())
	if err != nil {
		t.Fatalf("connecting web pool: %v", err)
	}
	t.Cleanup(web.Close)

	return admin, web
}

// seedSession inserts a real account/app_user/account_member/user_session
// row set, using the exact column shape packages/db/src/repositories/
// sessions.ts's createSession inserts (user_id, account_id, token_hash,
// expires_at) - so this is a faithful stand-in for a session apps/web
// actually issued, not a simplified fixture.
func seedSession(t *testing.T, ctx context.Context, admin *pgxpool.Pool, opts struct {
	revoked bool
	expired bool
	role    string
}) (rawToken string, accountID string, userID string) {
	t.Helper()

	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		t.Fatalf("generating raw token: %v", err)
	}
	rawToken = base64.RawURLEncoding.EncodeToString(raw)
	hash := HashToken(rawToken)

	suffix := base64.RawURLEncoding.EncodeToString(raw)[:8]
	email := "session-it-" + suffix + "@example.com"

	if err := admin.QueryRow(ctx,
		`INSERT INTO account (type) VALUES ('personal') RETURNING id`,
	).Scan(&accountID); err != nil {
		t.Fatalf("inserting account: %v", err)
	}
	if err := admin.QueryRow(ctx,
		`INSERT INTO app_user (email, email_normalized) VALUES ($1, $1) RETURNING id`,
		email,
	).Scan(&userID); err != nil {
		t.Fatalf("inserting app_user: %v", err)
	}
	role := opts.role
	if role == "" {
		role = "owner"
	}
	if _, err := admin.Exec(ctx,
		`INSERT INTO account_member (account_id, user_id, role) VALUES ($1, $2, $3)`,
		accountID, userID, role,
	); err != nil {
		t.Fatalf("inserting account_member: %v", err)
	}

	expiresAt := time.Now().Add(14 * 24 * time.Hour)
	if opts.expired {
		expiresAt = time.Now().Add(-1 * time.Hour)
	}

	var revokedAt any
	if opts.revoked {
		revokedAt = time.Now()
	}

	if _, err := admin.Exec(ctx,
		`INSERT INTO user_session (user_id, account_id, token_hash, expires_at, revoked_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		userID, accountID, hash[:], expiresAt, revokedAt,
	); err != nil {
		t.Fatalf("inserting user_session: %v", err)
	}

	return rawToken, accountID, userID
}

func TestResolveValidSession(t *testing.T) {
	admin, web := setupPools(t)
	ctx := context.Background()

	raw, accountID, userID := seedSession(t, ctx, admin, struct {
		revoked bool
		expired bool
		role    string
	}{role: "admin"})

	principal, err := Resolve(ctx, web, raw)
	if err != nil {
		t.Fatalf("Resolve returned error for a valid session: %v", err)
	}
	if principal.AccountID != accountID {
		t.Errorf("AccountID = %q, want %q", principal.AccountID, accountID)
	}
	if principal.UserID != userID {
		t.Errorf("UserID = %q, want %q", principal.UserID, userID)
	}
	if principal.Role != RoleAdmin {
		t.Errorf("Role = %q, want %q", principal.Role, RoleAdmin)
	}
}

func TestResolveRevokedSession(t *testing.T) {
	admin, web := setupPools(t)
	ctx := context.Background()

	raw, _, _ := seedSession(t, ctx, admin, struct {
		revoked bool
		expired bool
		role    string
	}{revoked: true})

	_, err := Resolve(ctx, web, raw)
	if !errors.Is(err, ErrNoSession) {
		t.Errorf("Resolve on a revoked session: got err=%v, want ErrNoSession", err)
	}
}

func TestResolveExpiredSession(t *testing.T) {
	admin, web := setupPools(t)
	ctx := context.Background()

	raw, _, _ := seedSession(t, ctx, admin, struct {
		revoked bool
		expired bool
		role    string
	}{expired: true})

	_, err := Resolve(ctx, web, raw)
	if !errors.Is(err, ErrNoSession) {
		t.Errorf("Resolve on an expired session: got err=%v, want ErrNoSession", err)
	}
}

func TestResolveUnknownToken(t *testing.T) {
	_, web := setupPools(t)
	ctx := context.Background()

	_, err := Resolve(ctx, web, "this-token-was-never-issued-by-anyone")
	if !errors.Is(err, ErrNoSession) {
		t.Errorf("Resolve on an unknown token: got err=%v, want ErrNoSession", err)
	}
}

// TestResolveRoleIsLiveNotCached is the property packages/db/src/
// repositories/sessions.ts's own comment calls out explicitly: a
// membership role change must take effect on the very next request, because
// role is joined from account_member on every call rather than stored on
// the session row itself.
func TestResolveRoleIsLiveNotCached(t *testing.T) {
	admin, web := setupPools(t)
	ctx := context.Background()

	raw, accountID, userID := seedSession(t, ctx, admin, struct {
		revoked bool
		expired bool
		role    string
	}{role: "member"})

	first, err := Resolve(ctx, web, raw)
	if err != nil {
		t.Fatalf("first Resolve: %v", err)
	}
	if first.Role != RoleMember {
		t.Fatalf("first Role = %q, want %q", first.Role, RoleMember)
	}

	if _, err := admin.Exec(ctx,
		`UPDATE account_member SET role = 'owner' WHERE account_id = $1 AND user_id = $2`,
		accountID, userID,
	); err != nil {
		t.Fatalf("updating role: %v", err)
	}

	second, err := Resolve(ctx, web, raw)
	if err != nil {
		t.Fatalf("second Resolve: %v", err)
	}
	if second.Role != RoleOwner {
		t.Errorf("second Role = %q, want %q (role change did not take effect live)", second.Role, RoleOwner)
	}
}
