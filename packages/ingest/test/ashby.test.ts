import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ashbyAdapter } from '../src/adapters/ashby.js';
import { AdapterHttpError, AdapterShapeError } from '../src/adapter.js';

/**
 * Ashby adapter tests.
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
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ashby-synthetic.json'),
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
    ['https://jobs.ashbyhq.com/examplecorp', 'examplecorp'],
    ['https://jobs.ashbyhq.com/Examplecorp/b2c3d4e5-0001', 'examplecorp'],
  ])('extracts the board name from %s', (url, expected) => {
    expect(ashbyAdapter.detect(url)).toEqual({ atsType: 'ashby', boardIdentifier: expected });
  });

  it('returns null for a non-Ashby URL', () => {
    expect(ashbyAdapter.detect('https://jobs.lever.co/acme')).toBeNull();
    expect(ashbyAdapter.detect('https://acme.com/careers')).toBeNull();
  });
});

describe('fetch', () => {
  it('returns the jobs array', async () => {
    const result = await ashbyAdapter.fetch({
      boardIdentifier: 'examplecorp',
      fetchImpl: fakeFetch({ jobs: FIXTURE.jobs }),
      userAgent: 'test',
    });
    expect(result.raw).toHaveLength(4);
    expect(result.httpStatus).toBe(200);
  });

  it('sends an identifying user agent', async () => {
    let seenUa: string | undefined;
    const spy = (async (_url: string, init?: RequestInit) => {
      seenUa = (init?.headers as Record<string, string>)['user-agent'];
      return new Response(JSON.stringify({ jobs: FIXTURE.jobs }), { status: 200 });
    }) as unknown as typeof fetch;

    await ashbyAdapter.fetch({
      boardIdentifier: 'examplecorp',
      fetchImpl: spy,
      userAgent: 'JobSwitchAI/0.1 (+https://example.com/bot)',
    });

    expect(seenUa).toContain('JobSwitchAI');
  });

  it('raises a typed error on 404 with an actionable message', async () => {
    await expect(
      ashbyAdapter.fetch({ boardIdentifier: 'nope', fetchImpl: fakeFetch({}, 404), userAgent: 'test' }),
    ).rejects.toThrow(AdapterHttpError);

    await expect(
      ashbyAdapter.fetch({ boardIdentifier: 'nope', fetchImpl: fakeFetch({}, 404), userAgent: 'test' }),
    ).rejects.toThrow(/name is wrong/);
  });

  it('raises a shape error rather than returning nothing when jobs is missing', async () => {
    // THE important failure mode - see the Greenhouse test for why silently
    // returning [] is unacceptable (ADR D-05).
    await expect(
      ashbyAdapter.fetch({
        boardIdentifier: 'examplecorp',
        fetchImpl: fakeFetch({ unexpected: true }),
        userAgent: 'test',
      }),
    ).rejects.toThrow(AdapterShapeError);
  });

  it('raises a shape error on non-JSON', async () => {
    const htmlFetch = (async () =>
      new Response('<html>maintenance</html>', { status: 200 })) as unknown as typeof fetch;

    await expect(
      ashbyAdapter.fetch({ boardIdentifier: 'examplecorp', fetchImpl: htmlFetch, userAgent: 'test' }),
    ).rejects.toThrow(AdapterShapeError);
  });

  it('tolerates unknown fields being added', async () => {
    const withExtras = {
      jobs: [{ ...(FIXTURE.jobs[0] as object), brand_new_field: 'whatever' }],
      organizationName: 'Example Corp',
    };
    const result = await ashbyAdapter.fetch({
      boardIdentifier: 'examplecorp',
      fetchImpl: fakeFetch(withExtras),
      userAgent: 'test',
    });
    expect(result.raw).toHaveLength(1);
  });
});

describe('normalize', () => {
  const normalized = FIXTURE.jobs.map((j) => ashbyAdapter.normalize(j));

  it('uses the job id as identity', () => {
    expect(normalized[0]!.sourceJobId).toBe('b2c3d4e5-0001-4f5a-9b1c-000000000001');
  });

  it('preserves the canonical title and derives a normalized one', () => {
    expect(normalized[0]!.canonicalTitle).toBe('Senior Data Engineer');
    expect(normalized[0]!.normalizedTitle).toBe('senior data engineer');
  });

  it('strips mode noise from the normalized title', () => {
    expect(normalized[1]!.canonicalTitle).toBe('Engineering Manager (Remote)');
    expect(normalized[1]!.normalizedTitle).toBe('engineering manager');
  });

  it('detects seniority', () => {
    expect(normalized[0]!.seniority).toBe('senior');
    expect(normalized[2]!.seniority).toBe('staff');
    expect(normalized[3]!.seniority).toBeNull();
  });

  it('prefers descriptionPlain over stripping descriptionHtml', () => {
    const text = normalized[0]!.descriptionText!;
    expect(text).toContain('Senior Data Engineer');
    expect(text).toContain('5+ years data engineering experience');
  });

  it('falls back to stripping descriptionHtml when descriptionPlain is absent', () => {
    const text = normalized[2]!.descriptionText!;
    expect(text).toBe('Own search relevance across the product.');
  });

  it('falls back to applyUrl over jobUrl when both are present', () => {
    expect(normalized[0]!.applyUrl).toContain('/application');
  });

  it('falls back to jobUrl when applyUrl is absent', () => {
    expect(normalized[1]!.applyUrl).toBe(
      'https://jobs.ashbyhq.com/examplecorp/b2c3d4e5-0002-4f5a-9b1c-000000000002',
    );
  });

  it('parses an Indian city and infers the country', () => {
    const loc = normalized[0]!.locations[0]!;
    expect(loc.city).toBe('Bengaluru');
    expect(loc.country).toBe('India');
    expect(loc.workMode).toBe('onsite');
  });

  it('infers remote from isRemote when no location string is present', () => {
    expect(normalized[1]!.locations).toHaveLength(1);
    expect(normalized[1]!.locations[0]!.workMode).toBe('remote');
  });

  it('keeps location plus secondaryLocations as separate entries', () => {
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
  });

  it('reports a structured salary range when compensation is present', () => {
    // Ashby is the only Phase 1-3 adapter that can do this - the capability
    // flag has to agree with what normalize actually returns.
    expect(normalized[0]!.salaryMin).toBe(2500000);
    expect(normalized[0]!.salaryMax).toBe(4000000);
    expect(normalized[0]!.salaryCurrency).toBe('INR');
    expect(ashbyAdapter.capabilities.structuredSalary).toBe(true);
  });

  it('reports no salary rather than guessing one when compensation is absent', () => {
    expect(normalized[1]!.salaryMin).toBeNull();
    expect(normalized[1]!.salaryCurrency).toBeNull();
  });

  it('produces a stable fingerprint across whitespace-only changes', () => {
    const original = FIXTURE.jobs[0] as { descriptionPlain: string };
    const respaced = { ...original, descriptionPlain: original.descriptionPlain.replace('\n\n', '\n\n  ') };
    expect(ashbyAdapter.normalize(respaced).contentFingerprint).toBe(normalized[0]!.contentFingerprint);
  });

  it('changes the fingerprint when the content genuinely changes', () => {
    const original = FIXTURE.jobs[0] as { descriptionPlain: string };
    const edited = { ...original, descriptionPlain: original.descriptionPlain.replace('5+ years', '8+ years') };
    expect(ashbyAdapter.normalize(edited).contentFingerprint).not.toBe(normalized[0]!.contentFingerprint);
  });

  it('rejects a record missing required fields', () => {
    expect(() => ashbyAdapter.normalize({ title: 'No id' })).toThrow(AdapterShapeError);
  });

  it('handles a missing description without failing', () => {
    const result = ashbyAdapter.normalize({
      id: 'bare-1',
      title: 'Bare Posting',
      jobUrl: 'https://jobs.ashbyhq.com/examplecorp/bare-1',
    });
    expect(result.descriptionText).toBeNull();
    expect(result.locations).toEqual([]);
  });
});
