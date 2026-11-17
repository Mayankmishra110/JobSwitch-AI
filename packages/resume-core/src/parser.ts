import type {
  EditableField,
  EducationEntry,
  ExperienceEntry,
  ParsedResume,
  ProjectEntry,
  SkillCategory,
  StructuredResume,
} from './types.js';

/* ──────────────────────────────────────────────────────────────
   Low-level brace-aware scanning helpers.

   Every editable span is located by exact character offset into the
   original source so re-injection can overwrite ONLY that span. All
   scanning is brace-depth aware and skips LaTeX-escaped characters
   (\{, \}, \\) so nested groups like \href{..}{..} parse correctly.
   ────────────────────────────────────────────────────────────── */

/** Given the index of an opening `{`, returns the index of its matching `}`. */
function findMatchingBrace(raw: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') {
      i++; // skip the escaped character
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface Group {
  /** Offset of the first character of the group content (after `{`). */
  contentStart: number;
  /** Offset one past the last content character (the `}`). */
  contentEnd: number;
  /** Offset one past the closing brace — where scanning should resume. */
  next: number;
  content: string;
}

/** Reads the next `{...}` group at/after `from`, skipping leading whitespace. */
function readGroup(raw: string, from: number): Group | null {
  let i = from;
  while (i < raw.length && /\s/.test(raw[i]!)) i++;
  if (raw[i] !== '{') return null;
  const close = findMatchingBrace(raw, i);
  if (close === -1) return null;
  return {
    contentStart: i + 1,
    contentEnd: close,
    next: close + 1,
    content: raw.slice(i + 1, close),
  };
}

/* ──────────────────────────────────────────────────────────────
   LaTeX → plain text (for LLM context + proper-noun token sets only;
   never used for re-injection, which always uses raw spans).
   ────────────────────────────────────────────────────────────── */

export function texToPlain(input: string): string {
  let s = input;
  // Links: keep visible text, drop URL.
  s = s.replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1');
  // Font/emphasis wrappers: unwrap, keep content.
  s = s.replace(/\\(?:textbf|textit|texttt|underline|emph|normalsize|normalfont|scshape)\s*\{([^{}]*)\}/g, '$1');
  // Repeat once to catch a single level of nesting.
  s = s.replace(/\\(?:textbf|textit|texttt|underline|emph)\s*\{([^{}]*)\}/g, '$1');
  s = s.replace(/\$\\sim\$/g, '~');
  s = s.replace(/\\textbar\\?/g, '|');
  s = s.replace(/---/g, '—');
  s = s.replace(/\\&/g, '&');
  s = s.replace(/\\%/g, '%');
  s = s.replace(/\\ /g, ' ');
  s = s.replace(/\\[a-zA-Z]+/g, ' '); // remaining commands
  s = s.replace(/[{}$]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/* ──────────────────────────────────────────────────────────────
   Section-level parsing.
   ────────────────────────────────────────────────────────────── */

function sectionIndex(raw: string, name: string): number {
  return raw.indexOf(`\\section{${name}}`);
}

function parseSummary(raw: string, fields: EditableField[]): string {
  const secIdx = sectionIndex(raw, 'Professional Summary');
  if (secIdx === -1) return '';
  const nsIdx = raw.indexOf('\\normalsize{', secIdx);
  if (nsIdx === -1) return '';
  const braceIdx = nsIdx + '\\normalsize'.length;
  const close = findMatchingBrace(raw, braceIdx);
  if (close === -1) return '';
  const start = braceIdx + 1;
  const original = raw.slice(start, close);
  fields.push({
    id: 'summary',
    kind: 'summary',
    label: 'Professional Summary',
    start,
    end: close,
    original,
  });
  return texToPlain(original);
}

function parseSkills(raw: string, fields: EditableField[]): SkillCategory[] {
  const secIdx = sectionIndex(raw, 'Skills');
  if (secIdx === -1) return [];
  const expIdx = sectionIndex(raw, 'Experience');
  const region = expIdx === -1 ? raw.length : expIdx;

  const categories: SkillCategory[] = [];
  let cursor = secIdx;
  let idx = 0;

  for (;;) {
    const tb = raw.indexOf('\\textbf{', cursor);
    if (tb === -1 || tb >= region) break;

    const catGroup = readGroup(raw, tb + '\\textbf'.length);
    if (!catGroup) {
      cursor = tb + 1;
      continue;
    }
    const valGroup = readGroup(raw, catGroup.next);
    // A skill line is `\textbf{Category}{: items...}`.
    if (!valGroup || !valGroup.content.trimStart().startsWith(':')) {
      cursor = catGroup.next;
      continue;
    }

    const category = texToPlain(catGroup.content);
    // Editable span excludes the leading `: ` so the colon stays fixed.
    const colonRel = valGroup.content.indexOf(':');
    let offset = colonRel + 1;
    while (offset < valGroup.content.length && valGroup.content[offset] === ' ') offset++;
    const start = valGroup.contentStart + offset;
    const end = valGroup.contentEnd;
    const original = raw.slice(start, end);

    fields.push({
      id: `skills[${idx}]`,
      kind: 'skill',
      label: `Skills — ${category}`,
      group: category,
      start,
      end,
      original,
    });

    categories.push({
      category,
      items: texToPlain(original)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    });

    idx++;
    cursor = valGroup.next;
  }

  return categories;
}

const COMMAND_RE = /\\([a-zA-Z]+)/g;

function parseExperience(
  raw: string,
  fields: EditableField[],
): { experience: ExperienceEntry[]; projects: ProjectEntry[] } {
  const expIdx = sectionIndex(raw, 'Experience');
  const eduIdx = sectionIndex(raw, 'Education');
  if (expIdx === -1) return { experience: [], projects: [] };
  const end = eduIdx === -1 ? raw.length : eduIdx;

  const experience: ExperienceEntry[] = [];
  const projects: ProjectEntry[] = [];

  let companyIndex = -1;
  let bulletIndexInCompany = 0;
  let currentProject: ProjectEntry | null = null;

  COMMAND_RE.lastIndex = expIdx;
  let m: RegExpExecArray | null;
  while ((m = COMMAND_RE.exec(raw)) !== null) {
    if (m.index >= end) break;
    const name = m[1];
    const afterCmd = m.index + m[0].length;

    if (name === 'resumeSubheading') {
      const g1 = readGroup(raw, afterCmd);
      const g2 = g1 && readGroup(raw, g1.next);
      const g3 = g2 && readGroup(raw, g2.next);
      const g4 = g3 && readGroup(raw, g3.next);
      if (g1 && g2 && g3 && g4) {
        experience.push({
          title: texToPlain(g1.content),
          dates: texToPlain(g2.content),
          company: texToPlain(g3.content),
          location: texToPlain(g4.content),
          bullets: [],
        });
        companyIndex = experience.length - 1;
        bulletIndexInCompany = 0;
        currentProject = null;
        COMMAND_RE.lastIndex = g4.next;
      }
      continue;
    }

    if (name === 'resumeProjectLine') {
      const g = readGroup(raw, afterCmd);
      if (g) {
        const plain = texToPlain(g.content);
        // Project line looks like "Name | tech, tech | Live | note".
        const parts = plain.split('|').map((p) => p.trim());
        const project: ProjectEntry = {
          name: parts[0] || plain,
          tech: parts[1] || undefined,
          bullets: [],
        };
        projects.push(project);
        currentProject = project;
        COMMAND_RE.lastIndex = g.next;
      }
      continue;
    }

    if (name === 'resumeItem') {
      const g = readGroup(raw, afterCmd);
      if (g && companyIndex >= 0) {
        const original = raw.slice(g.contentStart, g.contentEnd);
        const company = experience[companyIndex]!;
        const groupLabel = currentProject
          ? `${company.company} · ${currentProject.name}`
          : company.company;
        fields.push({
          id: `experience[${companyIndex}].bullets[${bulletIndexInCompany}]`,
          kind: 'bullet',
          label: `${groupLabel} — bullet ${bulletIndexInCompany + 1}`,
          group: groupLabel,
          start: g.contentStart,
          end: g.contentEnd,
          original,
        });
        const plain = texToPlain(original);
        company.bullets.push(plain);
        if (currentProject) currentProject.bullets.push(plain);
        bulletIndexInCompany++;
        COMMAND_RE.lastIndex = g.next;
      }
      continue;
    }
  }

  return { experience, projects };
}

function parseEducation(raw: string): EducationEntry[] {
  const eduIdx = sectionIndex(raw, 'Education');
  if (eduIdx === -1) return [];
  const accIdx = sectionIndex(raw, 'Accomplishments');
  const end = accIdx === -1 ? raw.length : accIdx;

  const entries: EducationEntry[] = [];
  let cursor = eduIdx;
  for (;;) {
    const sh = raw.indexOf('\\resumeSubheading', cursor);
    if (sh === -1 || sh >= end) break;
    const afterCmd = sh + '\\resumeSubheading'.length;
    const g1 = readGroup(raw, afterCmd);
    const g2 = g1 && readGroup(raw, g1.next);
    const g3 = g2 && readGroup(raw, g2.next);
    const g4 = g3 && readGroup(raw, g3.next);
    if (g1 && g2 && g3 && g4) {
      entries.push({
        institution: texToPlain(g1.content),
        dates: texToPlain(g2.content),
        degree: texToPlain(g3.content),
        location: texToPlain(g4.content),
      });
      cursor = g4.next;
    } else {
      cursor = afterCmd;
    }
  }
  return entries;
}

/* ──────────────────────────────────────────────────────────────
   Public API.
   ────────────────────────────────────────────────────────────── */

export function parseResumeSource(raw: string): ParsedResume {
  const fields: EditableField[] = [];

  const summary = parseSummary(raw, fields);
  const skillCategories = parseSkills(raw, fields);
  const { experience, projects } = parseExperience(raw, fields);
  const education = parseEducation(raw);

  const structured: StructuredResume = {
    summary,
    skills: skillCategories.flatMap((c) => c.items),
    skillCategories,
    experience,
    projects,
    education,
  };

  return { raw, fields, structured };
}

export { findMatchingBrace };
