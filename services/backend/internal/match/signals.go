package match

import (
	"math"
	"strings"
	"time"

	"github.com/mayankmishra110/jobswitch-ai/services/backend/internal/repo"
)

// SkillOverlapScore is the fraction of the candidate's listed skills found
// (case-insensitive substring match) in the posting's description text.
//
// No skills listed scores 0.5 (neutral/unknown), not 0 - a candidate who
// hasn't filled in skills yet should not have every posting read as a
// skill mismatch; that would be scoring an empty profile, not a bad fit.
// A real semantic overlap (skill synonyms, related technologies) is
// Phase 5.3's embedding territory - this is deliberately literal.
func SkillOverlapScore(skills []string, descriptionText *string) float64 {
	if len(skills) == 0 {
		return 0.5
	}
	if descriptionText == nil || *descriptionText == "" {
		return 0
	}

	lowerText := strings.ToLower(*descriptionText)
	matched := 0
	for _, s := range skills {
		if strings.Contains(lowerText, strings.ToLower(s)) {
			matched++
		}
	}
	return float64(matched) / float64(len(skills))
}

// LocationScore is deliberately coarse in Phase 5.2: every candidate
// posting has already passed Stage 1's location/work-mode hard filter (see
// repo.PrefilterCandidates), so a survivor's location constraint - if the
// candidate specified one - is already known to be satisfied. Scoring it
// again as anything but "satisfied" would be re-deriving a fact the SQL
// already established, not adding information.
//
// A candidate with NO location preference at all scores 0.5 (this
// dimension carries no signal for them, not "perfectly satisfied") rather
// than 1.0, so it doesn't inflate their score relative to someone whose
// stated preference was actually matched. A genuinely differentiated
// signal (exact city vs. remote-as-fallback vs. same metro) is real future
// work once Stage 2 gives the ranking pipeline more than a pass/fail
// filter to work from.
func LocationScore(hasLocationPreference bool) float64 {
	if hasLocationPreference {
		return 1.0
	}
	return 0.5
}

// CompScore compares a posting's disclosed salary ceiling against the
// candidate's stated floor. Returns nil - not zero - whenever either side
// is unknown, matching rank.Signals.Comp's own contract: an undisclosed
// range must never be silently scored as a failing one.
//
// The formula rewards headroom above the floor, capped at 1.0 once the
// posting's max reaches 2x the floor - simple and monotonic, not a
// precision instrument. Real comp-band modeling (currency conversion,
// percentile normalization) is out of scope for a structured-only phase.
func CompScore(desiredSalaryMin *int32, postingSalaryMax *float64) *float64 {
	if desiredSalaryMin == nil || postingSalaryMax == nil {
		return nil
	}
	floor := float64(*desiredSalaryMin)
	if floor <= 0 {
		return nil
	}

	ratio := (*postingSalaryMax - floor) / floor
	score := math.Max(0, math.Min(1, ratio))
	return &score
}

// FreshnessScore decays a posting's relevance by how long it's been open,
// per the plan's own formula: exp(-daysSinceFirstSeen / 14) - a two-week
// half-life-ish falloff, favoring recently-posted roles without hard-
// excluding older ones the way Stage 1's 30-day cutoff already does.
func FreshnessScore(firstSeenAt time.Time, now time.Time) float64 {
	days := now.Sub(firstSeenAt).Hours() / 24
	if days < 0 {
		days = 0
	}
	return math.Exp(-days / 14)
}

// HasLocationConstraint reports whether these facts impose any location
// filter at all - mirrors repo.PrefilterCandidates's own "skip filtering
// entirely" condition exactly, so LocationScore's input agrees with what
// the SQL actually enforced.
func HasLocationConstraint(facts repo.CandidateFacts) bool {
	if len(facts.DesiredLocations) > 0 {
		return true
	}
	return facts.DesiredWorkMode != nil && *facts.DesiredWorkMode != "any"
}
