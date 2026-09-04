package rank

import (
	"math"
	"testing"
)

func approxEqual(a, b float64) bool {
	return math.Abs(a-b) < 1e-9
}

func TestScore(t *testing.T) {
	cases := []struct {
		name    string
		signals Signals
		weights Weights
		want    float64
	}{
		{
			name: "all signals perfect scores one",
			signals: Signals{
				Vector: 1, Keyword: 1, SkillOverlap: 1, Seniority: 1,
				Location: 1, Freshness: 1, Comp: ptr(1.0),
			},
			weights: DefaultWeights(),
			want:    1,
		},
		{
			name: "all signals zero scores zero",
			signals: Signals{
				Vector: 0, Keyword: 0, SkillOverlap: 0, Seniority: 0,
				Location: 0, Freshness: 0, Comp: ptr(0.0),
			},
			weights: DefaultWeights(),
			want:    0,
		},
		{
			name: "a nil Comp is excluded from the weighted average, not treated as zero",
			signals: Signals{
				Vector: 1, Keyword: 1, SkillOverlap: 1, Seniority: 1,
				Location: 1, Freshness: 1, Comp: nil,
			},
			weights: DefaultWeights(),
			// Every present signal is 1 and Comp is excluded, so the
			// remaining weights renormalize to sum to 1 and the total is
			// still 1 - a missing salary must not drag the score down.
			want: 1,
		},
		{
			name: "before Phase 5.3, Vector and Keyword are always 0 and must not sink the score",
			signals: Signals{
				Vector: 0, Keyword: 0, SkillOverlap: 1, Seniority: 1,
				Location: 1, Freshness: 1, Comp: nil,
			},
			weights: DefaultWeights(),
			// Vector/Keyword being genuinely 0 (not unknown - a real,
			// evaluated zero) DOES count against the score under current
			// weights, unlike a nil signal. This is the documented,
			// deliberate difference: Phase 5.2 callers must not pass 0 for
			// "not yet computed" if they want it excluded - only a nil
			// pointer excludes a dimension. Vector/Keyword have no pointer
			// form, so Phase 5.2's matching pipeline is expected to use a
			// reduced Weights (see the "structured-only weights" case
			// below), not this default, until 5.3 wires vector/keyword.
			//
			// Comp is nil, so both its value AND its 0.05 weight are
			// excluded - the surviving weights (0.30+0.10+0.25+0.15+0.10+0.05)
			// sum to 0.95, not 1.0, so the total renormalizes over that.
			want: 0.55 / 0.95, // (0*0.30 + 0*0.10 + 1*0.25 + 1*0.15 + 1*0.10 + 1*0.05) / 0.95
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, breakdown := Score(tc.signals, tc.weights)
			if !approxEqual(got, tc.want) {
				t.Errorf("Score() = %v, want %v (breakdown: %+v)", got, tc.want, breakdown)
			}
		})
	}
}

// TestScoreStructuredOnlyWeights is the Phase 5.2 case: a Weights value
// with Vector and Keyword excluded entirely (weight 0), which - combined
// with the renormalization in Score - means they never dilute the total
// even though every Signals value in this phase carries them as 0.
func TestScoreStructuredOnlyWeights(t *testing.T) {
	structuredOnly := Weights{
		Vector: 0, Keyword: 0,
		Skill: 0.4, Seniority: 0.3, Location: 0.2, Comp: 0.05, Freshness: 0.05,
	}
	signals := Signals{
		Vector: 0, Keyword: 0, // never computed yet, Phase 5.2
		SkillOverlap: 1, Seniority: 1, Location: 1, Freshness: 1, Comp: nil,
	}

	got, _ := Score(signals, structuredOnly)
	if !approxEqual(got, 1) {
		t.Errorf("Score() with structured-only weights = %v, want 1", got)
	}
}

func TestScoreBreakdownReportsRawSignalValues(t *testing.T) {
	signals := Signals{
		Vector: 0.5, Keyword: 0.6, SkillOverlap: 0.7, Seniority: 0.8,
		Location: 0.9, Freshness: 1.0, Comp: ptr(0.3),
	}
	_, breakdown := Score(signals, DefaultWeights())

	want := map[string]float64{
		"vector": 0.5, "keyword": 0.6, "skill": 0.7, "seniority": 0.8,
		"location": 0.9, "freshness": 1.0, "comp": 0.3,
	}
	for name, wantVal := range want {
		if got := breakdown[name]; !approxEqual(got, wantVal) {
			t.Errorf("breakdown[%q] = %v, want %v", name, got, wantVal)
		}
	}
}

func TestScoreIsWithinUnitRange(t *testing.T) {
	// A property test in spirit: no combination of in-range signals should
	// ever produce a total outside [0, 1], since weights always renormalize
	// to sum to 1 over the signals present.
	signals := Signals{
		Vector: 0.9, Keyword: 0.1, SkillOverlap: 1, Seniority: 0,
		Location: 0.5, Freshness: 0.3, Comp: ptr(0.7),
	}
	got, _ := Score(signals, DefaultWeights())
	if got < 0 || got > 1 {
		t.Errorf("Score() = %v, want a value in [0, 1]", got)
	}
}

func ptr(f float64) *float64 { return &f }
