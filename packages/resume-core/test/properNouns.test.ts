import { describe, expect, it } from 'vitest';
import { validateProperNouns } from '../src/properNouns.js';
import type { ParsedResume } from '../src/types.js';

function resumeWithRaw(raw: string): ParsedResume {
  return {
    raw,
    fields: [],
    structured: {
      summary: '', skills: [], skillCategories: [], experience: [], projects: [], education: [],
    },
  };
}

describe('validateProperNouns', () => {
  const original = resumeWithRaw(
    '\\section{Experience}\\resumeItem{Built APIs in React and Node.js, cutting latency by 40\\%.}',
  );

  it('does not flag words/numbers already present in the source, reordered and recased', () => {
    const flags = validateProperNouns(original, [
      { field: 'experience[0].bullets[0]', original: 'x', rewritten: 'react and node.js apis built, cutting latency by 40\\%.' },
    ]);
    expect(flags).toHaveLength(0);
  });

  it('flags a brand-new proper noun not in the original', () => {
    // Ends on the original's own "40%." rather than a fresh word, so the
    // trailing-period quirk (documented below) doesn't add a second flag.
    const flags = validateProperNouns(original, [
      { field: 'experience[0].bullets[0]', original: 'x', rewritten: 'Built APIs in React and Kubernetes, cutting latency by 40\\%.' },
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ token: 'Kubernetes', reason: 'new-entity' });
  });

  it('flags a brand-new metric not in the original', () => {
    const flags = validateProperNouns(original, [
      { field: 'experience[0].bullets[0]', original: 'x', rewritten: 'Built APIs in React, cutting latency by 99\\% overall.' },
    ]);
    expect(flags.some((f) => f.reason === 'new-metric' && f.token.includes('99'))).toBe(true);
  });

  it('does not flag common words, even sentence-initial and capitalized', () => {
    // "Additionally" is sentence-initial (capitalized) and not itself present
    // in the original text, but is in COMMON_WORDS - protected regardless of
    // position. Ends on "Node.js." (already-known vocabulary) rather than a
    // fresh word, to sidestep the trailing-period quirk documented below.
    const flags = validateProperNouns(original, [
      { field: 'experience[0].bullets[0]', original: 'x', rewritten: 'Additionally built APIs in React using Node.js.' },
    ]);
    expect(flags).toHaveLength(0);
  });

  it('deduplicates repeated flags for the same field/token pair', () => {
    const flags = validateProperNouns(original, [
      { field: 'experience[0].bullets[0]', original: 'x', rewritten: 'Kubernetes and Kubernetes and more Kubernetes, cutting latency by 40\\%.' },
    ]);
    expect(flags).toHaveLength(1);
  });

  it('is conservative: this is deliberately about false positives being acceptable, not silent invention', () => {
    // "Turborepo" is a real technology never mentioned in the source - correctly
    // flagged even though it is a legitimate thing to have used, because this
    // module cannot verify that from text alone. A human reviews the flag.
    const flags = validateProperNouns(original, [
      { field: 'experience[0].bullets[0]', original: 'x', rewritten: 'Migrated the monorepo to Turborepo for scale.' },
    ]);
    expect(flags.some((f) => f.token === 'Turborepo')).toBe(true);
  });

  it('known quirk, inherited byte-for-byte from the ported implementation: a word immediately followed by a sentence-ending period (no space) is tokenized WITH that period attached, which trips the tech-token heuristic (the same one that correctly detects "Node.js"/"C++") for any ordinary word in that position, not just genuine tech tokens', () => {
    const flags = validateProperNouns(original, [
      // "patterns." here is an ordinary, harmless word - flagged anyway,
      // token carries the trailing period exactly as produced.
      { field: 'experience[0].bullets[0]', original: 'x', rewritten: 'Built APIs in React using established patterns.' },
    ]);
    expect(flags).toEqual([
      { field: 'experience[0].bullets[0]', token: 'patterns.', reason: 'new-entity', rewritten: 'Built APIs in React using established patterns.' },
    ]);
  });
});
