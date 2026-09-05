package match

import "testing"

func strPtr(s string) *string { return &s }

func TestDetectLevel(t *testing.T) {
	cases := []struct {
		text string
		want *string
	}{
		{"Senior Staff Engineer", strPtr("staff")}, // staff wins over senior, matching normalize.ts's priority
		{"Backend Engineer", nil},
		{"Frontend Engineering Intern", strPtr("intern")},
		{"Principal Engineer", strPtr("principal")},
		{"Engineering Manager", strPtr("manager")},
		{"Jr. Software Developer", strPtr("junior")},
	}

	for _, tc := range cases {
		t.Run(tc.text, func(t *testing.T) {
			got := DetectLevel(tc.text)
			if (got == nil) != (tc.want == nil) {
				t.Fatalf("DetectLevel(%q) = %v, want %v", tc.text, got, tc.want)
			}
			if got != nil && *got != *tc.want {
				t.Errorf("DetectLevel(%q) = %q, want %q", tc.text, *got, *tc.want)
			}
		})
	}
}

func TestCandidateLevelPrefersCurrentTitleOverDesired(t *testing.T) {
	current := "Staff Engineer"
	desired := []string{"Senior Product Manager"}

	got := CandidateLevel(&current, desired)
	if got == nil || *got != "staff" {
		t.Errorf("CandidateLevel() = %v, want staff (from current title)", got)
	}
}

func TestCandidateLevelFallsBackToDesiredTitles(t *testing.T) {
	got := CandidateLevel(nil, []string{"Junior Developer", "QA Intern"})
	if got == nil || *got != "junior" {
		t.Errorf("CandidateLevel() = %v, want junior (first desired title to match)", got)
	}
}

func TestCandidateLevelUnknownWhenNothingMatches(t *testing.T) {
	current := "Backend Engineer"
	got := CandidateLevel(&current, []string{"Backend Developer"})
	if got != nil {
		t.Errorf("CandidateLevel() = %v, want nil", got)
	}
}

func TestSeniorityScore(t *testing.T) {
	senior := "senior"
	staff := "staff"
	intern := "intern"

	cases := []struct {
		name      string
		candidate *string
		posting   *string
		wantScore float64
	}{
		{"exact match", &senior, &senior, 1.0},
		{"adjacent (senior vs staff)", &senior, &staff, 0.6},
		{"far apart (intern vs staff)", &intern, &staff, 0.2},
		{"candidate unknown", nil, &staff, 0.5},
		{"posting unknown", &senior, nil, 0.5},
		{"both unknown", nil, nil, 0.5},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := SeniorityScore(tc.candidate, tc.posting)
			if got != tc.wantScore {
				t.Errorf("SeniorityScore(%v, %v) = %v, want %v", tc.candidate, tc.posting, got, tc.wantScore)
			}
		})
	}
}
