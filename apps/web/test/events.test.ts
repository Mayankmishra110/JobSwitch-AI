import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, migrate, type Pool } from '@jobswitch/db';
import { loadConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createNoopMailer } from '../src/services/mailer.js';
import { createEventBus, type EventBus } from '../src/services/events.js';

/**
 * D-26's SSE bridge, tested against a real running NATS (docker-compose's
 * `nats` service) and a real listening HTTP server - `app.inject()` can't
 * exercise this route meaningfully, since it only returns a response once
 * the handler itself returns, which for a live SSE stream only happens on
 * disconnect. A real `fetch` against a real socket, reading the response
 * body as it streams, is the only way to prove this actually works.
 */

const DB_URL =
  process.env.DATABASE_URL_TEST ??
  'postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test';
const NATS_URL = process.env.NATS_URL_TEST ?? 'nats://127.0.0.1:4222';

let app: FastifyInstance;
let pool: Pool;
let config: Config;
let events: EventBus;
let baseUrl: string;

const jsonHeaders = { accept: 'application/json', 'content-type': 'application/json' };
const acceptHeaders = { accept: 'application/json' };

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

/** Parses SSE `event:`/`data:` lines out of a streamed response body,
 * resolving once `count` real (non-comment) events have arrived. */
async function readSSEEvents(
  response: Response,
  count: number,
  timeoutMs = 5000,
): Promise<Array<{ event: string; data: unknown }>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const results: Array<{ event: string; data: unknown }> = [];
  let buffer = '';

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out waiting for ${count} SSE event(s)`)), timeoutMs),
  );

  const read = (async () => {
    while (results.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIndex: number;
      while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        if (block.startsWith(':')) continue; // keepalive comment

        const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
        if (!eventLine || !dataLine) continue;
        results.push({
          event: eventLine.slice('event: '.length),
          data: JSON.parse(dataLine.slice('data: '.length)),
        });
        if (results.length >= count) return results;
      }
    }
    return results;
  })();

  try {
    return await Promise.race([read, timeout]);
  } finally {
    await reader.cancel().catch(() => {});
  }
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
    NATS_URL,
  });

  events = createEventBus(NATS_URL);
  app = await buildServer({ config, pool, mailer: createNoopMailer(), events });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('expected a real TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app?.close();
  await events?.close();
  await pool?.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM job_search_session');
  await pool.query('DELETE FROM resume_upload');
  await pool.query('DELETE FROM account_member');
  await pool.query('DELETE FROM app_user');
  await pool.query('DELETE FROM account');
});

describe('GET /api/v1/events/stream', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/events/stream' });
    expect(res.statusCode).toBe(401);
  });

  it('streams a real event published on the bus for this account', async () => {
    const cookie = await signupAndGetCookie('sse-direct@example.com');

    const stream = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: { cookie, accept: 'text/event-stream' },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream');

    // Read the account id back off the session by hitting /api/v1/me
    // through the same cookie, rather than parsing the cookie ourselves.
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    const accountId = me.json().account.id as string;

    const received = readSSEEvents(stream, 1);
    await events.publish(accountId, 'test.event', { hello: 'world' });

    const result = await received;
    expect(result).toEqual([{ event: 'test.event', data: { hello: 'world' } }]);
  });

  it('never receives another account\'s events', async () => {
    const cookieA = await signupAndGetCookie('sse-tenant-a@example.com');
    const meA = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: cookieA } });
    const accountA = meA.json().account.id as string;

    const cookieB = await signupAndGetCookie('sse-tenant-b@example.com');
    const meB = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: cookieB } });
    const accountB = meB.json().account.id as string;

    const stream = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: { cookie: cookieA, accept: 'text/event-stream' },
    });

    const received = readSSEEvents(stream, 1, 1500);
    await events.publish(accountB, 'test.event', { hello: 'wrong-account' });
    await events.publish(accountA, 'test.event', { hello: 'right-account' });

    // The wrong-account publish must never surface; the first (only) event
    // this stream sees must be the one addressed to its own account.
    const result = await received;
    expect(result).toEqual([{ event: 'test.event', data: { hello: 'right-account' } }]);
  });

  it('a real job-search stop publishes job_search.stopped, received live', async () => {
    const cookie = await signupAndGetCookie('sse-stop@example.com');
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    const accountId = me.json().account.id as string;

    await app.inject({
      method: 'POST',
      url: '/api/v1/job-search/start',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ filename: 'r.pdf', rawText: 'x'.repeat(60) }),
    });

    const stream = await fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: { cookie, accept: 'text/event-stream' },
    });
    const received = readSSEEvents(stream, 1);

    const stopRes = await app.inject({
      method: 'POST',
      url: '/api/v1/job-search/stop',
      headers: { ...acceptHeaders, cookie },
    });
    expect(stopRes.statusCode).toBe(200);

    const result = await received;
    expect(result).toHaveLength(1);
    expect(result[0]!.event).toBe('job_search.stopped');
    expect(result[0]!.data).toMatchObject({ accountId, purgedTables: expect.arrayContaining(['resume_upload']) });
  });
});
