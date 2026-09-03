import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, migrate, type Pool } from '@jobswitch/db';
import { loadConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createNoopMailer } from '../src/services/mailer.js';

/**
 * Profile route tests (Phase 4).
 *
 * Tenant isolation itself is proven at the repository/RLS layer
 * (packages/db/test/profile.test.ts) - what matters here is that each route
 * scopes every call to request.principal.accountId rather than trusting
 * anything from the request body, and that validation and not-found cases
 * behave as documented.
 */

const DB_URL =
  process.env.DATABASE_URL_TEST ??
  'postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test';

let app: FastifyInstance;
let pool: Pool;
let config: Config;

const jsonHeaders = { accept: 'application/json', 'content-type': 'application/json' };
// GET and DELETE send no body here, and Fastify's JSON parser rejects an
// empty body when content-type says otherwise - so those calls use this
// instead, not jsonHeaders.
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
  await pool.query('DELETE FROM profile_experience');
  await pool.query('DELETE FROM profile_skill');
  await pool.query('DELETE FROM candidate_profile');
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

describe('GET /api/v1/profile', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/profile', headers: acceptHeaders });
    expect(res.statusCode).toBe(401);
  });

  it('returns an empty profile for a freshly signed-up account', async () => {
    const cookie = await signupAndGetCookie('fresh@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/profile',
      headers: { ...acceptHeaders, cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile).toBeNull();
    expect(body.skills).toEqual([]);
    expect(body.experience).toEqual([]);
  });
});

describe('PUT /api/v1/profile', () => {
  it('creates the profile on first write and updates it on the next', async () => {
    const cookie = await signupAndGetCookie('writer@example.com');

    const first = await app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ headline: 'Senior Engineer', currentTitle: 'Backend Engineer' }),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().profile.headline).toBe('Senior Engineer');

    const second = await app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ headline: 'Staff Engineer' }),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().profile.headline).toBe('Staff Engineer');
    // currentTitle was omitted from the second call, so it should survive.
    expect(second.json().profile.currentTitle).toBe('Backend Engineer');
  });

  it('rejects an invalid currency code', async () => {
    const cookie = await signupAndGetCookie('badcurrency@example.com');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ desiredSalaryCurrency: 'RUP' + 'EE' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('never leaks one account\'s profile into another\'s response', async () => {
    const cookieA = await signupAndGetCookie('tenant-a@example.com');
    const cookieB = await signupAndGetCookie('tenant-b@example.com');

    await app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: { ...jsonHeaders, cookie: cookieA },
      payload: JSON.stringify({ headline: 'Tenant A only' }),
    });

    const resB = await app.inject({
      method: 'GET',
      url: '/api/v1/profile',
      headers: { ...acceptHeaders, cookie: cookieB },
    });
    expect(resB.json().profile).toBeNull();
  });
});

describe('PUT /api/v1/profile/skills', () => {
  it('replaces the skill list and de-duplicates case-insensitively', async () => {
    const cookie = await signupAndGetCookie('skills@example.com');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/profile/skills',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ skills: ['React', 'react', 'SQL'] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().skills.map((s: { skill: string }) => s.skill).sort()).toEqual(['React', 'SQL']);
  });

  it('rejects more than 100 skills', async () => {
    const cookie = await signupAndGetCookie('manyskills@example.com');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/profile/skills',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ skills: Array.from({ length: 101 }, (_, i) => `skill-${i}`) }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('experience', () => {
  async function addEntry(cookie: string, overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/profile/experience',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({
        company: 'Acme',
        title: 'Engineer',
        startDate: '2021-01-01',
        isCurrent: true,
        ...overrides,
      }),
    });
  }

  it('adds an entry and returns 201', async () => {
    const cookie = await signupAndGetCookie('exp-add@example.com');
    const res = await addEntry(cookie);
    expect(res.statusCode).toBe(201);
    expect(res.json().experience.company).toBe('Acme');
  });

  it('rejects a current role that also has an end date', async () => {
    const cookie = await signupAndGetCookie('exp-invalid@example.com');
    const res = await addEntry(cookie, { isCurrent: true, endDate: '2022-01-01' });
    expect(res.statusCode).toBe(400);
  });

  it('updates only the fields sent, and clears the end date when marking current again', async () => {
    const cookie = await signupAndGetCookie('exp-update@example.com');
    const created = await addEntry(cookie, {
      isCurrent: false,
      endDate: '2022-01-01',
      description: 'Original description',
    });
    const id = created.json().experience.id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/profile/experience/${id}`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ isCurrent: true }),
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().experience.isCurrent).toBe(true);
    expect(patched.json().experience.endDate).toBeNull();
    // Untouched fields survive the patch.
    expect(patched.json().experience.description).toBe('Original description');
  });

  it('returns 404 for an experience id under a different account', async () => {
    const cookieA = await signupAndGetCookie('exp-owner@example.com');
    const cookieB = await signupAndGetCookie('exp-other@example.com');
    const created = await addEntry(cookieA);
    const id = created.json().experience.id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/profile/experience/${id}`,
      headers: { ...acceptHeaders, cookie: cookieB },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a malformed id rather than a 500', async () => {
    const cookie = await signupAndGetCookie('exp-badid@example.com');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/profile/experience/not-a-uuid',
      headers: { ...acceptHeaders, cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('deletes an entry, and a second delete also 404s', async () => {
    const cookie = await signupAndGetCookie('exp-delete@example.com');
    const created = await addEntry(cookie);
    const id = created.json().experience.id;

    const first = await app.inject({
      method: 'DELETE',
      url: `/api/v1/profile/experience/${id}`,
      headers: { ...acceptHeaders, cookie },
    });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({
      method: 'DELETE',
      url: `/api/v1/profile/experience/${id}`,
      headers: { ...acceptHeaders, cookie },
    });
    expect(second.statusCode).toBe(404);
  });
});
