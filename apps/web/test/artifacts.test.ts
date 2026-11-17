import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, migrate, type Pool } from '@jobswitch/db';
import { loadConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createNoopMailer } from '../src/services/mailer.js';
import type { AIClient } from '../src/services/aiClient.js';
import type { ReinjectResult, TailorHttpClient } from '../src/services/tailorClient.js';

/**
 * Resume artifact routes (Phase 7) - GET, PDF download, and compile.
 * apps/tailor is local/fast/deterministic and owned by this repo, so its
 * own test suite (apps/tailor/test) already verifies the real reinject/
 * compile behavior against real MiKTeX; a fake TailorHttpClient here keeps
 * these route tests fast and focused on wiring (staleness detection,
 * status transitions, PDF bytes round-tripping through the DB and back
 * out over HTTP) without needing a running apps/tailor process.
 */

const DB_URL =
  process.env.DATABASE_URL_TEST ??
  'postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test';

let app: FastifyInstance;
let pool: Pool;
let config: Config;
let fakeTailor: TailorHttpClient & {
  reinjectCalls: Array<{ tex: string; accepted: Array<{ field: string; rewritten: string }> }>;
  nextReinject: ReinjectResult | null;
  nextCompileError: Error | null;
};

const noopAIClient: AIClient = {
  async tailorResume() {
    throw new Error('not used by artifacts.test.ts');
  },
};

function makeFakeTailorClient() {
  // The methods below close over `self` (not a separately-spread snapshot),
  // so a test mutating `fakeTailor.nextReinject`/`nextCompileError` after
  // construction is read live on the next call - a plain `{...state}`
  // spread into the returned object would instead freeze both at their
  // construction-time (null) values, silently ignoring every later
  // mutation.
  const self = {
    reinjectCalls: [] as Array<{ tex: string; accepted: Array<{ field: string; rewritten: string }> }>,
    nextReinject: null as ReinjectResult | null,
    nextCompileError: null as Error | null,
    async reinject(tex: string, accepted: Array<{ field: string; rewritten: string }>) {
      self.reinjectCalls.push({ tex, accepted });
      return (
        self.nextReinject ?? {
          tex: `${tex} [spliced: ${accepted.map((a) => a.field).join(',')}]`,
          applied: accepted.map((a) => a.field),
          skipped: [],
          integrityOk: true,
        }
      );
    },
    async compile(tex: string) {
      if (self.nextCompileError) throw self.nextCompileError;
      return { pdfBytes: Buffer.from(`%PDF-1.4 [${tex}]`), pdfSha256: 'fake-pdf-sha' };
    },
  };
  return self;
}

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

  fakeTailor = makeFakeTailorClient();
  app = await buildServer({ config, pool, mailer: createNoopMailer(), aiClient: noopAIClient, tailorClient: fakeTailor });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  fakeTailor.reinjectCalls.length = 0;
  fakeTailor.nextReinject = null;
  fakeTailor.nextCompileError = null;
  await pool.query('DELETE FROM resume_artifact');
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
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: 'correct-horse-battery', fullName: 'Test User' }),
  });
  expect(res.statusCode).toBe(201);
  return sessionCookie(res);
}

const jsonHeaders = { accept: 'application/json', 'content-type': 'application/json' };
const acceptHeaders = { accept: 'application/json' };

