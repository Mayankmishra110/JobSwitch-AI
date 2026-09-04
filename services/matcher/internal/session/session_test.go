package session

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type tokenPair struct {
	RawToken  string `json:"rawToken"`
	SHA256Hex string `json:"sha256Hex"`
}

// loadFixture reads the same fixture packages/db/test/sessionTokenParity.test.ts
// asserts against. Both suites reading one committed file is the point -
// if the fixture ever needs regenerating, both languages regenerate
// against the same new values, and a real algorithm mismatch between them
// fails loudly here rather than showing up as a session that mysteriously
// does not resolve in production.
func loadFixture(t *testing.T) []tokenPair {
	t.Helper()

	// services/matcher/internal/session -> repo root is five levels up.
	path := filepath.Join("..", "..", "..", "..", "packages", "db", "test", "fixtures", "session-tokens.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading fixture at %s: %v", path, err)
	}

	var pairs []tokenPair
	if err := json.Unmarshal(data, &pairs); err != nil {
		t.Fatalf("parsing fixture: %v", err)
	}
	if len(pairs) == 0 {
		t.Fatal("fixture is empty")
	}
	return pairs
}

func TestHashTokenMatchesTypeScriptFixture(t *testing.T) {
	pairs := loadFixture(t)

	for i, p := range pairs {
		got := HashToken(p.RawToken)
		gotHex := hex.EncodeToString(got[:])
		if gotHex != p.SHA256Hex {
			t.Errorf("fixture[%d]: HashToken(%q) = %s, want %s", i, p.RawToken, gotHex, p.SHA256Hex)
		}
	}
}
