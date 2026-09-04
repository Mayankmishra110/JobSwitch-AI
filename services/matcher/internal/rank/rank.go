// Package rank scores one candidate/posting pair from pre-computed signals.
//
// Pure and DB-free on purpose (ADR: the matching pipeline design) - this is
// the file a reviewer will actually read, and it stays readable only if it
// never has to know where a signal came from.
package rank

// Signals are the per-dimension scores the D-21 pipeline computes before
// calling Score. Each is expected in [0, 1] except Comp, which is a
// pointer specifically so "unknown" (nil) is representable and distinct
// from "known to be zero" - most job_posting_version rows have no
// structured salary (only the Ashby adapter emits one), and a nil comp
// score must never be silently treated as a failing comp floor.
type Signals struct {
	Vector       float64
	Keyword      float64
	SkillOverlap float64
	Seniority    float64
	Location     float64
	Freshness    float64
	// Comp is nil when salary is unknown for this posting. A nil signal is
	// excluded from scoring entirely (see Score) rather than defaulted to
	// any particular number - defaulting it to 0 would penalize every
	// posting that simply didn't disclose a range, and defaulting it to 1
	// would reward the same thing for the opposite reason.
	Comp *float64
}

// Weights determines how much each signal contributes to the total. The
// zero value is not a usable Weights - use DefaultWeights.
type Weights struct {
	Vector    float64
	Keyword   float64
	Skill     float64
	Seniority float64
	Location  float64
	Comp      float64
	Freshness float64
}

// DefaultWeights reflects Phase 5.2's structured-signal-only pipeline:
// Vector and Keyword are weighted here for the shape the schema will need
// once Phase 5.3 populates them, but until then callers pass Signals with
// Vector=Keyword=0 and this function's renormalization (see Score) means
// those two contribute nothing to the total rather than dragging every
// score down by their share of the weight. Nothing about this function
// needs to change when 5.3 starts populating them for real.
func DefaultWeights() Weights {
	return Weights{
		Vector:    0.30,
		Keyword:   0.10,
		Skill:     0.25,
		Seniority: 0.15,
		Location:  0.10,
		Comp:      0.05,
		Freshness: 0.05,
	}
}

// Score combines Signals under Weights into a single [0, 1] total plus a
// per-dimension breakdown (for a match explanation to cite, and for the
// job_match table's own vector_score/keyword_score/... columns).
//
// Weights are renormalized over only the signals actually present, so an
// unknown Comp score (or, before Phase 5.3, an unpopulated Vector/Keyword)
// changes what the total is computed FROM without changing what it means -
// a posting is never penalized for a dimension that could not be evaluated.
func Score(s Signals, w Weights) (total float64, breakdown map[string]float64) {
	type dim struct {
		name   string
		value  float64
		weight float64
		known  bool
	}

	dims := []dim{
		{"vector", s.Vector, w.Vector, true},
		{"keyword", s.Keyword, w.Keyword, true},
		{"skill", s.SkillOverlap, w.Skill, true},
		{"seniority", s.Seniority, w.Seniority, true},
		{"location", s.Location, w.Location, true},
		{"freshness", s.Freshness, w.Freshness, true},
	}
	if s.Comp != nil {
		dims = append(dims, dim{"comp", *s.Comp, w.Comp, true})
	}

	var weightSum float64
	for _, d := range dims {
		if d.known {
			weightSum += d.weight
		}
	}

	breakdown = make(map[string]float64, len(dims))
	if weightSum == 0 {
		// Every weight was zero (a caller-constructed edge case, not a
		// reachable state from DefaultWeights) - report zero rather than
		// dividing by zero.
		for _, d := range dims {
			breakdown[d.name] = 0
		}
		return 0, breakdown
	}

	for _, d := range dims {
		contribution := d.value * (d.weight / weightSum)
		breakdown[d.name] = d.value
		total += contribution
	}

	return total, breakdown
}
