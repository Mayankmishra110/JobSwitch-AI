import { API_BASE_URL } from '../src/lib/config';

/**
 * Shared test setup - every test here runs against a REAL, separately-
 * running apps/web (this repo's own "no mocks for infra this repo owns
 * and runs for real" rule, same reasoning apps/tailor's own tests apply
 * to a real local LaTeX engine). apps/web is a whole other process, not
 * something this suite can spin up itself the way apps/web's own tests
 * construct an in-process Fastify instance - so these tests skip (not
 * fail) when it isn't reachable, the same pattern services/ai's Graph A
 * tests already use for calling a real apps/tailor.
 *
 * Run `pnpm --filter @jobswitch/web dev` (or point API_BASE_URL at a
 * running instance) before `pnpm --filter @jobswitch/dashboard test` to
 * exercise these for real. Start it with `RATE_LIMIT_ENABLED=false` -
 * this suite signs up a fresh account per test, easily enough in one run
 * to trip apps/web's real `/auth/signup` rate limit (10/hour), the same
 * reason apps/web's own test suite always sets that flag too.
 */
export async function isApiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/healthz`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface SignedUpAccount {
  cookieHeader: string;
  email: string;
}

/** Signs up a fresh, uniquely-emailed account against the real apps/web and returns a usable `js_session` cookie header. */
export async function signupAndGetCookie(label: string): Promise<SignedUpAccount> {
  const email = `dashboard-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const res = await fetch(`${API_BASE_URL}/auth/signup`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct-horse-battery', fullName: 'Dashboard Test' }),
  });
  if (res.status !== 201) {
    throw new Error(`signup failed for ${email}: ${res.status} ${await res.text()}`);
  }
  const setCookieLines = res.headers.getSetCookie?.() ?? [];
  const sessionLine = setCookieLines.find((c) => c.startsWith('js_session='));
  if (!sessionLine) throw new Error('signup did not set a js_session cookie');
  const cookieHeader = sessionLine.split(';')[0]!;
  return { cookieHeader, email };
}
