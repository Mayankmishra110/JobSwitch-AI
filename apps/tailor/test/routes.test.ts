import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const FIXTURE = readFileSync(
  fileURLToPath(
    new URL('../../../packages/resume-core/test/fixtures/fullstack.tex', import.meta.url),
  ),
  'utf8',
);

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ config: loadConfig({ NODE_ENV: 'test' }) });
});

afterAll(async () => {
  await app.close();
});

describe('GET /healthz', () => {
  it('is open with no auth required', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('POST /v1/parse', () => {
  it('returns fields and structured data for a real resume', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/parse', payload: { tex: FIXTURE } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fields.length).toBeGreaterThan(0);
    expect(body.structured.experience).toHaveLength(3);
  });

  it('400s on a missing tex field', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/parse', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/validate-nouns', () => {
  it('flags a genuinely new proper noun', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/validate-nouns',
      payload: {
        tex: FIXTURE,
        changes: [
          { field: 'summary', original: 'x', rewritten: 'Kubernetes expert with deep platform experience.' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().flags.some((f: { token: string }) => f.token === 'Kubernetes')).toBe(true);
  });

  it('defaults changes to an empty array', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/validate-nouns',
      payload: { tex: FIXTURE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().flags).toEqual([]);
  });
});

describe('POST /v1/reinject', () => {
  it('applies an accepted change and reports integrityOk', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/reinject',
      payload: {
        tex: FIXTURE,
        accepted: [{ field: 'summary', rewritten: 'A short new summary.' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.integrityOk).toBe(true);
    expect(body.tex).toContain('A short new summary.');
    expect(body.skipped).toEqual([]);
  });

  it('skips an unsafe rewrite rather than corrupting the document', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/reinject',
      payload: {
        tex: FIXTURE,
        accepted: [{ field: 'summary', rewritten: 'Unbalanced {brace' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tex).toBe(FIXTURE);
    expect(body.skipped).toHaveLength(1);
  });
});

describe('internal token auth', () => {
  let guardedApp: FastifyInstance;

  beforeAll(async () => {
    guardedApp = await buildServer({
      config: loadConfig({ NODE_ENV: 'test', INTERNAL_TOKEN: 'secret-token' }),
    });
  });
  afterAll(async () => {
    await guardedApp.close();
  });

  it('rejects a /v1/* request with no token when one is configured', async () => {
    const res = await guardedApp.inject({ method: 'POST', url: '/v1/parse', payload: { tex: FIXTURE } });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a /v1/* request with the correct token', async () => {
    const res = await guardedApp.inject({
      method: 'POST',
      url: '/v1/parse',
      headers: { 'x-internal-token': 'secret-token' },
      payload: { tex: FIXTURE },
    });
    expect(res.statusCode).toBe(200);
  });

  it('never requires a token for /healthz, even when one is configured', async () => {
    const res = await guardedApp.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});
