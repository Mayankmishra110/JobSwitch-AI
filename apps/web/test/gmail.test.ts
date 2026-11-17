import { describe, expect, it } from 'vitest';
import { AppError } from '@jobswitch/core';
import { loadConfig } from '../src/config.js';
import { beginGmailAuthorization, completeGmailAuthorization } from '../src/services/gmail.js';

/**
 * Gmail-link OAuth flow - pure function tests with a fake token endpoint,
 * same "no real Google credentials exist yet" disclosure as
 * services/gmail.ts's own doc comment. What's actually verified here: the
 * config-gate (disabled without all 4 required vars), PKCE/state shape, and
 * correct handling of Google's token-response shape - including the
 * "no refresh_token" edge case, which is easy to get wrong silently.
 */

function baseEnv() {
  return {
    NODE_ENV: 'test' as const,
    DATABASE_URL: 'postgres://x/y',
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-32',
    APP_ORIGIN: 'http://localhost:3000',
    MAIL_TRANSPORT: 'noop' as const,
  };
}

describe('Gmail link config gating', () => {
  it('is disabled when any of the four required vars is missing', () => {
    const config = loadConfig({ ...baseEnv(), GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
    expect(config.gmail.enabled).toBe(false);
    expect(() => beginGmailAuthorization(config)).toThrow(AppError);
  });

  it('is enabled when all four are present', () => {
    const config = loadConfig({
      ...baseEnv(),
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_GMAIL_REDIRECT_URI: 'https://app.example.com/api/v1/outreach/gmail/callback',
      EMAIL_CREDENTIAL_ENCRYPTION_KEY: 'a-key-that-is-at-least-32-characters',
    });
    expect(config.gmail.enabled).toBe(true);
  });
});

describe('beginGmailAuthorization', () => {
  const config = loadConfig({
    ...baseEnv(),
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_GMAIL_REDIRECT_URI: 'https://app.example.com/api/v1/outreach/gmail/callback',
    EMAIL_CREDENTIAL_ENCRYPTION_KEY: 'a-key-that-is-at-least-32-characters',
  });

  it('requests offline access, forced consent, and the gmail.send scope', () => {
    const start = beginGmailAuthorization(config);
    const url = new URL(start.authorizeUrl);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('gmail.send');
    expect(url.searchParams.get('state')).toBe(start.state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('generates a fresh state/verifier pair on every call', () => {
    const a = beginGmailAuthorization(config);
    const b = beginGmailAuthorization(config);
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe('completeGmailAuthorization', () => {
  const config = loadConfig({
    ...baseEnv(),
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_GMAIL_REDIRECT_URI: 'https://app.example.com/api/v1/outreach/gmail/callback',
    EMAIL_CREDENTIAL_ENCRYPTION_KEY: 'a-key-that-is-at-least-32-characters',
  });

  function fakeIdToken(claims: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${header}.${payload}.`;
  }

  it('extracts email and refresh_token from a well-formed token response', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          id_token: fakeIdToken({ email: 'candidate@gmail.com' }),
          refresh_token: '1//real-token',
          scope: 'gmail.send',
        }),
        { status: 200 },
      )) as typeof fetch;

    const result = await completeGmailAuthorization(
      config,
      { code: 'auth-code', codeVerifier: 'verifier' },
      fakeFetch,
    );
    expect(result).toEqual({ email: 'candidate@gmail.com', refreshToken: '1//real-token', scope: 'gmail.send' });
  });

  it('fails clearly when Google omits the refresh_token (e.g. consent was somehow skipped)', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ id_token: fakeIdToken({ email: 'x@gmail.com' }) }), { status: 200 })) as typeof fetch;

    await expect(
      completeGmailAuthorization(config, { code: 'c', codeVerifier: 'v' }, fakeFetch),
    ).rejects.toThrow(/refresh token/i);
  });

  it('fails when the token endpoint itself errors', async () => {
    const fakeFetch = (async () => new Response('bad request', { status: 400 })) as typeof fetch;

    await expect(
      completeGmailAuthorization(config, { code: 'c', codeVerifier: 'v' }, fakeFetch),
    ).rejects.toThrow(AppError);
  });
});
