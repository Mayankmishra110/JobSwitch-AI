import { createHash } from 'node:crypto';

/**
 * Shared normalization used by every adapter.
 *
 * Deliberately deterministic and boring. These functions decide job identity,
 * grouping candidacy and (in Phase 5) hard-filter outcomes, so they must
 * produce the same answer for the same input forever - no clock, no locale, no
 * model.
 */

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const SENIORITY_PATTERNS: Array<{ level: string; re: RegExp }> = [
  { level: 'intern', re: /\b(intern|internship|trainee)\b/i },
  { level: 'entry', re: /\b(graduate|entry[- ]level|fresher|associate)\b/i },
  { level: 'principal', re: /\b(principal|distinguished|fellow)\b/i },
  { level: 'staff', re: /\b(staff)\b/i },
  { level: 'lead', re: /\b(lead|tech lead|team lead)\b/i },
  { level: 'manager', re: /\b(manager|head of|director|vp|vice president)\b/i },
  { level: 'senior', re: /\b(senior|sr\.?|snr)\b/i },
  { level: 'junior', re: /\b(junior|jr\.?)\b/i },
];

/**
 * Order matters: "Senior Staff Engineer" must read as staff, not senior, so
 * the more senior patterns are tested first.
 */
export function detectSeniority(title: string): string | null {
  for (const { level, re } of SENIORITY_PATTERNS) {
    if (re.test(title)) return level;
  }
  return null;
}

const TITLE_NOISE = [
  /\(.*?\)/g, // "(Remote)", "(f/m/d)"
  /\[.*?\]/g,
  /\b(f\/m\/d|m\/f\/d|d\/f\/m|w\/m\/d)\b/gi,
  /\b(full[- ]time|part[- ]time|contract|permanent)\b/gi,
  /\b(remote|hybrid|onsite|on[- ]site)\b/gi,
];

/**
 * Reduce a title to a comparable key.
 *
 * Used only for grouping candidacy and never shown to a user, so aggressive
 * stripping is safe here in a way it would not be for display. The canonical
 * title is always preserved separately.
 */
