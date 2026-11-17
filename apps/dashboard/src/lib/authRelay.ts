import { API_BASE_URL } from './config';

/**
 * The pure core of the login/signup relay - login/actions.ts's own
 * `'use server'` directive restricts every export from that file to an
 * async function, so the actual parsing/fetch logic (which has real
 * branches worth testing directly) lives here instead, and that file
 * becomes a thin `cookies().set() + redirect()` wrapper around it. See
 * apps/dashboard/src/lib/apiServer.ts's own doc comment for the same
 * "next/headers only works inside a real request, so keep the testable
 * logic outside it" reasoning.
 */

export interface ParsedSessionCookie {
  value: string;
  expiresAt: Date | null;
}

/**
 * Extracts js_session's value/expiration from a raw Set-Cookie line -
 * apps/web's own cookie name and attributes, never reinvented here.
 *
 * apps/web's setSessionCookie (routes/auth.ts) sets `expires` (an
 * absolute Date), not `max-age` - Fastify's cookie plugin serializes that
 * as an `Expires=<date>` attribute, so this looks for `Expires` first.
 * `Max-Age` is still checked as a fallback (a real, if narrower, cookie
 * attribute some other future caller might use) - the first found wins,
 * per the cookie spec's own "Max-Age takes precedence when both are
 * present" rule.
 *
 * Found by a real test hitting this exact code path against real
 * apps/web: the first version of this function only checked `max-age`,
 * so it silently produced `expiresAt: null` for every real signup/login
 * response - which would have made this dashboard's own cookie a
 * session-only cookie (gone when the browser closes) instead of matching
 * apps/web's real 14-day lifetime, a genuine behavioral bug that a
 * fabricated Set-Cookie string in a unit test would never have caught.
 */
export function parseSessionCookie(setCookieHeader: string): ParsedSessionCookie | null {
  const parts = setCookieHeader.split(';').map((p) => p.trim());
  const first = parts[0];
  if (!first?.startsWith('js_session=')) return null;
  const value = first.slice('js_session='.length);

  const maxAgePart = parts.find((p) => p.toLowerCase().startsWith('max-age='));
  const expiresPart = parts.find((p) => p.toLowerCase().startsWith('expires='));

  let expiresAt: Date | null = null;
  if (maxAgePart) {
    const seconds = Number(maxAgePart.split('=')[1]);
    if (Number.isFinite(seconds)) expiresAt = new Date(Date.now() + seconds * 1000);
  } else if (expiresPart) {
    const parsed = new Date(expiresPart.slice('expires='.length));
    if (!Number.isNaN(parsed.getTime())) expiresAt = parsed;
  }

  return { value, expiresAt };
}

export interface AuthRelayResult {
  error: string | null;
  cookie: ParsedSessionCookie | null;
}

/** Calls apps/web's real /auth/login or /auth/signup and extracts the session cookie it issues - no cookie is SET here, so this is callable from a plain test with no Next.js request context at all. */
export async function performAuthRequest(
  path: '/auth/login' | '/auth/signup',
  body: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthRelayResult> {
  const res = await fetchImpl(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as { message?: string } | null;
    return { error: problem?.message ?? 'Something went wrong. Please try again.', cookie: null };
  }

  const setCookieLines = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookieLines.map(parseSessionCookie).find((c): c is ParsedSessionCookie => c !== null) ?? null;
  if (!cookie) {
    return { error: 'Signed in, but no session cookie was issued - please try again.', cookie: null };
  }

  return { error: null, cookie };
}

/**
 * Calls apps/web's real POST /auth/forgot-password. Always returns the
 * same generic notice regardless of whether the address has an account
 * (apps/web's own anti-enumeration rule) - this relay changes nothing
 * about that, it just forwards the message through.
 */
export async function requestPasswordReset(email: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${API_BASE_URL}/auth/forgot-password`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? 'If an account exists for that address, a reset link is on its way.';
}

export interface ConfirmResetResult {
  error: string | null;
}

/** Calls apps/web's real POST /auth/reset-password. Every session on the account is revoked on success (apps/web's own rule), so this deliberately does not sign the user back in - login/actions.ts's own relay is what does that, on the next explicit sign-in. */
export async function confirmPasswordReset(
  token: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConfirmResetResult> {
  const res = await fetchImpl(`${API_BASE_URL}/auth/reset-password`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as { message?: string } | null;
    return { error: problem?.message ?? 'That link is not valid. Request a new one.' };
  }
  return { error: null };
}
