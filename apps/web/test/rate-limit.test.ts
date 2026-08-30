import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, migrate, type Pool } from '@jobswitch/db';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createNoopMailer } from '../src/services/mailer.js';

/**
 * Rate limiting, on a server built with the limits enabled.
 *
 * The rest of the suite runs with RATE_LIMIT_ENABLED=false so that repeated
 * signups do not trip the limiter mid-test. That is only acceptable because
 * the limits are genuinely exercised here.
 */

const DB_URL =
  process.env.DATABASE_URL_TEST ??
  'postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test';

let app: FastifyInstance;
let pool: Pool;

beforeAll(async () => {
  pool = createPool({ connectionString: DB_URL, max: 3 });
  await migrate(pool);

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-32',
    MAIL_TRANSPORT: 'noop',
    RATE_LIMIT_ENABLED: 'true',
  });

  app = await buildServer({ config, pool, mailer: createNoopMailer() });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const formHeaders = {
  'content-type': 'application/x-www-form-urlencoded',
  accept: 'application/json',
};

describe('rate limiting', () => {
  it('locks out repeated failed logins', async () => {
    // The credential-stuffing defence: 10 per 15 minutes, then 429.
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: new URLSearchParams({
          email: 'attacker-target@example.com',
          password: 'guessing-a-password',
        }).toString(),
        headers: formHeaders,
      });

    const codes: number[] = [];
    for (let i = 0; i < 13; i += 1) {
      codes.push((await attempt()).statusCode);
    }

    expect(codes.filter((c) => c === 401).length).toBe(10);
    expect(codes.filter((c) => c === 429).length).toBe(3);
  });

  it('returns a structured error body when limited', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: new URLSearchParams({
        email: 'attacker-target@example.com',
        password: 'guessing-a-password',
      }).toString(),
      headers: formHeaders,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limited');
  });

  it('does not rate-limit health checks', async () => {
    // An uptime monitor polling /healthz must never be throttled into
    // reporting a false outage.
    for (let i = 0; i < 30; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
    }
  });
});
