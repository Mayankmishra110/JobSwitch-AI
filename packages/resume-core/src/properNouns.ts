import { texToPlain } from './parser.js';
import type { ParsedResume, ProperNounFlag, RewriteChange } from './types.js';

/**
 * Post-generation guardrail. Diffs the proper nouns and metrics present in a
 * rewritten field against the FULL original resume. Anything new (a company,
 * project, technology, or numeric metric that was not in the source) is flagged
 * for manual review before the change is ever surfaced in the diff UI.
 *
 * This is intentionally conservative: false positives (flagging a legitimate
 * synonym) are acceptable, silent invention is not.
 */

const TOKEN_RE = /~?[A-Za-z0-9][A-Za-z0-9.+#/&%-]*/g;

/** Common English words that may appear capitalized at the start of a bullet. */
const COMMON_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'by',
  'as', 'at', 'from', 'via', 'across', 'into', 'per', 'over', 'while',
  'additionally', 'also', 'built', 'created', 'drove', 'enabling', 'ensuring',
  'improving', 'including', 'reducing', 'resulting', 'using', 'leveraging',
  'this', 'that', 'these', 'those', 'it', 'its', 'their', 'end-to-end',
  'zero', 'full', 'real-time', 'multi-role', 'cross-platform', 'high-traffic',
]);

function normalize(token: string): string {
  return token
    .toLowerCase()
    .replace(/^~+/, '')
    .replace(/[.,;:)]+$/, '');
}

function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

function isMetric(token: string): boolean {
  return /\d/.test(token);
}

function looksLikeEntity(token: string): boolean {
  // Tech-ish tokens (next.js, c++, ci/cd, node.js) or capitalized proper nouns.
  if (/[.#+/]/.test(token) && /[A-Za-z]/.test(token)) return true;
  const first = token[0]!;
  return first === first.toUpperCase() && first !== first.toLowerCase() && token.length > 1;
}

export function validateProperNouns(
  parsed: ParsedResume,
  changes: RewriteChange[],
): ProperNounFlag[] {
  // Reference vocabulary: every token in the original source (plain text).
  const original = new Set(tokenize(texToPlain(parsed.raw)).map(normalize));

  const flags: ProperNounFlag[] = [];
  const seen = new Set<string>();

  for (const change of changes) {
    const plain = texToPlain(change.rewritten);
    for (const raw of tokenize(plain)) {
      const key = normalize(raw);
      if (!key || original.has(key)) continue;

      let reason: ProperNounFlag['reason'] | null = null;
      if (isMetric(raw)) reason = 'new-metric';
      else if (looksLikeEntity(raw) && !COMMON_WORDS.has(key)) reason = 'new-entity';

      if (!reason) continue;

      const dedupe = `${change.field}::${key}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);

      flags.push({ field: change.field, token: raw, reason, rewritten: change.rewritten });
    }
  }

  return flags;
}
