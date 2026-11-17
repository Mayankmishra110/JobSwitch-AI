import { describe, expect, it } from 'vitest';
import { GET as gmailAuthorizeGet } from '../src/app/api/gmail/authorize/route';
import { GET as pdfGet } from '../src/app/api/artifacts/[id]/pdf/route';
import { GET as sseGet } from '../src/app/api/events/stream/route';
import { isApiReachable, signupAndGetCookie } from './helpers';

/**
 * Route Handlers are plain functions taking a Web-standard `Request` -
 * callable directly here with a hand-built one, no running Next.js server
 * needed. Each still talks to the real apps/web (via apiRequest), so
 * these are real integration tests of the proxy behavior, not mocks of it.
 */

const reachable = await isApiReachable();
if (!reachable) {
  console.warn('apps/web is not reachable at API_BASE_URL - skipping routes.test.ts.');
}

function requestWithCookie(url: string, cookieHeader: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { ...headers, cookie: cookieHeader } });
}

describe.runIf(reachable)('GET /api/gmail/authorize', () => {
  it('404s (gmail_unavailable) when Gmail is not configured on apps/web', async () => {
    const { cookieHeader } = await signupAndGetCookie('route-gmail-disabled');
    const response = await gmailAuthorizeGet(requestWithCookie('http://localhost:3001/api/gmail/authorize', cookieHeader));
    expect(response.status).toBe(404);
  });

  it('401s with no session cookie at all', async () => {
    const response = await gmailAuthorizeGet(requestWithCookie('http://localhost:3001/api/gmail/authorize', ''));
    expect(response.status).toBe(401);
  });
});

describe.runIf(reachable)('GET /api/artifacts/:id/pdf', () => {
  it('404s for an artifact with no compiled PDF', async () => {
    const { cookieHeader } = await signupAndGetCookie('route-pdf-404');
    const response = await pdfGet(requestWithCookie('http://localhost:3001/api/artifacts/x/pdf', cookieHeader), {
      params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000000' }),
    });
    expect(response.status).toBe(404);
  });

  it('401s with no session cookie', async () => {
    const response = await pdfGet(requestWithCookie('http://localhost:3001/api/artifacts/x/pdf', ''), {
      params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000000' }),
    });
    expect(response.status).toBe(401);
  });
});

describe.runIf(reachable)('GET /api/events/stream', () => {
  it('connects and proxies a real text/event-stream response', async () => {
    const { cookieHeader } = await signupAndGetCookie('route-sse');
    const response = await sseGet(requestWithCookie('http://localhost:3001/api/events/stream', cookieHeader));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain(': connected');
    await reader.cancel();
  });

  it('401s with no session cookie', async () => {
    const response = await sseGet(requestWithCookie('http://localhost:3001/api/events/stream', ''));
    expect(response.status).toBe(401);
  });
});
