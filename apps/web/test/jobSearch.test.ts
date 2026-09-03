import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, migrate, type Pool } from '@jobswitch/db';
import { loadConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createNoopMailer } from '../src/services/mailer.js';

/**
 * Job search lifecycle route tests (ADR D-31).
 *
 * The purge guarantee itself is proven at the repository/RLS layer
 * (packages/db/test/jobSearch.test.ts) - what matters here is that the
 * routes are wired correctly: auth required, validation, and the 404 when
 * there is nothing active to stop.
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
  await pool.query('DELETE FROM resume_artifact');
  await pool.query('DELETE FROM resume_source');
  await pool.query('DELETE FROM resume_upload');
  await pool.query('DELETE FROM job_search_session');
  await pool.query('DELETE FROM candidate_profile');
  await pool.query('DELETE FROM profile_skill');
  await pool.query('DELETE FROM profile_experience');
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM password_reset_token');
  await pool.query('DELETE FROM user_session');
  await pool.query('DELETE FROM user_credential');
  await pool.query('DELETE FROM oauth_identity');
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

describe('GET /api/v1/job-search/status', () => {
  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/job-search/status',
      headers: acceptHeaders,
    });
    expect(res.statusCode).toBe(401);
  });

  it('reports inactive for a freshly signed-up account', async () => {
    const cookie = await signupAndGetCookie('status-fresh@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/job-search/status',
      headers: { ...acceptHeaders, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false, session: null, resume: null });
  });
});

describe('POST /api/v1/job-search/start', () => {
  it('activates a session and records the resume', async () => {
    const cookie = await signupAndGetCookie('start@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/job-search/start',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({
        filename: 'resume.pdf',
        rawText: 'A' + 'x'.repeat(60), // past the 50-char minimum
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().session.status).toBe('active');
    expect(res.json().resume.filename).toBe('resume.pdf');

    const status = await app.inject({
      method: 'GET',
      url: '/api/v1/job-search/status',
      headers: { ...acceptHeaders, cookie },
    });
    expect(status.json().active).toBe(true);
  });

  it('rejects a resume that is too short to be real', async () => {
    const cookie = await signupAndGetCookie('start-short@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/job-search/start',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ filename: 'resume.pdf', rawText: 'too short' }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/v1/job-search/stop', () => {
  async function start(cookie: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/job-search/start',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ filename: 'resume.pdf', rawText: 'A' + 'x'.repeat(60) }),
    });
  }

  it('returns 404 when there is nothing active to stop', async () => {
    const cookie = await signupAndGetCookie('stop-none@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/job-search/stop',
      headers: { ...acceptHeaders, cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('stops the session and reports which tables were purged', async () => {
    const cookie = await signupAndGetCookie('stop-active@example.com');
    await start(cookie);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/job-search/stop',
      headers: { ...acceptHeaders, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().session.status).toBe('stopped');
    expect(res.json().purgedTables).toContain('resume_upload');

    const status = await app.inject({
      method: 'GET',
      url: '/api/v1/job-search/status',
      headers: { ...acceptHeaders, cookie },
    });
    expect(status.json().active).toBe(false);
  });

  it('never leaks one account\'s stop into another\'s data', async () => {
    const cookieA = await signupAndGetCookie('stop-tenant-a@example.com');
    const cookieB = await signupAndGetCookie('stop-tenant-b@example.com');
    await start(cookieA);
    await start(cookieB);

    await app.inject({
      method: 'POST',
      url: '/api/v1/job-search/stop',
      headers: { ...acceptHeaders, cookie: cookieA },
    });

    const statusB = await app.inject({
      method: 'GET',
      url: '/api/v1/job-search/status',
      headers: { ...acceptHeaders, cookie: cookieB },
    });
    expect(statusB.json().active).toBe(true);
  });
});
