package match

import (
	"testing"
	"time"

	"github.com/mayankmishra110/jobswitch-ai/services/matcher/internal/repo"
)

func textPtr(s string) *string  { return &s }
func int32Ptr(i int32) *int32   { return &i }
func f64Ptr(f float64) *float64 { return &f }

func TestSkillOverlapScore(t *testing.T) {
	desc := textPtr("We use React, TypeScript and Node.js daily. Redux Toolkit for state.")

	cases := []struct {
		name   string
		skills []string
		desc   *string
		want   float64
	}{
		{"no skills listed is neutral, not zero", nil, desc, 0.5},
		{"all skills found", []string{"React", "TypeScript"}, desc, 1.0},
		{"half found", []string{"React", "GraphQL"}, desc, 0.5},
		{"none found", []string{"Rust", "Go"}, desc, 0},
		{"nil description with skills listed scores zero", []string{"React"}, nil, 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := SkillOverlapScore(tc.skills, tc.desc)
			if got != tc.want {
				t.Errorf("SkillOverlapScore(%v, ...) = %v, want %v", tc.skills, got, tc.want)
			}
		})
	}
}

func TestLocationScore(t *testing.T) {
	if got := LocationScore(true); got != 1.0 {
		t.Errorf("LocationScore(true) = %v, want 1.0", got)
	}
	if got := LocationScore(false); got != 0.5 {
		t.Errorf("LocationScore(false) = %v, want 0.5 (no preference is neutral, not a bonus)", got)
	}
}

func TestCompScore(t *testing.T) {
	cases := []struct {
		name       string
		floor      *int32
		postingMax *float64
		wantNil    bool
		want       float64
	}{
		{"unknown floor and unknown posting", nil, nil, true, 0},
		{"unknown floor only", nil, f64Ptr(2000000), true, 0},
		{"unknown posting salary only", int32Ptr(1500000), nil, true, 0},
		{"posting max equals floor", int32Ptr(1500000), f64Ptr(1500000), false, 0},
		{"posting max double the floor caps at 1.0", int32Ptr(1500000), f64Ptr(3000000), false, 1.0},
		{"posting max far above floor still caps at 1.0", int32Ptr(1500000), f64Ptr(10000000), false, 1.0},
		{"posting max 50% above floor", int32Ptr(1000000), f64Ptr(1500000), false, 0.5},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := CompScore(tc.floor, tc.postingMax)
			if tc.wantNil {
				if got != nil {
					t.Errorf("CompScore() = %v, want nil", *got)
				}
				return
			}
			if got == nil {
				t.Fatalf("CompScore() = nil, want %v", tc.want)
			}
			if *got != tc.want {
				t.Errorf("CompScore() = %v, want %v", *got, tc.want)
			}
		})
	}
}

func TestFreshnessScore(t *testing.T) {
	now := time.Now()

	// Posted right now: full freshness.
	if got := FreshnessScore(now, now); got < 0.999 {
		t.Errorf("FreshnessScore(now, now) = %v, want ~1.0", got)
	}

	// Older postings score strictly lower than newer ones.
	newer := FreshnessScore(now.Add(-1*24*time.Hour), now)
	older := FreshnessScore(now.Add(-20*24*time.Hour), now)
	if !(newer > older) {
		t.Errorf("expected newer posting to score higher: newer=%v older=%v", newer, older)
	}

	// A future first_seen_at (clock skew) must not produce a score above 1.
	if got := FreshnessScore(now.Add(1*time.Hour), now); got > 1.0 {
		t.Errorf("FreshnessScore with future timestamp = %v, want <= 1.0", got)
	}
}

func TestHasLocationConstraint(t *testing.T) {
	any := "any"
	remote := "remote"

	cases := []struct {
		name  string
		facts repo.CandidateFacts
		want  bool
	}{
		{"nothing set", repo.CandidateFacts{}, false},
		{"desired locations set", repo.CandidateFacts{DesiredLocations: []string{"Bengaluru"}}, true},
		{"work mode 'any' with no locations is unconstrained", repo.CandidateFacts{DesiredWorkMode: &any}, false},
		{"work mode 'remote' with no locations is still a constraint", repo.CandidateFacts{DesiredWorkMode: &remote}, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := HasLocationConstraint(tc.facts); got != tc.want {
				t.Errorf("HasLocationConstraint() = %v, want %v", got, tc.want)
			}
		})
	}
}
