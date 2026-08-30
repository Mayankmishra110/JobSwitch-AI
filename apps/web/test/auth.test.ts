import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, migrate, type Pool } from '@jobswitch/db';
import { loadConfig, type Config } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createNoopMailer, type Mailer, type OutboundEmail } from '../src/services/mailer.js';

/**
 * Auth integration tests. Real Fastify, real Postgres, real Argon2 - no mocks
 * of the pieces whose behaviour is the thing under test.
 */

const DB_URL =
  process.env.DATABASE_URL_TEST ??
  'postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test';

let app: FastifyInstance;
let pool: Pool;
let config: Config;
const sent: OutboundEmail[] = [];

const captureMailer: Mailer = {
  async send(email) {
    sent.push(email);
  },
};

function form(fields: Record<string, string>): {
  payload: string;
  headers: Record<string, string>;
} {
  return {
    payload: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
}

/** Ask for JSON so routes take the API branch rather than rendering HTML. */
const jsonHeaders = { accept: 'application/json' };

beforeAll(async () => {
  pool = createPool({ connectionString: DB_URL, max: 5 });
  await migrate(pool);

  config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-32',
    APP_ORIGIN: 'http://localhost:3000',
    MAIL_TRANSPORT: 'noop',
    // Off here so the suite can exercise routes more often than a human
    // would. Limits are asserted in test/rate-limit.test.ts.
    RATE_LIMIT_ENABLED: 'false',
  });

  app = await buildServer({ config, pool, mailer: captureMailer });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  sent.length = 0;
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM password_reset_token');
  await pool.query('DELETE FROM user_session');
  await pool.query('DELETE FROM user_credential');
  await pool.query('DELETE FROM oauth_identity');
  await pool.query('DELETE FROM account_member');
  await pool.query('DELETE FROM app_user');
  await pool.query('DELETE FROM account');
});

async function signup(email: string, password = 'correct-horse-battery') {
  return app.inject({
    method: 'POST',
    url: '/auth/signup',
    ...form({ email, password, fullName: 'Test User' }),
    headers: { ...form({}).headers, ...jsonHeaders },
  });
}

function sessionCookie(response: { cookies: Array<Record<string, unknown>> }) {
  const c = response.cookies.find((x) => x.name === 'js_session');
  return c ? `js_session=${String(c.value)}` : null;
}

describe('signup', () => {
  it('creates a user, an account, a membership and a session', async () => {
    const res = await signup('new@example.com');
    expect(res.statusCode).toBe(201);
    expect(sessionCookie(res)).toBeTruthy();

    const { rows } = await pool.query(
      `SELECT u.email, a.type, am.role
       FROM app_user u
       JOIN account_member am ON am.user_id = u.id
       JOIN account a ON a.id = am.account_id`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: 'new@example.com',
      type: 'personal',
      role: 'owner',
    });
  });

  it('never stores the password in plaintext', async () => {
    await signup('hash@example.com', 'super-secret-password');
    const { rows } = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM user_credential',
    );
    expect(rows[0]?.password_hash).toBeDefined();
    expect(rows[0]?.password_hash).not.toContain('super-secret-password');
    expect(rows[0]?.password_hash.startsWith('$argon2id$')).toBe(true);
  });

  it('rejects a duplicate email', async () => {
    await signup('dupe@example.com');
    const res = await signup('dupe@example.com');
    expect(res.statusCode).toBe(409);
  });

  it('treats emails case-insensitively', async () => {
    await signup('Case@Example.com');
    const res = await signup('case@example.com');
    expect(res.statusCode).toBe(409);
  });

  it('rejects a password under 10 characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      ...form({ email: 'short@example.com', password: 'short' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    expect(res.statusCode).toBe(400);
  });

  it('writes an audit entry scoped to the new account', async () => {
    await signup('audited@example.com');
    const { rows } = await pool.query<{ action: string; account_id: string }>(
      'SELECT action, account_id FROM audit_log',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('user.signed_up');
    expect(rows[0]?.account_id).toBeTruthy();
  });
});

describe('login', () => {
  beforeEach(async () => {
    await signup('user@example.com', 'correct-horse-battery');
  });

  it('succeeds with the right password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      ...form({ email: 'user@example.com', password: 'correct-horse-battery' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    expect(res.statusCode).toBe(200);
    expect(sessionCookie(res)).toBeTruthy();
  });

  it('fails with the wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      ...form({ email: 'user@example.com', password: 'wrong-password-here' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    expect(res.statusCode).toBe(401);
    expect(sessionCookie(res)).toBeNull();
  });

  it('returns an identical response for unknown and wrong-password', async () => {
    // The account-existence oracle check. If these ever diverge, the login
    // form starts telling strangers who has an account - which for this
    // product discloses who is job hunting.
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/login',
      ...form({ email: 'nobody@example.com', password: 'correct-horse-battery' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      ...form({ email: 'user@example.com', password: 'wrong-password-here' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });

    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it('sets an httpOnly session cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      ...form({ email: 'user@example.com', password: 'correct-horse-battery' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    const cookie = res.cookies.find((c) => c.name === 'js_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe('lax');
    expect(cookie?.path).toBe('/');
  });

  it('stores only a hash of the session token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      ...form({ email: 'user@example.com', password: 'correct-horse-battery' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    const raw = res.cookies.find((c) => c.name === 'js_session')?.value as string;

    const { rows } = await pool.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM user_session',
    );
    expect(rows[0]?.token_hash.toString('utf8')).not.toContain(raw);
    expect(rows[0]?.token_hash).toHaveLength(32);
  });
});

