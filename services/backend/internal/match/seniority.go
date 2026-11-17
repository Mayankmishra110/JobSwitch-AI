package match

import "regexp"

// seniorityPattern mirrors packages/ingest/src/normalize.ts's
// SENIORITY_PATTERNS exactly - same words, same priority order (most
// specific/senior first, so "Senior Staff Engineer" reads as staff, not
// senior). job_posting.seniority is already populated by that TS code
// during ingestion; this is only for deriving the CANDIDATE's implied
// level from free text (current_title, desired_titles), so both sides of
// a comparison come from the same vocabulary.
type seniorityPattern struct {
	level string
	re    *regexp.Regexp
}

var seniorityPatterns = []seniorityPattern{
	{"intern", regexp.MustCompile(`(?i)\b(intern|internship|trainee)\b`)},
	{"entry", regexp.MustCompile(`(?i)\b(graduate|entry[- ]level|fresher|associate)\b`)},
	{"principal", regexp.MustCompile(`(?i)\b(principal|distinguished|fellow)\b`)},
	{"staff", regexp.MustCompile(`(?i)\bstaff\b`)},
	{"lead", regexp.MustCompile(`(?i)\b(lead|tech lead|team lead)\b`)},
	{"manager", regexp.MustCompile(`(?i)\b(manager|head of|director|vp|vice president)\b`)},
	{"senior", regexp.MustCompile(`(?i)\b(senior|sr\.?|snr)\b`)},
	{"junior", regexp.MustCompile(`(?i)\b(junior|jr\.?)\b`)},
}

// seniorityRank orders levels from least to most senior for adjacency
// comparison. "manager" sits alongside "lead"/"staff" deliberately - it is
// a track change (people management), not strictly above the IC ladder,
// and treating it as senior-adjacent rather than principal-adjacent is the
// more honest approximation for a comp/scope-based comparison.
var seniorityRank = map[string]int{
	"intern": 0, "entry": 1, "junior": 1,
	"senior": 3, "lead": 4, "staff": 4, "manager": 4,
	"principal": 5,
}

// DetectLevel finds the first (highest-priority) seniority word in text,
// or nil if none matches - "no detectable level," not "mid-level." There
// is no explicit "mid" pattern in this list, mirroring the TS side: an
// unmatched title is unknown, not assumed average.
func DetectLevel(text string) *string {
	for _, p := range seniorityPatterns {
		if p.re.MatchString(text) {
			level := p.level
			return &level
		}
	}
	return nil
}

// CandidateLevel derives the candidate's implied seniority from whichever
// of current title / desired titles yields a match first, preferring
// current title (a stated fact about where they are now) over desired
// titles (a stated search preference) when both are present and disagree.
func CandidateLevel(currentTitle *string, desiredTitles []string) *string {
	if currentTitle != nil {
		if lvl := DetectLevel(*currentTitle); lvl != nil {
			return lvl
		}
	}
	for _, t := range desiredTitles {
		if lvl := DetectLevel(t); lvl != nil {
			return lvl
		}
	}
	return nil
}

// SeniorityScore compares a candidate's implied level against a posting's
// (already-detected, at ingestion time) level. Either side unknown scores
// neutral (0.5) rather than guessing - an unknown is not evidence of a
// mismatch.
func SeniorityScore(candidateLevel, postingLevel *string) float64 {
	if candidateLevel == nil || postingLevel == nil {
		return 0.5
	}
	if *candidateLevel == *postingLevel {
		return 1.0
	}

	cRank, cOK := seniorityRank[*candidateLevel]
	pRank, pOK := seniorityRank[*postingLevel]
	if !cOK || !pOK {
		return 0.5
	}

	diff := cRank - pRank
	if diff < 0 {
		diff = -diff
	}
	if diff <= 1 {
		return 0.6
	}
	return 0.2
}
