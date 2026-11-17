import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { API_BASE_URL } from './config';

/**
 * The only way this app talks to apps/web - server-to-server, always.
 *
 * "Zero auth code" (docs/BUILD_PLAN.md's own words for this dashboard)
 * means literally zero: no session parsing, no hash comparison, nothing
 * that could disagree with apps/web's own logic. Every call here forwards
 * the incoming request's `js_session` cookie verbatim; apps/web validates
 * it exactly as it already does for its own routes. This app never learns
 * what's inside that cookie or how it's checked.
 *
 * Traefik path-routing (D-29, not yet deployed - Phase 5.0 is skipped for
 * now) is what makes this genuinely same-origin in production: apps/web
 * and this dashboard share one public origin, so the browser sends the
 * cookie to both without either app doing anything. Locally, without
 * Traefik, this app runs on its own port - so instead of relying on the
 * browser to carry the cookie across ports (unreliable to depend on, even
 * though `localhost` cookies ignore port in practice), EVERY call to
 * apps/web is server-to-server: Server Components read the incoming
 * request's cookie via next/headers and forward it explicitly; Server
 * Actions do the same; the one long-lived exception (SSE) is proxied
 * through a Route Handler (app/api/events/stream/route.ts) that pipes the
 * upstream response straight through. The browser never talks to apps/web
 * directly, in dev or in the eventual Traefik-routed production shape -
 * this design works unchanged either way.
 *
 * Split into a pure core (apiRequest/apiGetWith/apiMutateWith, no
 * next/headers dependency) and a thin next/headers-reading wrapper
 * (apiFetchRaw/apiGet/apiMutate) deliberately: next/headers's `cookies()`
 * only works inside Next's own request-scoped execution (a real request
 * handling a Server Component/Action) - it throws outside one, which
 * means it cannot be called from a plain vitest test. The pure core takes
 * the cookie header as an explicit argument instead, so test/apiServer.
 * test.ts can call it directly against a REAL running apps/web with a
 * real session cookie, with no Next.js runtime involved at all - this
 * project's standing "no mocks for infra this repo owns and runs for
 * real" rule, applied to apps/web exactly as it already is to Postgres
 * and NATS elsewhere in this repo.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`apps/web returned ${status}`);
  }
}

/** Pure core: cookie header is an explicit argument, not read from next/headers - see this file's own doc comment for why. */
export async function apiRequest(cookieHeader: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), cookie: cookieHeader },
    cache: 'no-store',
  });
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** GET, parsed as JSON. Throws ApiError on a non-2xx response - callers decide what a 401/404/409 means for their own page. */
export async function apiGetWith<T>(cookieHeader: string, path: string): Promise<T> {
  const res = await apiRequest(cookieHeader, path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new ApiError(res.status, await safeJson(res));
  return res.json() as Promise<T>;
}

/** POST/PATCH/PUT/DELETE with a JSON body, parsed as JSON (or undefined for a 204). Throws ApiError on a non-2xx response. */
export async function apiMutateWith<T>(
  cookieHeader: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await apiRequest(cookieHeader, path, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new ApiError(res.status, await safeJson(res));
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// next/headers-reading wrappers - what pages, Server Actions, and layouts
// actually import. Thin on purpose: everything with a branch or a status
// code to interpret lives in the pure core above, where it's tested.
// ---------------------------------------------------------------------------

async function sessionCookieHeader(): Promise<string> {
  const store = await cookies();
  const session = store.get('js_session');
  return session ? `js_session=${session.value}` : '';
}

/** Raw fetch, cookie forwarded, no status handling - for callers that need the Response itself (the SSE/PDF proxies use the Request-scoped cookie header directly instead - see their own route files). */
export async function apiFetchRaw(path: string, init?: RequestInit): Promise<Response> {
  return apiRequest(await sessionCookieHeader(), path, init);
}

export async function apiGet<T>(path: string): Promise<T> {
  return apiGetWith<T>(await sessionCookieHeader(), path);
}

export async function apiMutate<T>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return apiMutateWith<T>(await sessionCookieHeader(), method, path, body);
}

/**
 * A Server Component's normal way to load page data: the middleware's
 * cookie-presence check is a fast path, not the real guard - an expired
 * or revoked cookie still reaches here and gets a real 401 from apps/web,
 * which this turns into the same /login redirect middleware would have
 * given a request with no cookie at all.
 */
export async function apiGetOrRedirect<T>(path: string): Promise<T> {
  try {
    return await apiGet<T>(path);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect('/login');
    throw error;
  }
}
