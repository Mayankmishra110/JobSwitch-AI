import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, migrate, type Pool } from '@jobswitch/db';
import { loadConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createNoopMailer } from '../src/services/mailer.js';
import type { AIClient, TailorResult } from '../src/services/aiClient.js';
import type { TailorHttpClient } from '../src/services/tailorClient.js';

/**
 * Application tracker + tailor routes (Phase 7). The AI call itself is the
 * paid, nondeterministic boundary (services/ai's own real LLM) - per this
 * project's standing rule, a fake AIClient stands in here so these tests
 * assert wiring (status transitions, artifact persistence, event
 * publishing) deterministically, not services/ai's own behavior (covered
 * by that service's own test suite).
 */

const DB_URL =
  process.env.DATABASE_URL_TEST ??
  'postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test';

let app: FastifyInstance;
let pool: Pool;
let config: Config;
let fakeAI: { tailorResume: (input: unknown) => Promise<TailorResult>; calls: unknown[] };

const jsonHeaders = { accept: 'application/json', 'content-type': 'application/json' };
const acceptHeaders = { accept: 'application/json' };

function makeFakeAIClient(): AIClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  const response: TailorResult = {
    status: 'proposed',
    tex: 'spliced tex',
    proposedChanges: [{ field: 'summary', rewritten: 'A stronger summary.', sourceFactRefs: ['current_title'] }],
    flags: [],
    model: 'fake-model',
    promptVersion: 1,
  };
  return {
    calls,
    async tailorResume(input) {
      calls.push(input);
      return response;
    },
  };
}

const noopTailorClient: TailorHttpClient = {
  async reinject() {
    throw new Error('not used by applications.test.ts');
  },
  async compile() {
    throw new Error('not used by applications.test.ts');
  },
};

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

  fakeAI = makeFakeAIClient();
  app = await buildServer({
    config,
    pool,
    mailer: createNoopMailer(),
    aiClient: fakeAI,
    tailorClient: noopTailorClient,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  fakeAI.calls.length = 0;
  await pool.query('DELETE FROM resume_artifact');
  await pool.query('DELETE FROM application_event');
  await pool.query('DELETE FROM job_application');
  await pool.query('DELETE FROM resume_source');
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

describe('POST /api/v1/applications', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/applications', headers: jsonHeaders, payload: '{}' });
    expect(res.statusCode).toBe(401);
  });

  it('creates a manual application and logs the initial found event', async () => {
    const cookie = await signupAndGetCookie('apps-create@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({
        manualCompany: 'Acme',
        manualTitle: 'Backend Engineer',
        manualJdText: 'Write services in Go.',
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().application).toMatchObject({ status: 'found', source: 'manual' });
  });

  it('rejects a request missing required fields', async () => {
    const cookie = await signupAndGetCookie('apps-invalid@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ manualCompany: 'Acme' }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/applications/:id', () => {
  it('includes events, artifacts, and outreach for the application', async () => {
    const cookie = await signupAndGetCookie('apps-detail@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ manualCompany: 'Acme', manualTitle: 'Engineer', manualJdText: 'JD text.' }),
    });
    const id = created.json().application.id;

    const res = await app.inject({ method: 'GET', url: `/api/v1/applications/${id}`, headers: { ...acceptHeaders, cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.application.id).toBe(id);
    expect(body.events).toHaveLength(1);
    expect(body.artifacts).toEqual([]);
    expect(body.outreach).toEqual([]);
  });

  it('404s for another account\'s application', async () => {
    const cookieA = await signupAndGetCookie('apps-detail-a@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { ...jsonHeaders, cookie: cookieA },
      payload: JSON.stringify({ manualCompany: 'Acme', manualTitle: 'Engineer', manualJdText: 'JD text.' }),
    });
    const id = created.json().application.id;

    const cookieB = await signupAndGetCookie('apps-detail-b@example.com');
    const res = await app.inject({ method: 'GET', url: `/api/v1/applications/${id}`, headers: { ...acceptHeaders, cookie: cookieB } });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/v1/applications/:id', () => {
  it('updates status and notes, writing an application_event only for the status change', async () => {
    const cookie = await signupAndGetCookie('apps-patch@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ manualCompany: 'Acme', manualTitle: 'Engineer', manualJdText: 'JD text.' }),
    });
    const id = created.json().application.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/applications/${id}`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ status: 'applied', notes: 'Applied through the careers page.' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().application).toMatchObject({ status: 'applied', notes: 'Applied through the careers page.' });

    const detail = await app.inject({ method: 'GET', url: `/api/v1/applications/${id}`, headers: { ...acceptHeaders, cookie } });
    expect(detail.json().events).toHaveLength(2);
  });
});

describe('POST /api/v1/applications/:id/tailor', () => {
  async function createApplicationAndResume(cookie: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ manualCompany: 'Acme', manualTitle: 'Engineer', manualJdText: 'Write great code.' }),
    });
    const id = created.json().application.id;

    const source = await app.inject({
      method: 'PUT',
      url: '/api/v1/profile/resume-source/main',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ label: 'Main', pdfBaseName: 'resume', tex: '\\documentclass{article}\\begin{document}Engineer\\end{document}' }),
    });
    expect(source.statusCode).toBe(200);

    return id;
  }

  it('calls the AI client with the assembled job context and facts, and persists a proposed artifact', async () => {
    const cookie = await signupAndGetCookie('tailor-happy@example.com');
    const id = await createApplicationAndResume(cookie);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${id}/tailor`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ variantId: 'main' }),
    });
    expect(res.statusCode).toBe(200);
    const artifact = res.json().artifact;
    expect(artifact.status).toBe('proposed');
    expect(artifact.proposedChanges).toHaveLength(1);
    expect(artifact.tex).toBe('spliced tex');

    expect(fakeAI.calls).toHaveLength(1);
    const call = fakeAI.calls[0] as { job: { title: string }; tex: string };
    expect(call.job.title).toBe('Engineer');
    expect(call.tex).toContain('\\documentclass');

    const detail = await app.inject({ method: 'GET', url: `/api/v1/applications/${id}`, headers: { ...acceptHeaders, cookie } });
    expect(detail.json().application.status).toBe('tailoring');
  });

  it('404s when the resume variant does not exist', async () => {
    const cookie = await signupAndGetCookie('tailor-no-resume@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ manualCompany: 'Acme', manualTitle: 'Engineer', manualJdText: 'JD text.' }),
    });
    const id = created.json().application.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/applications/${id}/tailor`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ variantId: 'nonexistent' }),
    });
    expect(res.statusCode).toBe(404);
    expect(fakeAI.calls).toHaveLength(0);
  });
});
