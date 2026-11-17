import { describe, expect, it } from 'vitest';
import { confirmPasswordReset, parseSessionCookie, performAuthRequest, requestPasswordReset } from '../src/lib/authRelay';
import { isApiReachable } from './helpers';

describe('parseSessionCookie', () => {
  it('extracts the value and a Max-Age-derived expiration from a Set-Cookie line', () => {
    const before = Date.now();
    const parsed = parseSessionCookie('js_session=abc123; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1209600');
    expect(parsed?.value).toBe('abc123');
    expect(parsed?.expiresAt).toBeInstanceOf(Date);
    expect(parsed!.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 1209600 * 1000);
  });

  it('extracts the value and expiration from apps/web\'s real Expires-style Set-Cookie line', () => {
    const parsed = parseSessionCookie('js_session=abc123; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly');
    expect(parsed?.value).toBe('abc123');
    expect(parsed?.expiresAt?.toISOString()).toBe('2026-10-21T07:28:00.000Z');
  });

  it('returns a null expiration when neither attribute is present', () => {
    const parsed = parseSessionCookie('js_session=abc123; Path=/');
    expect(parsed).toEqual({ value: 'abc123', expiresAt: null });
  });

  it('returns null for a Set-Cookie line for a different cookie', () => {
    expect(parseSessionCookie('js_oauth_state=xyz; Path=/')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseSessionCookie('not a cookie at all')).toBeNull();
  });
});

const reachable = await isApiReachable();
if (!reachable) {
  console.warn('apps/web is not reachable at API_BASE_URL - skipping authRelay.test.ts live cases.');
}

describe.runIf(reachable)('performAuthRequest', () => {
  it('signup: extracts a real session cookie on success', async () => {
    const email = `authrelay-signup-${Date.now()}@example.com`;
    const result = await performAuthRequest('/auth/signup', {
      email,
      password: 'correct-horse-battery',
      fullName: 'Auth Relay Test',
    });
    expect(result.error).toBeNull();
    expect(result.cookie?.value).toBeTruthy();
    expect(result.cookie?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it('signup: a real validation failure surfaces apps/web\'s own message, no cookie', async () => {
    const result = await performAuthRequest('/auth/signup', { email: 'not-an-email', password: 'x' });
    expect(result.error).toBeTruthy();
    expect(result.cookie).toBeNull();
  });

  it('login: wrong credentials surface the real invalid_credentials message', async () => {
    const email = `authrelay-login-${Date.now()}@example.com`;
    await performAuthRequest('/auth/signup', { email, password: 'correct-horse-battery' });

    const result = await performAuthRequest('/auth/login', { email, password: 'wrong-password' });
    expect(result.cookie).toBeNull();
    expect(result.error).toMatch(/did not match/i);
  });

  it('login: correct credentials issue a real session cookie', async () => {
    const email = `authrelay-login-ok-${Date.now()}@example.com`;
    await performAuthRequest('/auth/signup', { email, password: 'correct-horse-battery' });

    const result = await performAuthRequest('/auth/login', { email, password: 'correct-horse-battery' });
    expect(result.error).toBeNull();
    expect(result.cookie?.value).toBeTruthy();
  });
});

describe.runIf(reachable)('requestPasswordReset', () => {
  it('returns the same generic notice for a real, known account and an unknown one - apps/web\'s own anti-enumeration rule, not something this relay could break even by accident', async () => {
    const email = `authrelay-forgot-${Date.now()}@example.com`;
    await performAuthRequest('/auth/signup', { email, password: 'correct-horse-battery' });

    const known = await requestPasswordReset(email);
    const unknown = await requestPasswordReset('definitely-nobody@example.com');
    expect(known).toBe(unknown);
    expect(known.toLowerCase()).toContain('reset link');
  });
});

describe.runIf(reachable)('confirmPasswordReset', () => {
  it('a real, invalid token is rejected with apps/web\'s own error, never silently accepted', async () => {
    // A genuinely valid token can only be minted by apps/web itself and
    // delivered by email - not recoverable in a test without either
    // scraping server logs or reading password_reset_token directly
    // (which stores only a one-way hash, by design). What's real and
    // testable without either: an invalid token must fail, for real,
    // against the real endpoint - not a fabricated response.
    const result = await confirmPasswordReset('not-a-real-token-00000000000000', 'a-new-password-123');
    expect(result.error).toBeTruthy();
  });
});