export function normalizeTitle(title: string): string {
  let out = title.toLowerCase();
  for (const re of TITLE_NOISE) out = out.replace(re, ' ');
  return out
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export interface ParsedLocation {
  raw: string;
  city: string | null;
  region: string | null;
  country: string | null;
  workMode: 'remote' | 'hybrid' | 'onsite' | null;
  isPrimary: boolean;
}

const REMOTE_RE = /\b(remote|work from home|wfh|anywhere|distributed)\b/i;
const HYBRID_RE = /\b(hybrid|flexible)\b/i;

/** Cities we care about most; keeps India-first parsing accurate. */
const KNOWN_CITY_COUNTRY: Record<string, string> = {
  bangalore: 'India',
  bengaluru: 'India',
  hyderabad: 'India',
  pune: 'India',
  mumbai: 'India',
  delhi: 'India',
  'new delhi': 'India',
  gurgaon: 'India',
  gurugram: 'India',
  noida: 'India',
  chennai: 'India',
  kolkata: 'India',
  ahmedabad: 'India',
  jaipur: 'India',
  kochi: 'India',
  chandigarh: 'India',
  indore: 'India',
  coimbatore: 'India',
};

const CITY_ALIASES: Record<string, string> = {
  bangalore: 'Bengaluru',
  gurgaon: 'Gurugram',
  bombay: 'Mumbai',
  calcutta: 'Kolkata',
  madras: 'Chennai',
};

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((w) => (w.length ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Parse one free-text location string.
 *
 * ATS location fields are unconstrained text - "Bengaluru, India",
 * "Remote - India", "Bangalore / Hybrid", "San Francisco, CA". The raw value is
 * always kept, because a parse that loses information the user could have read
 * themselves is worse than no parse.
 */
export function parseLocation(raw: string, isPrimary = false): ParsedLocation {
  const trimmed = raw.trim();

  const workMode: ParsedLocation['workMode'] = REMOTE_RE.test(trimmed)
    ? 'remote'
    : HYBRID_RE.test(trimmed)
      ? 'hybrid'
      : trimmed.length > 0
        ? 'onsite'
        : null;

  // Strip the mode words so they are not mistaken for a city.
  const withoutMode = trimmed
    .replace(REMOTE_RE, ' ')
    .replace(HYBRID_RE, ' ')
    .replace(/\b(onsite|on[- ]site|in[- ]office)\b/gi, ' ')
    .replace(/[-–—/|]+/g, ',')
    .replace(/\s+/g, ' ')
    .trim();

  const parts = withoutMode
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length === 0) {
    return { raw: trimmed, city: null, region: null, country: null, workMode, isPrimary };
  }

  const first = parts[0]!.toLowerCase();
  const canonicalCity = CITY_ALIASES[first] ?? titleCase(parts[0]!);
  const knownCountry = KNOWN_CITY_COUNTRY[first] ?? null;

  const last = parts.length > 1 ? parts[parts.length - 1]! : null;
  // A trailing two-letter token is a state code ("CA"), not a country.
  const lastIsRegionCode = last !== null && /^[A-Z]{2}$/.test(last);

  return {
    raw: trimmed,
    city: canonicalCity,
    region: parts.length > 2 ? parts[1]! : lastIsRegionCode ? last : null,
    country:
      parts.length > 1 && !lastIsRegionCode ? titleCase(last!) : knownCountry,
    workMode,
    isPrimary,
  };
}

/** Split a combined field like "Bangalore; Hyderabad; Remote". */
export function parseLocations(rawValues: string[]): ParsedLocation[] {
  const expanded: string[] = [];
  for (const value of rawValues) {
    for (const part of value.split(/[;]|\bor\b|\band\b/i)) {
      const t = part.trim();
      if (t.length > 0) expanded.push(t);
    }
  }
  const unique = [...new Set(expanded)];
  return unique.map((raw, i) => parseLocation(raw, i === 0));
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
  '#47': '/',
};

/**
 * Decode HTML entities.
 *
 * Greenhouse returns the job description as entity-escaped HTML - the body is
 * HTML, and then that HTML is escaped again. Skipping this step yields
 * descriptions full of visible &lt;p&gt; tags, which then poison the text sent
 * to the matcher. Applied twice for exactly that double-escaping.
 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code: string) => {
    const named = ENTITIES[code] ?? ENTITIES[code.toLowerCase()];
    if (named !== undefined) return named;
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const cp = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
    }
    if (code.startsWith('#')) {
      const cp = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
    }
    return match;
  });
}

/**
 * Strip tags to plain text, keeping block boundaries as newlines.
 *
 * Two decode passes, because Greenhouse's `content` is HTML that has itself
 * been entity-escaped:
 *
 *   1. decode the escaping wrapper  -  "&lt;p&gt;A &amp;amp; B" → "<p>A &amp; B"
 *   2. strip the now-real tags      -  "<p>A &amp; B"           → "A &amp; B"
 *   3. decode entities from the original HTML → "A & B"
 *
 * Doing only the first pass leaves "&amp;" visible in the description, which
 * then flows into the text the matcher reads and the user sees.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    decodeEntities(html)
      .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Content fingerprint, deciding whether a change deserves a new version.
 *
 * Built from normalized text so that whitespace churn, re-ordered tags and
 * casing edits do not create versions. Cached AI explanations are keyed to a
 * version (ADR D-09), so a fingerprint that flapped would silently multiply
 * inference spend.
 */
export function contentFingerprint(parts: {
  title: string;
  descriptionText: string | null;
  locations: string[];
}): string {
  const canonical = [
    parts.title.trim().toLowerCase(),
    (parts.descriptionText ?? '').replace(/\s+/g, ' ').trim().toLowerCase(),
    [...parts.locations].map((l) => l.trim().toLowerCase()).sort().join('|'),
  ].join(' ');

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Similarity between two descriptions, for grouping decisions only.
 *
 * Jaccard over word sets, scaled by a length ratio.
 *
 * The length term is not cosmetic. Set-based Jaccard ignores both word
 * frequency and document length, so a 200-word posting and a 2,000-word one
 * that happen to share a vocabulary score 1.0 - and at the 0.8 threshold that
 * is a false link. Because a false link hides a posting the user needed, and
 * they never learn it happened, the scoring is deliberately biased toward
 * reporting less similarity than a human might.
 */
export function textSimilarity(a: string, b: string): number {
  const wordsA = a.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const wordsB = b.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);

  let intersection = 0;
  for (const word of setA) if (setB.has(word)) intersection += 1;

  const jaccard = intersection / (setA.size + setB.size - intersection);

  const lengthRatio =
    Math.min(wordsA.length, wordsB.length) /
    Math.max(wordsA.length, wordsB.length);

  return jaccard * lengthRatio;
}
