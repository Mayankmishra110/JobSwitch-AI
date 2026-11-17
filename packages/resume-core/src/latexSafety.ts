/**
 * LaTeX safety for LLM-rewritten fields.
 *
 * Rewrites are injected verbatim into the original .tex at their exact spans,
 * so a single bad character can break compilation. The LLM is instructed to
 * preserve LaTeX, but it sometimes emits a literal special character (e.g. a
 * bare `%`, which comments out the rest of the line — including a closing `}`).
 *
 * Two guards:
 *   1. sanitizeLatexField — escape bare text-mode specials that must be literal
 *      inside our editable fields (% & _ #). Idempotent: already-escaped
 *      sequences (\%, \&, …) are left untouched. Structural characters used
 *      intentionally ($ { } \) are NOT touched.
 *   2. isLatexBalanced — reject a rewrite whose braces or math ($) are
 *      unbalanced, so a structurally broken edit never reaches the compiler.
 */

/** Characters that, when bare in text mode, are literal glyphs in our fields. */
const BARE_SPECIALS: { re: RegExp; replacement: string }[] = [
  { re: /(?<!\\)%/g, replacement: '\\%' },
  { re: /(?<!\\)&/g, replacement: '\\&' },
  { re: /(?<!\\)#/g, replacement: '\\#' },
  { re: /(?<!\\)_/g, replacement: '\\_' },
];

export function sanitizeLatexField(input: string): string {
  let out = input;
  for (const { re, replacement } of BARE_SPECIALS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Counts unescaped occurrences of a single character, skipping `\<char>` and
 * treating `\\` as an escaped backslash (so it does not shield the next char).
 */
function countUnescaped(s: string, target: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++; // skip the escaped character
      continue;
    }
    if (c === target) count++;
  }
  return count;
}

export interface BalanceResult {
  ok: boolean;
  reason?: string;
}

export function isLatexBalanced(s: string): BalanceResult {
  // Brace depth (ignoring escaped \{ \}).
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth < 0) return { ok: false, reason: 'unbalanced-braces' };
    }
  }
  if (depth !== 0) return { ok: false, reason: 'unbalanced-braces' };

  // Inline math must be paired.
  if (countUnescaped(s, '$') % 2 !== 0) {
    return { ok: false, reason: 'unbalanced-math' };
  }

  return { ok: true };
}

/** Sanitize then validate. Returns the safe string or a reason it is unsafe. */
export function makeLatexSafe(
  input: string,
): { safe: string; ok: true } | { ok: false; reason: string } {
  const safe = sanitizeLatexField(input);
  const balance = isLatexBalanced(safe);
  if (!balance.ok) return { ok: false, reason: balance.reason! };
  return { safe, ok: true };
}
