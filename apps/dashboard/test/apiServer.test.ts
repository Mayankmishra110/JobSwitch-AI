import { describe, expect, it } from 'vitest';
import { apiGetWith, apiMutateWith, apiRequest, ApiError } from '../src/lib/apiServer';
import { isApiReachable, signupAndGetCookie } from './helpers';

/**
 * The core HTTP plumbing every page/action in this app depends on -
 * tested directly against a real apps/web (see helpers.ts), bypassing
 * next/headers entirely (apiRequest/apiGetWith/apiMutateWith all take the
 * cookie header as an explicit argument for exactly this reason - see
 * apiServer.ts's own doc comment).
 *
 * The reachability check runs at module-load time (a top-level await,
 * not a beforeAll) because `describe.runIf` needs its condition already
 * resolved when the describe blocks are collected - a beforeAll hook
 * runs too late for that, and would otherwise leave runIf's argument as
 * an always-truthy function reference instead of the real boolean.
 */
const reachable = await isApiReachable();
if (!reachable) {
  console.warn('apps/web is not reachable at API_BASE_URL - skipping apiServer.test.ts. Run `pnpm --filter @jobswitch/web dev` first.');
}

describe.runIf(reachable)('apiRequest', () => {
  it('forwards the cookie header and reaches a real authenticated route', async () => {
    const { cookieHeader } = await signupAndGetCookie('apirequest-auth');
    const res = await apiRequest(cookieHeader, '/api/v1/me');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.account.id).toBeTruthy();
  });

  it('a missing cookie reaches apps/web as genuinely unauthenticated', async () => {
    const res = await apiRequest('', '/api/v1/me');
    expect(res.status).toBe(401);
  });
});

describe.runIf(reachable)('apiGetWith', () => {
  it('returns parsed JSON for a real 200 response', async () => {
    const { cookieHeader } = await signupAndGetCookie('apiget-happy');
    const body = await apiGetWith<{ applications: unknown[] }>(cookieHeader, '/api/v1/applications');
    expect(body.applications).toEqual([]);
  });

  it('throws ApiError with the real status and body for a 401', async () => {
    await expect(apiGetWith('', '/api/v1/applications')).rejects.toMatchObject({
      status: 401,
    });
    try {
      await apiGetWith('', '/api/v1/applications');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).body).toMatchObject({ error: 'unauthenticated' });
    }
  });

  it('throws ApiError for a real 404', async () => {
    const { cookieHeader } = await signupAndGetCookie('apiget-404');
    await expect(
      apiGetWith(cookieHeader, '/api/v1/applications/00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe.runIf(reachable)('apiMutateWith', () => {
  it('POSTs a real JSON body and returns the parsed response', async () => {
    const { cookieHeader } = await signupAndGetCookie('apimutate-post');
    const { application } = await apiMutateWith<{ application: { id: string; status: string } }>(
      cookieHeader,
      'POST',
      '/api/v1/applications',
      { manualCompany: 'Acme', manualTitle: 'Engineer', manualJdText: 'Write great code every day.' },
    );
    expect(application.status).toBe('found');
  });

  it('a validation failure surfaces as a real 400 ApiError', async () => {
    const { cookieHeader } = await signupAndGetCookie('apimutate-invalid');
    await expect(
      apiMutateWith(cookieHeader, 'POST', '/api/v1/applications', { manualCompany: 'Acme' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('returns undefined for a real 204 (no body)', async () => {
    const { cookieHeader } = await signupAndGetCookie('apimutate-204');
    // DELETE /api/v1/outreach/gmail always 204s, connected or not.
    const result = await apiMutateWith(cookieHeader, 'DELETE', '/api/v1/outreach/gmail');
    expect(result).toBeUndefined();
  });
});
