/**
 * Extracted from Mayankbuilt's private `nipun` pipeline (ADR: the build
 * plan's "extract the TS modules, don't port to Python, don't call the
 * deployed service" decision) - the byte-exact LaTeX span-splicing path,
 * verified against Mayank's own real resumes. Nothing here changed from
 * the source module except the doc comment above each export and the
 * removal of nipun's own bundled-variant registry (this product stores a
 * candidate's template per-account in `resume_source`, not as a
 * hardcoded bundle - see `apps/tailor`).
 */

export type EditableKind = 'summary' | 'skill' | 'bullet';

/**
 * A precisely located, editable region of the original .tex source.
 * `[start, end)` are character offsets into the raw source string; the
 * substring is the ONLY thing re-injection will ever overwrite. Everything
 * outside every field's span stays byte-identical to the source.
 */
export interface EditableField {
  /** Stable path id, e.g. `summary`, `skills[2]`, `experience[0].bullets[1]`. */
  id: string;
  kind: EditableKind;
  /** Human label for the diff UI. */
  label: string;
  /** Grouping context (company / project) for bullets. */
  group?: string;
  start: number;
  end: number;
  /** Exact source substring `raw.slice(start, end)`. */
  original: string;
}

export interface ExperienceEntry {
  company: string;
  title: string;
  dates: string;
  location: string;
  bullets: string[];
}

export interface ProjectEntry {
  name: string;
  tech?: string;
  bullets: string[];
}

export interface EducationEntry {
  institution: string;
  degree: string;
  dates: string;
  location: string;
}

export interface SkillCategory {
  category: string;
  items: string[];
}

/** Structured view fed to an LLM as read-only context. */
export interface StructuredResume {
  summary: string;
  skills: string[];
  skillCategories: SkillCategory[];
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
  education: EducationEntry[];
}

export interface ParsedResume {
  raw: string;
  fields: EditableField[];
  structured: StructuredResume;
}

export interface RewriteChange {
  /** Must match an EditableField.id. */
  field: string;
  original: string;
  rewritten: string;
}

export interface ProperNounFlag {
  field: string;
  token: string;
  reason: 'new-entity' | 'new-metric';
  rewritten: string;
}
