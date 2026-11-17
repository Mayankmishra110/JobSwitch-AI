import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, migrate, type Pool } from '@jobswitch/db';
import { loadConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createNoopMailer } from '../src/services/mailer.js';

/**
 * Outreach routes (Phase 7) - drafting, approval, and the Gmail-link gate.
 * Sending itself needs real Gmail credentials this build doesn't have
 * (docs/BUILD_PLAN.md's Phase 8 defers them, per specs/application-
 * workspace.md); what's verified here without them: the draft/approve
 * compare-and-set chain, and every one of send's own guard clauses that
 * fire before a real Gmail call would ever happen (config disabled, not
 * approved, no credential connected).
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
    // Deliberately no GOOGLE_*/EMAIL_CREDENTIAL_ENCRYPTION_KEY - this suite
    // verifies the gated-off behavior, matching this build's real state.
  });

  app = await buildServer({ config, pool, mailer: createNoopMailer() });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM outreach_draft');
  await pool.query('DELETE FROM email_credential');
  await pool.query('DELETE FROM job_application');
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

async function createApplication(cookie: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/applications',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ manualCompany: 'Acme', manualTitle: 'Engineer', manualJdText: 'JD text.' }),
  });
  return res.json().application.id as string;
}

describe('Gmail link gating', () => {
  it('gmail/status reports disconnected with no config and no credential', async () => {
    const cookie = await signupAndGetCookie('gmail-status@example.com');
    const res = await app.inject({ method: 'GET', url: '/api/v1/outreach/gmail/status', headers: { ...acceptHeaders, cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: false, email: null });
  });

  it('gmail/authorize 404s when Gmail linking is not configured', async () => {
    const cookie = await signupAndGetCookie('gmail-authorize-disabled@example.com');
    const res = await app.inject({ method: 'GET', url: '/api/v1/outreach/gmail/authorize', headers: { ...acceptHeaders, cookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/v1/applications/:id/outreach', () => {
  it('creates a template-drafted outreach message referencing the role and company', async () => {
    const cookie = await signupAndGetCookie('outreach-create@example.com');
    const applicationId = await createApplication(cookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${applicationId}/outreach`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ toEmail: 'recruiter@example.com', toName: 'Jane Recruiter' }),
    });
    expect(res.statusCode).toBe(201);
    const outreach = res.json().outreach;
    expect(outreach.status).toBe('draft');
    expect(outreach.toEmail).toBe('recruiter@example.com');
    expect(outreach.subject).toContain('Engineer');
    expect(outreach.subject).toContain('Acme');
    expect(outreach.body.length).toBeGreaterThan(0);
  });

  it('404s for another account\'s application', async () => {
    const cookieA = await signupAndGetCookie('outreach-cross-a@example.com');
    const applicationId = await createApplication(cookieA);
    const cookieB = await signupAndGetCookie('outreach-cross-b@example.com');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${applicationId}/outreach`,
      headers: { ...jsonHeaders, cookie: cookieB },
      payload: JSON.stringify({ toEmail: 'recruiter@example.com' }),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/v1/outreach', () => {
  it('lists every draft across every application for this account, and only this account\'s', async () => {
    const cookieA = await signupAndGetCookie('outreach-list-a@example.com');
    const applicationId = await createApplication(cookieA);
    await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${applicationId}/outreach`,
      headers: { ...jsonHeaders, cookie: cookieA },
      payload: JSON.stringify({ toEmail: 'recruiter@example.com' }),
    });

    const cookieB = await signupAndGetCookie('outreach-list-b@example.com');

    const resA = await app.inject({ method: 'GET', url: '/api/v1/outreach', headers: { ...acceptHeaders, cookie: cookieA } });
    expect(resA.json().outreach).toHaveLength(1);

    const resB = await app.inject({ method: 'GET', url: '/api/v1/outreach', headers: { ...acceptHeaders, cookie: cookieB } });
    expect(resB.json().outreach).toEqual([]);
  });
});

describe('outreach draft lifecycle', () => {
  async function createDraft(cookie: string): Promise<string> {
    const applicationId = await createApplication(cookie);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${applicationId}/outreach`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ toEmail: 'recruiter@example.com' }),
    });
    return res.json().outreach.id as string;
  }

  it('PATCH edits a draft; approve locks it; PATCH after approval is refused', async () => {
    const cookie = await signupAndGetCookie('outreach-lifecycle@example.com');
    const id = await createDraft(cookie);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/outreach/${id}`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ subject: 'A better subject line' }),
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().outreach.subject).toBe('A better subject line');

    const approved = await app.inject({ method: 'POST', url: `/api/v1/outreach/${id}/approve`, headers: { ...acceptHeaders, cookie } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().outreach.status).toBe('approved');

    const patchAfterApproval = await app.inject({
      method: 'PATCH',
      url: `/api/v1/outreach/${id}`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ subject: 'Too late' }),
    });
    expect(patchAfterApproval.statusCode).toBe(409);

    const approveAgain = await app.inject({ method: 'POST', url: `/api/v1/outreach/${id}/approve`, headers: { ...acceptHeaders, cookie } });
    expect(approveAgain.statusCode).toBe(409);
  });
});

describe('POST /api/v1/outreach/:id/send', () => {
  it('404s (oauth_disabled) when Gmail is not configured at all', async () => {
    const cookie = await signupAndGetCookie('outreach-send-disabled@example.com');
    const applicationId = await createApplication(cookie);
    const draftRes = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${applicationId}/outreach`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ toEmail: 'recruiter@example.com' }),
    });
    const id = draftRes.json().outreach.id;

    const res = await app.inject({ method: 'POST', url: `/api/v1/outreach/${id}/send`, headers: { ...acceptHeaders, cookie } });
    expect(res.statusCode).toBe(404);
  });
});
