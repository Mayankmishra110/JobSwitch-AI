import { describe, expect, it } from 'vitest';
import { isLatexBalanced, makeLatexSafe, sanitizeLatexField } from '../src/latexSafety.js';

describe('sanitizeLatexField', () => {
  it('escapes bare % & # _', () => {
    expect(sanitizeLatexField('20% off & done_now #1')).toBe('20\\% off \\& done\\_now \\#1');
  });

  it('leaves already-escaped sequences untouched (idempotent)', () => {
    const input = '20\\% off \\& done\\_now \\#1';
    expect(sanitizeLatexField(input)).toBe(input);
  });

  it('does not touch structural characters ($ { } \\)', () => {
    const input = 'Reduced latency by $\\sim$40\\% \\textbf{here}';
    expect(sanitizeLatexField(input)).toBe(input);
  });
});

describe('isLatexBalanced', () => {
  it('accepts balanced braces and paired math', () => {
    expect(isLatexBalanced('\\textbf{Go} and $\\sim$ math $\\sim$')).toEqual({ ok: true });
  });

  it('rejects an unclosed brace', () => {
    expect(isLatexBalanced('\\textbf{Go')).toEqual({ ok: false, reason: 'unbalanced-braces' });
  });

  it('rejects an extra closing brace', () => {
    expect(isLatexBalanced('Go}')).toEqual({ ok: false, reason: 'unbalanced-braces' });
  });

  it('rejects unpaired inline math', () => {
    expect(isLatexBalanced('cost is $40')).toEqual({ ok: false, reason: 'unbalanced-math' });
  });

  it('does not count an escaped brace toward depth', () => {
    expect(isLatexBalanced('literal \\{ and \\}')).toEqual({ ok: true });
  });
});

describe('makeLatexSafe', () => {
  it('sanitizes then validates, returning the safe string', () => {
    const result = makeLatexSafe('Cut cost by 20% & shipped on time');
    expect(result).toEqual({ ok: true, safe: 'Cut cost by 20\\% \\& shipped on time' });
  });

  it('rejects a rewrite that stays unbalanced even after sanitizing', () => {
    const result = makeLatexSafe('unbalanced {brace');
    expect(result).toEqual({ ok: false, reason: 'unbalanced-braces' });
  });
});
