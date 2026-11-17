import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  migrate,
  withoutTenantContext,
  type Pool,
} from '@jobswitch/db';
import { greenhouseAdapter } from '../src/adapters/greenhouse.js';
import { runIngestion } from '../src/run.js';

/**
 * Full ingestion runs against real Postgres.
 *
 * These cover the behaviour that decides whether users can trust the index:
 * postings keep their identity, content changes create versions, absent
 * postings close but only on evidence, and a suspicious empty response never
 * empties a company.
 */

const DB_URL =
  process.env.DATABASE_URL_TEST ??
  'postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test';

let pool: Pool;
let companyId: string;
let sourceId: string;

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 7001,
    title: 'Senior Frontend Engineer',
    absolute_url: 'https://boards.greenhouse.io/acme/jobs/7001',
    updated_at: '2026-08-20T10:30:00-04:00',
    location: { name: 'Bengaluru, India' },
    offices: [{ name: 'Bangalore', location: 'Bengaluru, India' }],
    departments: [{ name: 'Engineering' }],
    content: '&lt;p&gt;Build things with React and TypeScript at scale.&lt;/p&gt;',
    ...overrides,
  };
}

function boardReturning(jobs: unknown[], status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ jobs, meta: { total: jobs.length } }), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

const run = (fetchImpl: typeof fetch) =>
  runIngestion({ pool, adapter: greenhouseAdapter, careerSourceId: sourceId, fetchImpl });

