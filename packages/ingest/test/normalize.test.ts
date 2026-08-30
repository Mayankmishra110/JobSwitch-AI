import { describe, expect, it } from 'vitest';
import {
  contentFingerprint,
  decodeEntities,
  detectSeniority,
  htmlToText,
  normalizeTitle,
  parseLocation,
  parseLocations,
  textSimilarity,
} from '../src/normalize.js';

describe('normalizeTitle', () => {
  it('strips parentheticals, gender tags and mode words', () => {
    expect(normalizeTitle('Senior Engineer (Remote) f/m/d')).toBe('senior engineer');
    expect(normalizeTitle('Backend Developer [Full-time]')).toBe('backend developer');
  });

  it('keeps meaningful symbols used in tech titles', () => {
    expect(normalizeTitle('C++ Engineer')).toBe('c++ engineer');
    expect(normalizeTitle('C# Developer')).toBe('c# developer');
  });
});

describe('detectSeniority', () => {
  it.each([
    ['Senior Frontend Engineer', 'senior'],
    ['Staff Software Engineer', 'staff'],
    ['Principal Architect', 'principal'],
    ['Engineering Manager', 'manager'],
    ['Software Engineer Intern', 'intern'],
    ['Software Engineer', null],
  ])('%s → %s', (title, expected) => {
    expect(detectSeniority(title)).toBe(expected);
  });

  it('prefers the more senior term in a compound title', () => {
    // "Senior Staff Engineer" is a staff-level role, not a senior one.
    expect(detectSeniority('Senior Staff Engineer')).toBe('staff');
  });
});

describe('parseLocation', () => {
  it('recognises Indian cities and infers the country', () => {
    expect(parseLocation('Bengaluru, India')).toMatchObject({
      city: 'Bengaluru', country: 'India', workMode: 'onsite',
    });
  });

  it('canonicalises city aliases', () => {
    expect(parseLocation('Bangalore').city).toBe('Bengaluru');
    expect(parseLocation('Gurgaon').city).toBe('Gurugram');
  });

  it('detects remote and hybrid', () => {
    expect(parseLocation('Remote - India').workMode).toBe('remote');
    expect(parseLocation('Hybrid, Pune').workMode).toBe('hybrid');
    expect(parseLocation('Work From Home').workMode).toBe('remote');
  });

  it('treats a two-letter trailing token as a region', () => {
    expect(parseLocation('Austin, TX')).toMatchObject({ city: 'Austin', region: 'TX' });
  });

  it('always preserves the raw value', () => {
    expect(parseLocation('  Somewhere Odd  ').raw).toBe('Somewhere Odd');
  });

  it('splits multi-location strings and marks the first primary', () => {
    const parsed = parseLocations(['Bangalore; Hyderabad']);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.isPrimary).toBe(true);
    expect(parsed[1]!.isPrimary).toBe(false);
  });

  it('de-duplicates repeated locations', () => {
    expect(parseLocations(['Pune', 'Pune'])).toHaveLength(1);
  });
});

describe('decodeEntities / htmlToText', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a &amp; b &#39;c&#39; &lt;d&gt;')).toBe("a & b 'c' <d>");
  });

  it('unwraps double-escaped HTML and resolves inner entities', () => {
    // Greenhouse's exact shape: escaped HTML containing escaped entities.
    expect(htmlToText('&lt;p&gt;React &amp;amp; TypeScript&lt;/p&gt;')).toBe(
      'React & TypeScript',
    );
  });

  it('turns list items into bullets', () => {
    expect(htmlToText('&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;li&gt;Two&lt;/li&gt;&lt;/ul&gt;'))
      .toContain('• One');
  });

  it('leaves no tags or entity residue behind', () => {
    const out = htmlToText('&lt;div&gt;&lt;b&gt;Hi&lt;/b&gt;&amp;nbsp;there&lt;/div&gt;');
    expect(out).not.toMatch(/[<>]/);
    expect(out).not.toContain('&');
  });
});

describe('contentFingerprint', () => {
  it('ignores whitespace and casing churn', () => {
    const a = contentFingerprint({ title: 'Engineer', descriptionText: 'Build   things', locations: ['Pune'] });
    const b = contentFingerprint({ title: 'engineer', descriptionText: 'Build things', locations: ['pune'] });
    expect(a).toBe(b);
  });

  it('ignores location ordering', () => {
    const a = contentFingerprint({ title: 'E', descriptionText: null, locations: ['Pune', 'Delhi'] });
    const b = contentFingerprint({ title: 'E', descriptionText: null, locations: ['Delhi', 'Pune'] });
    expect(a).toBe(b);
  });

  it('changes on a real content change', () => {
    const a = contentFingerprint({ title: 'E', descriptionText: '4 years', locations: [] });
    const b = contentFingerprint({ title: 'E', descriptionText: '8 years', locations: [] });
    expect(a).not.toBe(b);
  });
});

describe('textSimilarity', () => {
  it('is 1 for identical text', () => {
    expect(textSimilarity('build react apps', 'build react apps')).toBe(1);
  });

  it('is 0 for unrelated text', () => {
    expect(textSimilarity('frontend react typescript', 'warehouse forklift logistics')).toBe(0);
  });

  it('penalises very different lengths despite shared vocabulary', () => {
    // Regression: set-based Jaccard alone scored these 1.0, because it ignores
    // both length and word frequency. At the 0.8 grouping threshold that is a
    // false link, and a false link hides a posting the user needed.
    const short = 'react typescript engineer';
    const long = `react typescript engineer ${'react typescript engineer '.repeat(40)}`;
    expect(textSimilarity(short, long)).toBeLessThan(0.8);
  });

  it('still scores genuine near-duplicates highly', () => {
    const a = 'We are looking for a frontend engineer with React and TypeScript experience in Bangalore';
    const b = 'We are looking for a frontend engineer with React and TypeScript experience in Hyderabad';
    expect(textSimilarity(a, b)).toBeGreaterThan(0.8);
  });
});
