import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { leverAdapter } from '../src/adapters/lever.js';
import { AdapterHttpError, AdapterShapeError } from '../src/adapter.js';

/**
 * Lever adapter tests.
 *
 * The fixture is SYNTHETIC - the build environment could not reach a live
 * board (see the header comment on the adapter). So these tests prove the
 * adapter is internally consistent and handles the documented shape; they do
 * NOT prove the documented shape matches reality.
 *
 * The gap closes by running `pnpm --filter @jobswitch/ingest capture` on a
 * networked machine and re-running these tests against the captured file.
 */

const FIXTURE = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lever-synthetic.json'),
    'utf8',
  ),
) as { jobs: unknown[] };

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('detect', () => {
  it.each([
    ['https://jobs.lever.co/examplecorp', 'examplecorp'],
    ['https://jobs.lever.co/examplecorp/9a1f2b3c-0001', 'examplecorp'],
    ['https://jobs.eu.lever.co/Examplecorp', 'examplecorp'],
  ])('extracts the site token from %s', (url, expected) => {
    expect(leverAdapter.detect(url)).toEqual({ atsType: 'lever', boardIdentifier: expected });
  });

  it('returns null for a non-Lever URL', () => {
    expect(leverAdapter.detect('https://boards.greenhouse.io/acme')).toBeNull();
    expect(leverAdapter.detect('https://acme.com/careers')).toBeNull();
  });
});

describe('fetch', () => {
  it('returns the bare postings array', async () => {
    // Lever's wire response is a bare array, unlike Greenhouse's envelope.
    const result = await leverAdapter.fetch({
      boardIdentifier: 'examplecorp',
      fetchImpl: fakeFetch(FIXTURE.jobs),
      userAgent: 'test',
    });
    expect(result.raw).toHaveLength(4);
    expect(result.httpStatus).toBe(200);
  });

  it('sends an identifying user agent', async () => {
    let seenUa: string | undefined;
    const spy = (async (_url: string, init?: RequestInit) => {
      seenUa = (init?.headers as Record<string, string>)['user-agent'];
      return new Response(JSON.stringify(FIXTURE.jobs), { status: 200 });
    }) as unknown as typeof fetch;

    await leverAdapter.fetch({
      boardIdentifier: 'examplecorp',
      fetchImpl: spy,
      userAgent: 'JobSwitchAI/0.1 (+https://example.com/bot)',
    });

    expect(seenUa).toContain('JobSwitchAI');
  });

  it('raises a typed error on 404 with an actionable message', async () => {
    await expect(
      leverAdapter.fetch({ boardIdentifier: 'nope', fetchImpl: fakeFetch({}, 404), userAgent: 'test' }),
    ).rejects.toThrow(AdapterHttpError);

    await expect(
      leverAdapter.fetch({ boardIdentifier: 'nope', fetchImpl: fakeFetch({}, 404), userAgent: 'test' }),
    ).rejects.toThrow(/token is wrong/);
  });

  it('raises a shape error rather than returning nothing when the body is not an array', async () => {
    // THE important failure mode - see the Greenhouse test for why silently
    // returning [] is unacceptable (ADR D-05).
    await expect(
      leverAdapter.fetch({
        boardIdentifier: 'examplecorp',
        fetchImpl: fakeFetch({ postings: [] }),
        userAgent: 'test',
      }),
    ).rejects.toThrow(AdapterShapeError);
  });

  it('raises a shape error on non-JSON', async () => {
    const htmlFetch = (async () =>
      new Response('<html>maintenance</html>', { status: 200 })) as unknown as typeof fetch;

    await expect(
      leverAdapter.fetch({ boardIdentifier: 'examplecorp', fetchImpl: htmlFetch, userAgent: 'test' }),
    ).rejects.toThrow(AdapterShapeError);
  });

  it('tolerates unknown fields being added', async () => {
    const withExtras = [{ ...(FIXTURE.jobs[0] as object), brand_new_field: 'whatever' }];
    const result = await leverAdapter.fetch({
      boardIdentifier: 'examplecorp',
      fetchImpl: fakeFetch(withExtras),
      userAgent: 'test',
    });
    expect(result.raw).toHaveLength(1);
  });
});

