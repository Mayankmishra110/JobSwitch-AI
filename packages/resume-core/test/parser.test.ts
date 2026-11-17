import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseResumeSource } from '../src/parser.js';

/**
 * Golden tests against a real .tex resume (copied from Mayankbuilt's own
 * `nipun` pipeline, the same file that pipeline's manual test script used) -
 * not a synthetic stand-in. There was no automated parity suite to port
 * (the build plan's own gap analysis names `scripts/test-resume-pipeline.ts`
 * as manual-only); this is the first one.
 */

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/fullstack.tex', import.meta.url));
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

describe('parseResumeSource', () => {
  it('round-trips every field: original always equals raw.slice(start, end)', () => {
    const parsed = parseResumeSource(FIXTURE);
    expect(parsed.fields.length).toBeGreaterThan(0);
    for (const field of parsed.fields) {
      expect(parsed.raw.slice(field.start, field.end)).toBe(field.original);
    }
  });

  it('field ids are unique', () => {
    const parsed = parseResumeSource(FIXTURE);
    const ids = parsed.fields.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('extracts the professional summary', () => {
    const parsed = parseResumeSource(FIXTURE);
    const summaryField = parsed.fields.find((f) => f.id === 'summary');
    expect(summaryField).toBeDefined();
    expect(summaryField!.kind).toBe('summary');
    expect(parsed.structured.summary).toContain('Full Stack Software Engineer');
  });

  it('extracts all six skill categories in order', () => {
    const parsed = parseResumeSource(FIXTURE);
    expect(parsed.structured.skillCategories.map((c) => c.category)).toEqual([
      'Frontend',
      'Backend',
      'Database & Cache',
      'Testing & Tooling',
      'DevOps & Platform',
      'CS Fundamentals',
    ]);
    const frontend = parsed.structured.skillCategories[0]!;
    expect(frontend.items).toContain('React.js');
  });

  it('extracts all three experience entries with their companies', () => {
    const parsed = parseResumeSource(FIXTURE);
    expect(parsed.structured.experience.map((e) => e.company)).toEqual([
      'WebKnot Technologies Pvt Ltd',
      'Expedian BuiltDesign Pvt Ltd',
      'Self-Employed — KAVACH AI', // texToPlain turns `---` into an em dash
    ]);
    // Every bullet field belongs to exactly one company by id prefix.
    const bulletFields = parsed.fields.filter((f) => f.kind === 'bullet');
    expect(bulletFields.length).toBeGreaterThan(0);
    for (const f of bulletFields) {
      expect(f.id).toMatch(/^experience\[\d+\]\.bullets\[\d+\]$/);
    }
  });

  it('extracts one education entry', () => {
    const parsed = parseResumeSource(FIXTURE);
    expect(parsed.structured.education).toHaveLength(1);
    expect(parsed.structured.education[0]!.institution).toContain(
      'North Eastern Regional Institute',
    );
  });

  it('returns empty structure for a source with none of the expected sections', () => {
    const parsed = parseResumeSource('\\documentclass{article}\\begin{document}Hi\\end{document}');
    expect(parsed.fields).toHaveLength(0);
    expect(parsed.structured.summary).toBe('');
    expect(parsed.structured.experience).toHaveLength(0);
  });
});
