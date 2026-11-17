import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

/**
 * Real compile, no fakes: shells out to whatever LATEX_ENGINE resolves to
 * locally (pdflatex, verified against MiKTeX) and confirms a genuine PDF
 * comes back - this is the one thing in this service that cannot be
 * meaningfully unit-tested any other way, per the project's standing rule
 * against mocking the thing actually under test.
 */

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

describe('POST /v1/compile', () => {
  it('compiles a real resume to a real PDF', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/compile', payload: { tex: FIXTURE } });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');

    const pdfBytes = res.rawPayload;
    expect(pdfBytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdfBytes.length).toBeGreaterThan(10_000); // a real 2-page resume, not a stub

    const expectedSha256 = createHash('sha256').update(pdfBytes).digest('hex');
    expect(res.headers['x-pdf-sha256']).toBe(expectedSha256);
  }, 30_000);

  it('returns 422 with the compiler log for a document that cannot compile', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/compile',
      payload: { tex: '\\documentclass{article}\\begin{document}\\undefinedcommand\\end{document}' },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('compile_failed');
    expect(body.log.length).toBeGreaterThan(0);
  }, 30_000);
});
