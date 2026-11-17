import { apiRequest } from '@/lib/apiServer';

/**
 * Proxies apps/web's real SSE bridge (GET /api/v1/events/stream, D-26).
 * The one place in this app where the browser's own request has to be a
 * genuine long-lived connection rather than a Server Component fetch or a
 * Server Action - `EventSource` needs a real streaming GET it initiates
 * itself. Piping `upstream.body` straight through (no buffering, no
 * re-encoding) keeps this a transparent proxy: apps/web's actual SSE
 * framing (event:/data: lines) reaches the browser's EventSource exactly
 * as apps/web wrote it.
 *
 * Reads the cookie from the incoming `Request` directly rather than
 * next/headers - a Route Handler already receives the raw platform
 * Request, so this needs no Next-specific API, and it's what makes this
 * handler callable directly in a test with a hand-built Request (see
 * test/routes.test.ts).
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const upstream = await apiRequest(request.headers.get('cookie') ?? '', '/api/v1/events/stream', {
    headers: { accept: 'text/event-stream' },
  });
  if (!upstream.ok || !upstream.body) {
    return new Response(null, { status: upstream.status });
  }
  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