describe('session and access control', () => {
  it('rejects /api/v1/me without a session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: jsonHeaders,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns the principal with a valid session', async () => {
    const signed = await signup('me@example.com');
    const cookie = sessionCookie(signed) as string;

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { ...jsonHeaders, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('me@example.com');
    expect(res.json().account.role).toBe('owner');
  });

  it('rejects a forged session token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { ...jsonHeaders, cookie: 'js_session=not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects the session after logout', async () => {
    const signed = await signup('out@example.com');
    const cookie = sessionCookie(signed) as string;

    await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { ...jsonHeaders, cookie },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { ...jsonHeaders, cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('rejects an expired session', async () => {
    const signed = await signup('expired@example.com');
    const cookie = sessionCookie(signed) as string;

    await pool.query(`UPDATE user_session SET expires_at = now() - interval '1 hour'`);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { ...jsonHeaders, cookie },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('password reset', () => {
  beforeEach(async () => {
    await signup('reset@example.com', 'correct-horse-battery');
    sent.length = 0;
  });

  it('emails a link for a known address', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      ...form({ email: 'reset@example.com' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('/reset-password?token=');
  });

  it('gives the same answer for an unknown address, and sends nothing', async () => {
    const known = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      ...form({ email: 'reset@example.com' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    sent.length = 0;
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      ...form({ email: 'ghost@example.com' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    expect(sent).toHaveLength(0);
  });

  it('stores only a hash of the reset token', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      ...form({ email: 'reset@example.com' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    const token = new URL(
      (sent[0]?.text.match(/http\S+/) ?? [''])[0],
    ).searchParams.get('token') as string;

    const { rows } = await pool.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM password_reset_token',
    );
    expect(rows[0]?.token_hash.toString('utf8')).not.toContain(token);
  });

  async function issueToken(): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      ...form({ email: 'reset@example.com' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    const link = (sent.at(-1)?.text.match(/http\S+/) ?? [''])[0];
    return new URL(link).searchParams.get('token') as string;
  }

  it('sets a new password and lets the user sign in with it', async () => {
    const token = await issueToken();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      ...form({ token, password: 'a-brand-new-password' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    expect(res.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      ...form({ email: 'reset@example.com', password: 'a-brand-new-password' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    expect(login.statusCode).toBe(200);
  });

  it('revokes every existing session', async () => {
    // The point of a reset after a suspected compromise: the attacker's
    // session must die too, not just the password change.
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      ...form({ email: 'reset@example.com', password: 'correct-horse-battery' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    const oldCookie = sessionCookie(login) as string;

    const token = await issueToken();
    await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      ...form({ token, password: 'a-brand-new-password' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { ...jsonHeaders, cookie: oldCookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses to reuse a token', async () => {
    const token = await issueToken();
    const first = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      ...form({ token, password: 'a-brand-new-password' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      ...form({ token, password: 'another-new-password' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    expect(second.statusCode).toBe(400);
  });

  it('invalidates an earlier token when a new one is requested', async () => {
    const first = await issueToken();
    const second = await issueToken();
    expect(first).not.toBe(second);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      ...form({ token: first, password: 'a-brand-new-password' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an expired token', async () => {
    const token = await issueToken();
    await pool.query(
      `UPDATE password_reset_token SET expires_at = now() - interval '1 hour'`,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      ...form({ token, password: 'a-brand-new-password' }),
      headers: { ...form({}).headers, ...jsonHeaders },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('token_expired');
  });
});

describe('health', () => {
  it('reports liveness', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness with no pending migrations', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().pendingMigrations).toEqual([]);
  });
});

describe('page vs api guards', () => {
  it('redirects an unauthenticated browser to /login regardless of Accept', async () => {
    // Regression: this route previously branched on the Accept header, so a
    // client sending */* got a JSON 401 where a page was expected.
    for (const accept of ['text/html', '*/*', 'application/json']) {
      const res = await app.inject({
        method: 'GET',
        url: '/app',
        headers: { accept },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login');
    }
  });

  it('answers the API with 401 regardless of Accept', async () => {
    for (const accept of ['text/html', '*/*', 'application/json']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { accept },
      });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('google oauth gating', () => {
  it('returns 404 when unconfigured rather than failing later', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/google',
      headers: jsonHeaders,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('oauth_disabled');
  });
});

describe('security headers', () => {
  it('sets CSP and frame-ancestors none', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
