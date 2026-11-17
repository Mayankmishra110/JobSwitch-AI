import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseResumeSource } from '../src/parser.js';
import { applyAcceptedChanges, verifyKeepIntegrity } from '../src/reinject.js';
import type { ParsedResume } from '../src/types.js';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/fullstack.tex', import.meta.url));
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

describe('applyAcceptedChanges / verifyKeepIntegrity', () => {
  it('changes only the accepted field, keeping every other byte identical', () => {
    const parsed = parseResumeSource(FIXTURE);
    const newSummary = 'Rewritten summary for a target role.';
    const accepted = [{ field: 'summary', rewritten: newSummary }];

    const result = applyAcceptedChanges(parsed, accepted);

    expect(result.applied).toEqual([
      { field: 'summary', original: parsed.fields.find((f) => f.id === 'summary')!.original, rewritten: newSummary },
    ]);
    expect(result.skipped).toHaveLength(0);

    // The whole document, minus the summary span, must be byte-identical.
    const summaryField = parsed.fields.find((f) => f.id === 'summary')!;
    const before = parsed.raw.slice(0, summaryField.start);
    const after = parsed.raw.slice(summaryField.end);
    expect(result.tex.startsWith(before)).toBe(true);
    expect(result.tex.endsWith(after)).toBe(true);
    expect(result.tex).toBe(before + newSummary + after);

    const integrity = verifyKeepIntegrity(parsed, accepted, result.tex);
    expect(integrity).toEqual({ ok: true, violations: [] });
  });

  it('is a no-op (byte-identical) when the accepted rewrite equals the original', () => {
    const parsed = parseResumeSource(FIXTURE);
    const summaryField = parsed.fields.find((f) => f.id === 'summary')!;
    const result = applyAcceptedChanges(parsed, [
      { field: 'summary', rewritten: summaryField.original },
    ]);

    expect(result.tex).toBe(parsed.raw);
    expect(result.applied).toHaveLength(0);
  });

  it('skips an unknown field id, keeping the source untouched', () => {
    const parsed = parseResumeSource(FIXTURE);
    const result = applyAcceptedChanges(parsed, [
      { field: 'skills[999]', rewritten: 'anything' },
    ]);

    expect(result.tex).toBe(parsed.raw);
    expect(result.skipped).toEqual([
      { field: 'skills[999]', reason: 'unknown-or-non-editable-field' },
    ]);
  });

  it('skips a rewrite with unbalanced braces rather than risking a broken compile', () => {
    const parsed = parseResumeSource(FIXTURE);
    const result = applyAcceptedChanges(parsed, [
      { field: 'summary', rewritten: 'Missing a closing brace {here' },
    ]);

    expect(result.tex).toBe(parsed.raw); // untouched - the one unsafe change was skipped
    expect(result.skipped).toEqual([
      { field: 'summary', reason: 'unsafe-latex:unbalanced-braces' },
    ]);
  });

  it('escapes a bare special character rather than rejecting the whole rewrite', () => {
    const parsed = parseResumeSource(FIXTURE);
    const result = applyAcceptedChanges(parsed, [
      { field: 'summary', rewritten: 'Cut costs by 20% using Node.js & Redis' },
    ]);

    expect(result.skipped).toHaveLength(0);
    expect(result.applied[0]!.rewritten).toBe('Cut costs by 20\\% using Node.js \\& Redis');
  });

  it('applies multiple non-overlapping accepted changes correctly, right-to-left', () => {
    const parsed = parseResumeSource(FIXTURE);
    const summaryField = parsed.fields.find((f) => f.id === 'summary')!;
    const skillField = parsed.fields.find((f) => f.id === 'skills[0]')!;
    // Sanity: summary comes before skills[0] in this document.
    expect(summaryField.start).toBeLessThan(skillField.start);

    const accepted = [
      { field: 'summary', rewritten: 'New short summary.' },
      { field: 'skills[0]', rewritten: 'Go, Rust' },
    ];
    const result = applyAcceptedChanges(parsed, accepted);

    const integrity = verifyKeepIntegrity(parsed, accepted, result.tex);
    expect(integrity.ok).toBe(true);
    expect(result.tex).toContain('New short summary.');
    expect(result.tex).toContain('Go, Rust');
  });

  it('throws on overlapping edit spans rather than silently corrupting the output', () => {
    const parsed: ParsedResume = {
      raw: 'ABCDEFGHIJ',
      fields: [
        { id: 'a', kind: 'bullet', label: 'a', start: 0, end: 5, original: 'ABCDE' },
        { id: 'b', kind: 'bullet', label: 'b', start: 3, end: 8, original: 'DEFGH' },
      ],
      structured: {
        summary: '', skills: [], skillCategories: [], experience: [], projects: [], education: [],
      },
    };
    expect(() =>
      applyAcceptedChanges(parsed, [
        { field: 'a', rewritten: 'XXXXX' },
        { field: 'b', rewritten: 'YYYYY' },
      ]),
    ).toThrow(/Overlapping edit spans/);
  });

  it('verifyKeepIntegrity detects a kept field that was mutated by something else', () => {
    const parsed = parseResumeSource(FIXTURE);
    const accepted = [{ field: 'summary', rewritten: 'New summary text.' }];
    const result = applyAcceptedChanges(parsed, accepted);

    // Corrupt a byte well outside the edited span - inside the (kept) skills
    // section - simulating a bug elsewhere in a caller that touched output it
    // should not have.
    const corruptIndex = result.tex.indexOf('React.js');
    const corrupted =
      result.tex.slice(0, corruptIndex) + 'XXXXXXXX' + result.tex.slice(corruptIndex + 8);

    const integrity = verifyKeepIntegrity(parsed, accepted, corrupted);
    expect(integrity.ok).toBe(false);
    expect(integrity.violations.length).toBeGreaterThan(0);
  });
});