describe('normalize', () => {
  const normalized = FIXTURE.jobs.map((j) => leverAdapter.normalize(j));

  it('uses the posting id as identity', () => {
    expect(normalized[0]!.sourceJobId).toBe('9a1f2b3c-0001-4a2b-8c3d-000000000001');
  });

  it('preserves the canonical title and derives a normalized one', () => {
    expect(normalized[0]!.canonicalTitle).toBe('Senior Backend Engineer');
    expect(normalized[0]!.normalizedTitle).toBe('senior backend engineer');
  });

  it('strips mode noise from the normalized title', () => {
    expect(normalized[1]!.canonicalTitle).toBe('Product Manager (Remote)');
    expect(normalized[1]!.normalizedTitle).toBe('product manager');
  });

  it('detects seniority', () => {
    expect(normalized[0]!.seniority).toBe('senior');
    expect(normalized[2]!.seniority).toBe('staff');
    expect(normalized[3]!.seniority).toBeNull();
  });

  it('joins description, requirement lists and closing into one text block', () => {
    const text = normalized[0]!.descriptionText!;
    expect(text).toContain('Senior Backend Engineer');
    expect(text).toContain('5+ years backend experience');
    expect(text).toContain('equal opportunity employer');
  });

  it('falls back to applyUrl over hostedUrl when both are present', () => {
    expect(normalized[0]!.applyUrl).toContain('/apply');
  });

  it('falls back to hostedUrl when applyUrl is absent', () => {
    expect(normalized[2]!.applyUrl).toBe(
      'https://jobs.lever.co/examplecorp/9a1f2b3c-0003-4a2b-8c3d-000000000003',
    );
  });

  it('parses an Indian city and infers the country', () => {
    const loc = normalized[0]!.locations[0]!;
    expect(loc.city).toBe('Bengaluru');
    expect(loc.country).toBe('India');
    expect(loc.workMode).toBe('onsite');
  });

  it('infers remote from workplaceType when no location category is present', () => {
    expect(normalized[1]!.locations).toHaveLength(1);
    expect(normalized[1]!.locations[0]!.workMode).toBe('remote');
  });

  it('keeps multiple allLocations entries as separate locations', () => {
    expect(normalized[2]!.locations).toHaveLength(2);
    expect(normalized[2]!.locations.map((l) => l.city)).toEqual(['Hyderabad', 'Bengaluru']);
  });

  it('treats a trailing US state code as a region, not a country', () => {
    const loc = normalized[3]!.locations[0]!;
    expect(loc.city).toBe('San Francisco');
    expect(loc.region).toBe('CA');
    expect(loc.country).toBeNull();
  });

  it('prefers department, falling back to team', () => {
    expect(normalized[0]!.department).toBe('Engineering');
    expect(normalized[1]!.department).toBe('Product');
  });

  it('reports no salary rather than guessing one', () => {
    // The public postings API has no salary field.
    expect(normalized[0]!.salaryMin).toBeNull();
    expect(leverAdapter.capabilities.structuredSalary).toBe(false);
  });

  it('produces a stable fingerprint across whitespace-only changes', () => {
    const original = FIXTURE.jobs[0] as { content: { description: string } };
    const respaced = {
      ...original,
      content: { ...original.content, description: original.content.description.replace('<p>', '<p>   ') },
    };
    expect(leverAdapter.normalize(respaced).contentFingerprint).toBe(normalized[0]!.contentFingerprint);
  });

  it('changes the fingerprint when the content genuinely changes', () => {
    const original = FIXTURE.jobs[0] as { content: { description: string } };
    const edited = {
      ...original,
      content: { ...original.content, description: original.content.description.replace('own', 'lead') },
    };
    expect(leverAdapter.normalize(edited).contentFingerprint).not.toBe(normalized[0]!.contentFingerprint);
  });

  it('rejects a record missing required fields', () => {
    expect(() => leverAdapter.normalize({ text: 'No id' })).toThrow(AdapterShapeError);
  });

  it('handles a missing description without failing', () => {
    const result = leverAdapter.normalize({
      id: 'bare-1',
      text: 'Bare Posting',
      hostedUrl: 'https://jobs.lever.co/examplecorp/bare-1',
    });
    expect(result.descriptionText).toBeNull();
    expect(result.locations).toEqual([]);
  });
});