beforeAll(async () => {
  pool = createPool({ connectionString: DB_URL, max: 6 });
  await migrate(pool);
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM job_queue WHERE queue = 'embed.job_version'`);
  await pool.query('DELETE FROM scrape_run');
  await pool.query('DELETE FROM job_group_link');
  await pool.query('DELETE FROM job_group');
  await pool.query('UPDATE job_posting SET current_version_id = NULL');
  await pool.query('DELETE FROM job_posting_version');
  await pool.query('DELETE FROM job_posting_location');
  await pool.query('DELETE FROM job_posting');
  await pool.query('DELETE FROM career_source');
  await pool.query('DELETE FROM company');

  const { rows: c } = await pool.query<{ id: string }>(
    `INSERT INTO company (name, normalized_domain, website)
     VALUES ('Acme', 'acme.test', 'https://acme.test') RETURNING id`,
  );
  companyId = c[0]!.id;

  const { rows: s } = await pool.query<{ id: string }>(
    `INSERT INTO career_source (company_id, ats_type, board_identifier)
     VALUES ($1, 'greenhouse', 'acme') RETURNING id`,
    [companyId],
  );
  sourceId = s[0]!.id;
});

describe('first run', () => {
  it('creates postings, a version and locations', async () => {
    const outcome = await run(boardReturning([job(), job({ id: 7002, title: 'Backend Engineer' })]));

    expect(outcome.status).toBe('success');
    expect(outcome.postingsNew).toBe(2);

    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_posting',
    );
    expect(rows[0]!.count).toBe(2);

    const { rows: versions } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_posting_version',
    );
    expect(versions[0]!.count).toBe(2);

    const { rows: locs } = await pool.query<{ city: string }>(
      `SELECT city FROM job_posting_location ORDER BY city`,
    );
    expect(locs.map((l) => l.city)).toContain('Bengaluru');
  });

  it('points each posting at its current version', async () => {
    await run(boardReturning([job()]));
    const { rows } = await pool.query(
      `SELECT jp.id FROM job_posting jp
       JOIN job_posting_version v ON v.id = jp.current_version_id`,
    );
    expect(rows).toHaveLength(1);
  });

  it('records a successful scrape_run', async () => {
    await run(boardReturning([job()]));
    const { rows } = await pool.query<{
      status: string; postings_seen: number; postings_new: number;
    }>('SELECT status, postings_seen, postings_new FROM scrape_run');
    expect(rows[0]).toMatchObject({ status: 'success', postings_seen: 1, postings_new: 1 });
  });

  it('advances next_run_at so the scheduler does not loop', async () => {
    const before = await pool.query<{ next_run_at: Date }>(
      'SELECT next_run_at FROM career_source',
    );
    await run(boardReturning([job()]));
    const after = await pool.query<{ next_run_at: Date }>(
      'SELECT next_run_at FROM career_source',
    );
    expect(after.rows[0]!.next_run_at.getTime()).toBeGreaterThan(
      before.rows[0]!.next_run_at.getTime(),
    );
  });
});

describe('re-running', () => {
  it('keeps posting identity and writes no new version when unchanged', async () => {
    await run(boardReturning([job()]));
    const first = await pool.query<{ id: string }>('SELECT id FROM job_posting');

    const second = await run(boardReturning([job()]));
    expect(second.postingsNew).toBe(0);

    const after = await pool.query<{ id: string }>('SELECT id FROM job_posting');
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.id).toBe(first.rows[0]!.id);

    const { rows: versions } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_posting_version',
    );
    expect(versions[0]!.count).toBe(1);
  });

  it('writes a new version when the description changes, keeping history', async () => {
    await run(boardReturning([job()]));
    await run(
      boardReturning([
        job({ content: '&lt;p&gt;Now we want Vue and 8 years of experience.&lt;/p&gt;' }),
      ]),
    );

    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_posting_version',
    );
    expect(rows[0]!.count).toBe(2);

    // One posting, two versions - so "the requirements changed since you saved
    // this" is answerable, and cached explanations invalidate correctly.
    const { rows: postings } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_posting',
    );
    expect(postings[0]!.count).toBe(1);
  });

  it('reuses an existing version if the content reverts', async () => {
    await run(boardReturning([job()]));
    await run(boardReturning([job({ content: '&lt;p&gt;Changed.&lt;/p&gt;' })]));
    await run(boardReturning([job()]));

    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_posting_version',
    );
    expect(rows[0]!.count).toBe(2);
  });
});

describe('embedding enqueue', () => {
  it('enqueues one embed.job_version job per newly created version', async () => {
    await run(boardReturning([job(), job({ id: 7002, title: 'Backend Engineer' })]));

    const { rows: jobs } = await pool.query<{ payload: { versionId: string } }>(
      `SELECT payload FROM job_queue WHERE queue = 'embed.job_version'`,
    );
    expect(jobs).toHaveLength(2);

    const { rows: versions } = await pool.query<{ id: string }>(
      'SELECT id FROM job_posting_version',
    );
    const versionIds = versions.map((v) => v.id).sort();
    const enqueuedIds = jobs.map((j) => j.payload.versionId).sort();
    expect(enqueuedIds).toEqual(versionIds);
  });

  it('does not enqueue again when content is unchanged', async () => {
    await run(boardReturning([job()]));
    await run(boardReturning([job()]));

    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM job_queue WHERE queue = 'embed.job_version'`,
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('enqueues again when the description changes, for the new version only', async () => {
    await run(boardReturning([job()]));
    await run(
      boardReturning([job({ content: '&lt;p&gt;Now we want Vue and 8 years.&lt;/p&gt;' })]),
    );

    const { rows: jobs } = await pool.query<{ payload: { versionId: string } }>(
      `SELECT payload FROM job_queue WHERE queue = 'embed.job_version'`,
    );
    expect(jobs).toHaveLength(2);

    const { rows: versions } = await pool.query<{ id: string }>(
      'SELECT id FROM job_posting_version ORDER BY captured_at',
    );
    expect(jobs.map((j) => j.payload.versionId).sort()).toEqual(
      versions.map((v) => v.id).sort(),
    );
  });
});