/** Seeds a resume_source + a 'proposed' resume_artifact via the real routes/repos, returning both ids. */
async function seedProposedArtifact(
  cookie: string,
  proposedChanges: Array<{ field: string; rewritten: string; sourceFactRefs: string[] }>,
): Promise<{ applicationId: string; artifactId: string; sourceSha256: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/applications',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ manualCompany: 'Acme', manualTitle: 'Engineer', manualJdText: 'JD text.' }),
  });
  const applicationId = created.json().application.id;

  await app.inject({
    method: 'PUT',
    url: '/api/v1/profile/resume-source/main',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ label: 'Main', pdfBaseName: 'resume', tex: 'original tex' }),
  });
  const source = await app.inject({
    method: 'GET',
    url: '/api/v1/profile/resume-source/main',
    headers: { ...acceptHeaders, cookie },
  });
  const sourceSha256 = source.json().source.sha256 as string;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO resume_artifact (account_id, application_id, variant_id, source_sha256, status, proposed_changes, tex)
     SELECT account_id, $1, 'main', $2, 'proposed', $3::jsonb, 'graph-spliced tex'
     FROM job_application WHERE id = $1
     RETURNING id`,
    [
      applicationId,
      sourceSha256,
      JSON.stringify(
        proposedChanges.map((c) => ({ field: c.field, rewritten: c.rewritten, source_fact_refs: c.sourceFactRefs })),
      ),
    ],
  );
  return { applicationId, artifactId: rows[0]!.id, sourceSha256 };
}

describe('GET /api/v1/artifacts/:id', () => {
  it('404s for another account\'s artifact', async () => {
    const cookieA = await signupAndGetCookie('artifact-get-a@example.com');
    const { artifactId } = await seedProposedArtifact(cookieA, []);

    const cookieB = await signupAndGetCookie('artifact-get-b@example.com');
    const res = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${artifactId}`, headers: { ...acceptHeaders, cookie: cookieB } });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/v1/artifacts/:id/compile', () => {
  it('reinjects only the accepted fields against the ORIGINAL tex, compiles, and marks the application tailored', async () => {
    const cookie = await signupAndGetCookie('compile-happy@example.com');
    const { applicationId, artifactId } = await seedProposedArtifact(cookie, [
      { field: 'summary', rewritten: 'New summary', sourceFactRefs: ['current_title'] },
      { field: 'skills', rewritten: 'New skills', sourceFactRefs: ['skill:Go'] },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/compile`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ accepted: ['summary'] }),
    });
    expect(res.statusCode).toBe(200);
    const artifact = res.json().artifact;
    expect(artifact.status).toBe('compiled');
    expect(artifact.accepted).toEqual(['summary']);
    expect(artifact.pdfSha256).toBe('fake-pdf-sha');
    expect(artifact.hasPdf).toBe(true);

    // reinject was called against the ORIGINAL resume_source tex, not the
    // graph's own already-spliced draft - the exact bug class
    // specs/resume-tailoring.md documents for fabrication_check, one layer
    // up from here.
    expect(fakeTailor.reinjectCalls).toHaveLength(1);
    expect(fakeTailor.reinjectCalls[0]!.tex).toBe('original tex');
    expect(fakeTailor.reinjectCalls[0]!.accepted).toEqual([{ field: 'summary', rewritten: 'New summary' }]);

    const applicationRes = await app.inject({ method: 'GET', url: `/api/v1/applications/${applicationId}`, headers: { ...acceptHeaders, cookie } });
    expect(applicationRes.json().application.status).toBe('tailored');

    const pdfRes = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${artifactId}/pdf`, headers: { ...acceptHeaders, cookie } });
    expect(pdfRes.statusCode).toBe(200);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
    expect(pdfRes.headers['x-pdf-sha256']).toBe('fake-pdf-sha');
    expect(pdfRes.rawPayload.toString()).toContain('%PDF-1.4');
  });

  it('rejects an unknown accepted field id', async () => {
    const cookie = await signupAndGetCookie('compile-unknown-field@example.com');
    const { artifactId } = await seedProposedArtifact(cookie, [
      { field: 'summary', rewritten: 'New summary', sourceFactRefs: [] },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/compile`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ accepted: ['nonexistent-field'] }),
    });
    expect(res.statusCode).toBe(400);
    expect(fakeTailor.reinjectCalls).toHaveLength(0);
  });

  it('refuses to compile against a resume that changed since the proposal (stale sha256)', async () => {
    const cookie = await signupAndGetCookie('compile-stale@example.com');
    const { artifactId } = await seedProposedArtifact(cookie, [
      { field: 'summary', rewritten: 'New summary', sourceFactRefs: [] },
    ]);

    // Edit the resume template after the proposal was made.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/profile/resume-source/main',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ label: 'Main', pdfBaseName: 'resume', tex: 'a completely different tex' }),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/compile`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ accepted: [] }),
    });
    expect(res.statusCode).toBe(409);
    expect(fakeTailor.reinjectCalls).toHaveLength(0);
  });

  it('refuses to compile an artifact that is already compiled', async () => {
    const cookie = await signupAndGetCookie('compile-already@example.com');
    const { artifactId } = await seedProposedArtifact(cookie, []);

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/compile`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ accepted: [] }),
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/compile`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ accepted: [] }),
    });
    expect(second.statusCode).toBe(409);
  });

  it('marks the artifact failed and returns an error when apps/tailor rejects the compile', async () => {
    const cookie = await signupAndGetCookie('compile-fails@example.com');
    const { artifactId } = await seedProposedArtifact(cookie, []);
    fakeTailor.nextCompileError = new Error('compile failed: fabricated technology detected');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/compile`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ accepted: [] }),
    });
    expect(res.statusCode).toBe(409);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${artifactId}`, headers: { ...acceptHeaders, cookie } });
    expect(detail.json().artifact.status).toBe('failed');
    expect(detail.json().artifact.compileError).toContain('fabricated technology');
  });

  it('a reinject integrity failure marks the artifact failed rather than compiling anyway', async () => {
    const cookie = await signupAndGetCookie('compile-integrity@example.com');
    const { artifactId } = await seedProposedArtifact(cookie, [
      { field: 'summary', rewritten: 'New summary', sourceFactRefs: [] },
    ]);
    fakeTailor.nextReinject = {
      tex: 'corrupted',
      applied: [],
      skipped: ['summary'],
      integrityOk: false,
      integrityViolations: ['field summary drifted'],
    };

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/compile`,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ accepted: ['summary'] }),
    });
    expect(res.statusCode).toBe(409);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${artifactId}`, headers: { ...acceptHeaders, cookie } });
    expect(detail.json().artifact.status).toBe('failed');
  });
});
