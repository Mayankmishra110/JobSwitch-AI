package match

import (
	"os"
	"testing"

	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/testutil"
)

// TestMain serializes this package's tests against every other package
// that also touches the shared test Postgres - see
// internal/testutil.WithSerializedDBAccess's doc comment for why.
func TestMain(m *testing.M) {
	os.Exit(testutil.WithSerializedDBAccess(m))
}