describe('closing', () => {
  it('closes a posting only after two consecutive absences', async () => {
    await run(boardReturning([job(), job({ id: 7002, title: 'Backend Engineer' })]));

    // First absence: counted, not closed. One odd response must not retire a
    // live job.
    await run(boardReturning([job()]));
    let { rows } = await pool.query<{ closed_at: Date | null }>(
      `SELECT closed_at FROM job_posting WHERE source_job_id = '7002'`,
    );
    expect(rows[0]!.closed_at).toBeNull();

    await run(boardReturning([job()]));
    ({ rows } = await pool.query<{ closed_at: Date | null }>(
      `SELECT closed_at FROM job_posting WHERE source_job_id = '7002'`,
    ));
    expect(rows[0]!.closed_at).not.toBeNull();
  });

  it('reopens rather than duplicating when a posting returns', async () => {
    await run(boardReturning([job(), job({ id: 7002 })]));
    await run(boardReturning([job()]));
    await run(boardReturning([job()]));

    const outcome = await run(boardReturning([job(), job({ id: 7002 })]));
    expect(outcome.postingsReopened).toBe(1);
    expect(outcome.postingsNew).toBe(0);

    const { rows } = await pool.query<{ closed_at: Date | null; reopened_at: Date | null }>(
      `SELECT closed_at, reopened_at FROM job_posting WHERE source_job_id = '7002'`,
    );
    expect(rows[0]!.closed_at).toBeNull();
    expect(rows[0]!.reopened_at).not.toBeNull();

    const { rows: count } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_posting',
    );
    expect(count[0]!.count).toBe(2);
  });

  it('resets the absence counter when a posting reappears in time', async () => {
    await run(boardReturning([job(), job({ id: 7002 })]));
    await run(boardReturning([job()]));
    await run(boardReturning([job(), job({ id: 7002 })]));
    await run(boardReturning([job()]));

    const { rows } = await pool.query<{ closed_at: Date | null }>(
      `SELECT closed_at FROM job_posting WHERE source_job_id = '7002'`,
    );
    expect(rows[0]!.closed_at).toBeNull();
  });
});

describe('the zero-result guard (ADR D-05)', () => {
  it('never closes anything when a board returns an empty list', async () => {
    // The failure that would destroy the index: a 200 with an empty body -
    // a board mid-migration, a CDN stub, a silent API change - retiring every
    // posting for a company overnight, invisibly.
    await run(boardReturning([job(), job({ id: 7002 })]));

    const outcome = await run(boardReturning([]));

    expect(outcome.closingSuppressed).toBe(true);
    expect(outcome.postingsClosed).toBe(0);

    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_posting WHERE closed_at IS NULL',
    );
    expect(rows[0]!.count).toBe(2);
  });

  it('does not even increment the absence counter on an empty response', async () => {
    // Otherwise two empty responses would close everything on the second - the
    // same disaster, one night later.
    await run(boardReturning([job()]));
    await run(boardReturning([]));
    await run(boardReturning([]));

    const { rows } = await pool.query<{ absent_run_count: number; closed_at: Date | null }>(
      'SELECT absent_run_count, closed_at FROM job_posting',
    );
    expect(rows[0]!.absent_run_count).toBe(0);
    expect(rows[0]!.closed_at).toBeNull();
  });

  it('accepts an empty board when nothing was open anyway', async () => {
    const outcome = await run(boardReturning([]));
    expect(outcome.status).toBe('success');
    expect(outcome.closingSuppressed).toBeUndefined();
  });
});

