import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, migrate, type Pool } from '@jobswitch/db';
import { loadConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createNoopMailer } from '../src/services/mailer.js';

/**
 * Matches feed routes (Phase 7). RLS/tenant isolation itself is proven at
 * the repository layer (packages/db/test/applicationWorkspace.test.ts) -
 * what matters here is auth, the dismiss/track wiring, and status codes.
 */

const DB_URL =
  process.env.DATABASE_URL_TEST ??
  'postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test';

let app: FastifyInstance;
let pool: Pool;
let config: Config;

const jsonHeaders = { accept: 'application/json', 'content-type': 'application/json' };
const acceptHeaders = { accept: 'application/json' };

beforeAll(async () => {
  pool = createPool({ connectionString: DB_URL, max: 5 });
  await migrate(pool);

  config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-32',
    APP_ORIGIN: 'http://localhost:3000',
    MAIL_TRANSPORT: 'noop',
    RATE_LIMIT_ENABLED: 'false',
  });

  app = await buildServer({ config, pool, mailer: createNoopMailer() });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM job_application');
  await pool.query('DELETE FROM job_match');
  await pool.query("DELETE FROM job_posting_location");
  await pool.query('DELETE FROM job_posting_version');
  await pool.query('DELETE FROM job_posting');
  await pool.query('DELETE FROM career_source');
  await pool.query('DELETE FROM company');
  await pool.query('DELETE FROM account_member');
  await pool.query('DELETE FROM app_user');
  await pool.query('DELETE FROM account');
});

function sessionCookie(response: { cookies: Array<Record<string, unknown>> }): string {
  const c = response.cookies.find((x) => x.name === 'js_session');
  if (!c) throw new Error('signup did not set a session cookie');
  return `js_session=${String(c.value)}`;
}

async function signupAndGetCookie(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    headers: jsonHeaders,
    payload: JSON.stringify({ email, password: 'correct-horse-battery', fullName: 'Test User' }),
  });
  expect(res.statusCode).toBe(201);
  return sessionCookie(res);
}

async function meAccountId(cookie: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
  return res.json().account.id as string;
}

async function seedMatch(accountId: string): Promise<string> {
  const companyId = (
    await pool.query<{ id: string }>(
      `INSERT INTO company (name, normalized_domain) VALUES ('Route Test Co', 'routetestco.example') RETURNING id`,
    )
  ).rows[0]!.id;
  const sourceId = (
    await pool.query<{ id: string }>(
      `INSERT INTO career_source (company_id, ats_type, board_identifier)
       VALUES ($1, 'greenhouse', 'routetestco') RETURNING id`,
      [companyId],
    )
  ).rows[0]!.id;
  const postingId = (
    await pool.query<{ id: string }>(
      `INSERT INTO job_posting (career_source_id, company_id, source_job_id, canonical_title, normalized_title, apply_url)
       VALUES ($1, $2, 'job-route-1', 'Engineer', 'engineer', 'https://example.com/apply') RETURNING id`,
      [sourceId, companyId],
    )
  ).rows[0]!.id;
  const versionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO job_posting_version (job_posting_id, content_fingerprint, title, description_text)
       VALUES ($1, 'fp-route-1', 'Engineer', 'Do engineering things.') RETURNING id`,
      [postingId],
    )
  ).rows[0]!.id;
  await pool.query(`UPDATE job_posting SET current_version_id = $2 WHERE id = $1`, [postingId, versionId]);
  const matchId = (
    await pool.query<{ id: string }>(
      `INSERT INTO job_match
         (account_id, job_posting_id, job_posting_version_id, score, vector_score,
          keyword_score, skill_score, seniority_score, location_score, freshness_score, matcher_version)
       VALUES ($1, $2, $3, 0.75, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 1) RETURNING id`,
      [accountId, postingId, versionId],
    )
  ).rows[0]!.id;
  return matchId;
}

describe('GET /api/v1/matches', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/matches', headers: acceptHeaders });
    expect(res.statusCode).toBe(401);
  });

  it('lists this account\'s live matches, and only this account\'s', async () => {
    const cookieA = await signupAndGetCookie('matches-a@example.com');
    const accountA = await meAccountId(cookieA);
    const cookieB = await signupAndGetCookie('matches-b@example.com');

    const matchId = await seedMatch(accountA);

    const resA = await app.inject({ method: 'GET', url: '/api/v1/matches', headers: { ...acceptHeaders, cookie: cookieA } });
    expect(resA.statusCode).toBe(200);
    expect(resA.json().matches.map((m: { id: string }) => m.id)).toEqual([matchId]);

    const resB = await app.inject({ method: 'GET', url: '/api/v1/matches', headers: { ...acceptHeaders, cookie: cookieB } });
    expect(resB.json().matches).toEqual([]);
  });
});

describe('POST /api/v1/matches/:id/dismiss', () => {
  it('dismisses a match and it no longer appears in the feed', async () => {
    const cookie = await signupAndGetCookie('dismiss@example.com');
    const accountId = await meAccountId(cookie);
    const matchId = await seedMatch(accountId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/matches/${matchId}/dismiss`,
      headers: { ...acceptHeaders, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dismissed: true });

    const after = await app.inject({ method: 'GET', url: '/api/v1/matches', headers: { ...acceptHeaders, cookie } });
    expect(after.json().matches).toEqual([]);
  });

  it('404s for a match id that does not belong to this account', async () => {
    const cookieA = await signupAndGetCookie('dismiss-a@example.com');
    const accountA = await meAccountId(cookieA);
    const cookieB = await signupAndGetCookie('dismiss-b@example.com');
    const matchId = await seedMatch(accountA);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/matches/${matchId}/dismiss`,
      headers: { ...acceptHeaders, cookie: cookieB },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/v1/matches/:id/track', () => {
  it('creates a tracked application from the match, sourced "match"', async () => {
    const cookie = await signupAndGetCookie('track@example.com');
    const accountId = await meAccountId(cookie);
    const matchId = await seedMatch(accountId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/matches/${matchId}/track`,
      headers: { ...acceptHeaders, cookie },
    });
    expect(res.statusCode).toBe(201);
    const application = res.json().application;
    expect(application.source).toBe('match');
    expect(application.status).toBe('found');
    expect(application.postingTitle).toBe('Engineer');
  });

  it('tracking the same match twice returns the same application', async () => {
    const cookie = await signupAndGetCookie('track-twice@example.com');
    const accountId = await meAccountId(cookie);
    const matchId = await seedMatch(accountId);

    const first = await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/track`, headers: { ...acceptHeaders, cookie } });
    const second = await app.inject({ method: 'POST', url: `/api/v1/matches/${matchId}/track`, headers: { ...acceptHeaders, cookie } });
    expect(second.json().application.id).toBe(first.json().application.id);
  });
});
