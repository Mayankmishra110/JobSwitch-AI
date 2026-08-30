import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { greenhouseAdapter } from '../src/adapters/greenhouse.js';
import { AdapterHttpError, AdapterShapeError } from '../src/adapter.js';

/**
 * Greenhouse adapter tests.
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
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'greenhouse-synthetic.json',
    ),
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
    ['https://boards.greenhouse.io/razorpay', 'razorpay'],
    ['https://job-boards.greenhouse.io/postman/jobs/123', 'postman'],
    ['https://boards.greenhouse.io/Meesho/jobs/456', 'meesho'],
  ])('extracts the board token from %s', (url, expected) => {
    expect(greenhouseAdapter.detect(url)).toEqual({
      atsType: 'greenhouse',
      boardIdentifier: expected,
    });
  });

  it('returns null for a non-Greenhouse URL', () => {
    expect(greenhouseAdapter.detect('https://jobs.lever.co/acme')).toBeNull();
    expect(greenhouseAdapter.detect('https://acme.com/careers')).toBeNull();
  });
});

describe('fetch', () => {
  it('returns the jobs array', async () => {
    const result = await greenhouseAdapter.fetch({
      boardIdentifier: 'examplecorp',
      fetchImpl: fakeFetch(FIXTURE),
      userAgent: 'test',
    });
    expect(result.raw).toHaveLength(4);
    expect(result.httpStatus).toBe(200);
  });

  it('sends an identifying user agent', async () => {
    let seenUa: string | undefined;
    const spy = (async (_url: string, init?: RequestInit) => {
      seenUa = (init?.headers as Record<string, string>)['user-agent'];
      return new Response(JSON.stringify(FIXTURE), { status: 200 });
    }) as unknown as typeof fetch;

    await greenhouseAdapter.fetch({
      boardIdentifier: 'examplecorp',
      fetchImpl: spy,
      userAgent: 'JobSwitchAI/0.1 (+https://example.com/bot)',
    });

    expect(seenUa).toContain('JobSwitchAI');
  });

  it('raises a typed error on 404 with an actionable message', async () => {
    // A wrong board token is the single most likely seeding mistake, so the
    // message has to say so rather than "request failed".
    await expect(
      greenhouseAdapter.fetch({
        boardIdentifier: 'nope',
        fetchImpl: fakeFetch({}, 404),
        userAgent: 'test',
      }),
    ).rejects.toThrow(AdapterHttpError);

    await expect(
      greenhouseAdapter.fetch({
        boardIdentifier: 'nope',
        fetchImpl: fakeFetch({}, 404),
        userAgent: 'test',
      }),
    ).rejects.toThrow(/token is wrong/);
  });

  it('raises a shape error rather than returning nothing when jobs is missing', async () => {
    // THE important failure mode. Silently returning [] would look exactly
    // like a company with no open roles, and the ingestion run would then
    // close every posting it had. Failing loudly is what keeps D-05 honest.
    await expect(
      greenhouseAdapter.fetch({
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
      greenhouseAdapter.fetch({
        boardIdentifier: 'examplecorp',
        fetchImpl: htmlFetch,
        userAgent: 'test',
      }),
    ).rejects.toThrow(AdapterShapeError);
  });

  it('tolerates unknown fields being added', async () => {
    const withExtras = {
      jobs: [{ ...(FIXTURE.jobs[0] as object), brand_new_field: 'whatever' }],
      meta: { total: 1, something_new: true },
    };
    const result = await greenhouseAdapter.fetch({
      boardIdentifier: 'examplecorp',
      fetchImpl: fakeFetch(withExtras),
      userAgent: 'test',
    });
    expect(result.raw).toHaveLength(1);
  });
});

describe('normalize', () => {
  const normalized = FIXTURE.jobs.map((j) => greenhouseAdapter.normalize(j));

  it('uses the job id as identity, not requisition_id', () => {
    // requisition_id is optional and customer-supplied, so it is not unique
    // and cannot be identity.
    expect(normalized[0]!.sourceJobId).toBe('4001001');
    expect(normalized[2]!.sourceJobId).toBe('4001003');
  });

  it('preserves the canonical title and derives a normalized one', () => {
    expect(normalized[0]!.canonicalTitle).toBe('Senior Frontend Engineer');
    expect(normalized[0]!.normalizedTitle).toBe('senior frontend engineer');
  });

  it('strips parenthetical and mode noise from the normalized title', () => {
    expect(normalized[1]!.canonicalTitle).toBe('Backend Engineer (Remote)');
    expect(normalized[1]!.normalizedTitle).toBe('backend engineer');
  });

  it('detects seniority, preferring the more senior term', () => {
    expect(normalized[0]!.seniority).toBe('senior');
    expect(normalized[2]!.seniority).toBe('staff');
    expect(normalized[3]!.seniority).toBeNull();
  });

  it('decodes double-escaped HTML in the description', () => {
    // Greenhouse escapes the HTML body. Missing this leaves literal &lt;p&gt;
    // in the text the matcher reads.
    const text = normalized[0]!.descriptionText!;
    expect(text).not.toContain('&lt;');
    expect(text).not.toContain('<p>');
    expect(text).toContain('Senior Frontend Engineer');
    expect(text).toContain("What you'll do");
    expect(text).toContain('React');
  });

  it('converts list items to bullets and keeps line structure', () => {
    const text = normalized[0]!.descriptionText!;
    expect(text).toContain('• Build product surfaces in React and TypeScript');
  });

  it('resolves nested entities such as &amp;amp;', () => {
    expect(normalized[0]!.descriptionText).toContain('React & TypeScript');
  });

  it('parses an Indian city and infers the country', () => {
    const loc = normalized[0]!.locations[0]!;
    expect(loc.city).toBe('Bengaluru');
    expect(loc.country).toBe('India');
    expect(loc.workMode).toBe('onsite');
    expect(loc.isPrimary).toBe(true);
  });

  it('detects remote work mode', () => {
    const loc = normalized[1]!.locations[0]!;
    expect(loc.workMode).toBe('remote');
  });

  it('keeps multiple offices as separate locations', () => {
    expect(normalized[2]!.locations).toHaveLength(2);
    expect(normalized[2]!.locations.map((l) => l.city)).toEqual([
      'Hyderabad',
      'Bengaluru',
    ]);
  });

  it('treats a trailing US state code as a region, not a country', () => {
    const loc = normalized[3]!.locations[0]!;
    expect(loc.city).toBe('San Francisco');
    expect(loc.region).toBe('CA');
    expect(loc.country).toBeNull();
  });

  it('captures department and apply URL', () => {
    expect(normalized[0]!.department).toBe('Engineering');
    expect(normalized[0]!.applyUrl).toContain('/jobs/4001001');
  });

  it('reports no salary rather than guessing one', () => {
    // The board API has no salary field. Inventing one from the description
    // would make the matcher's compensation dimension confidently wrong.
    expect(normalized[0]!.salaryMin).toBeNull();
    expect(greenhouseAdapter.capabilities.structuredSalary).toBe(false);
  });

  it('produces a stable fingerprint across whitespace-only changes', () => {
    const original = FIXTURE.jobs[0] as { content: string };
    const respaced = {
      ...original,
      content: original.content.replace(/&lt;p&gt;/, '&lt;p&gt;   '),
    };
    expect(greenhouseAdapter.normalize(respaced).contentFingerprint).toBe(
      normalized[0]!.contentFingerprint,
    );
  });

  it('changes the fingerprint when the content genuinely changes', () => {
    const original = FIXTURE.jobs[0] as { content: string };
    const edited = {
      ...original,
      content: original.content.replace('4+ years', '6+ years'),
    };
    expect(greenhouseAdapter.normalize(edited).contentFingerprint).not.toBe(
      normalized[0]!.contentFingerprint,
    );
  });

  it('rejects a record missing required fields', () => {
    expect(() => greenhouseAdapter.normalize({ title: 'No id' })).toThrow(
      AdapterShapeError,
    );
  });

  it('handles a missing description without failing', () => {
    const result = greenhouseAdapter.normalize({
      id: 99,
      title: 'Bare Posting',
      absolute_url: 'https://boards.greenhouse.io/x/jobs/99',
    });
    expect(result.descriptionText).toBeNull();
    expect(result.locations).toEqual([]);
  });
});