describe('failures', () => {
  it('records a failure and degrades the source after three', async () => {
    const failing = boardReturning([], 500);

    for (let i = 0; i < 3; i += 1) {
      const outcome = await run(failing);
      expect(outcome.status).toBe('failure');
    }

    const { rows } = await pool.query<{ status: string; consecutive_failures: number }>(
      'SELECT status, consecutive_failures FROM career_source',
    );
    expect(rows[0]!.consecutive_failures).toBe(3);
    expect(rows[0]!.status).toBe('degraded');
  });

  it('recovers to active after a success', async () => {
    for (let i = 0; i < 3; i += 1) await run(boardReturning([], 500));
    await run(boardReturning([job()]));

    const { rows } = await pool.query<{ status: string; consecutive_failures: number }>(
      'SELECT status, consecutive_failures FROM career_source',
    );
    expect(rows[0]!.status).toBe('active');
    expect(rows[0]!.consecutive_failures).toBe(0);
  });

  it('closes nothing when the fetch fails', async () => {
    await run(boardReturning([job()]));
    await run(boardReturning([], 503));

    const { rows } = await pool.query<{ closed_at: Date | null; absent_run_count: number }>(
      'SELECT closed_at, absent_run_count FROM job_posting',
    );
    expect(rows[0]!.closed_at).toBeNull();
    expect(rows[0]!.absent_run_count).toBe(0);
  });

  it('fails the run rather than ingesting nothing on a shape change', async () => {
    await run(boardReturning([job()]));

    const brokenShape = (async () =>
      new Response(JSON.stringify({ postings: [] }), { status: 200 })) as unknown as typeof fetch;

    const outcome = await run(brokenShape);
    expect(outcome.status).toBe('failure');
    expect(outcome.error).toMatch(/jobs array/);

    const { rows } = await pool.query<{ closed_at: Date | null }>(
      'SELECT closed_at FROM job_posting',
    );
    expect(rows[0]!.closed_at).toBeNull();
  });

  it('skips a disabled source without touching it', async () => {
    await pool.query(`UPDATE career_source SET status = 'disabled'`);
    const outcome = await run(boardReturning([job()]));

    expect(outcome.status).toBe('skipped');
    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_posting',
    );
    expect(rows[0]!.count).toBe(0);
  });

  it('keeps the first record when a board repeats an id', async () => {
    const outcome = await run(
      boardReturning([job(), job({ title: 'Duplicate Id Posting' })]),
    );
    expect(outcome.postingsSeen).toBe(1);

    const { rows } = await pool.query<{ canonical_title: string }>(
      'SELECT canonical_title FROM job_posting',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.canonical_title).toBe('Senior Frontend Engineer');
  });
});

describe('grouping', () => {
  it('links a repost without merging the postings', async () => {
    await run(boardReturning([job()]));
    await run(boardReturning([]));
    // Close the original by hand: the guard correctly refuses to close on an
    // empty board, and a repost needs a closed predecessor.
    await pool.query(`UPDATE job_posting SET closed_at = now(), absent_run_count = 2`);

    await run(boardReturning([job({ id: 7099 })]));

    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_posting',
    );
    // Both postings still exist. Nothing was merged away.
    expect(rows[0]!.count).toBe(2);

    const { rows: links } = await pool.query<{ reason: string; confidence: string }>(
      'SELECT reason, confidence FROM job_group_link ORDER BY linked_at',
    );
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links.some((l) => l.reason === 'repost')).toBe(true);

    const { rows: flagged } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_posting WHERE is_repost = true',
    );
    expect(flagged[0]!.count).toBe(1);
  });

  it('does not link postings with different titles', async () => {
    await run(
      boardReturning([job(), job({ id: 7002, title: 'Backend Engineer' })]),
    );
    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_group_link',
    );
    expect(rows[0]!.count).toBe(0);
  });

  it('does not link merely similar roles at the same company', async () => {
    // Bias is toward under-linking: a duplicate card is an annoyance, a wrong
    // link hides a job the user needed and they never find out.
    await run(
      boardReturning([
        job(),
        job({
          id: 7003,
          title: 'Senior Frontend Engineer',
          content: '&lt;p&gt;Completely different role in a different domain entirely.&lt;/p&gt;',
        }),
      ]),
    );

    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_group_link',
    );
    expect(rows[0]!.count).toBe(0);
  });

  it('leaves both postings intact when a link is removed', async () => {
    await run(boardReturning([job()]));
    await pool.query(`UPDATE job_posting SET closed_at = now()`);
    await run(boardReturning([job({ id: 7099 })]));

    await pool.query('DELETE FROM job_group_link');

    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_posting',
    );
    // Reversibility is the whole reason grouping links instead of merging.
    expect(rows[0]!.count).toBe(2);
  });
});
