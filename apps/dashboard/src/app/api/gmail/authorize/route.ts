import { NextResponse } from 'next/server';
import { apiRequest } from '@/lib/apiServer';

/**
 * Relays to apps/web's real GET /api/v1/outreach/gmail/authorize, which
 * returns `{authorizeUrl}` plus two Set-Cookie headers (PKCE state/
 * verifier, see apps/web/src/routes/outreach.ts). This route exists only
 * to turn that JSON response into an actual browser redirect to Google -
 * a plain <a href> to apps/web's own endpoint would show raw JSON instead
 * of navigating anywhere.
 *
 * The Set-Cookie headers are copied through verbatim onto THIS response.
 * That works (not by luck): apps/web sets those cookies with no explicit
 * Domain attribute, so they're scoped to whatever host the browser is on
 * when it receives them - and per the cookie spec, that scoping ignores
 * port entirely. Storing them here (this app's origin, `localhost:3001`)
 * still means the browser presents them when Google later redirects back
 * to apps/web's own callback at `localhost:3000` - same hostname is all
 * that matters. This is a genuine, disclosed dev-only constraint: it
 * requires both apps to be reached via the identical hostname string
 * (`localhost`, not a mix of that and `127.0.0.1`) - see
 * specs/dashboard.md. In the eventual Traefik-routed production shape
 * (D-29, not yet deployed) both apps share one real origin outright, so
 * this constraint disappears rather than needing a different fix.
 *
 * Reads the cookie from the incoming Request directly (same reasoning as
 * the SSE/PDF proxies) - this route requires auth on the apps/web side
 * (`preHandler: app.requireAuth`), so the session cookie has to be
 * forwarded here too, not just the PKCE cookies apps/web sets in return.
 */
export async function GET(request: Request) {
  const upstream = await apiRequest(request.headers.get('cookie') ?? '', '/api/v1/outreach/gmail/authorize');
  if (!upstream.ok) {
    return NextResponse.json(await upstream.json().catch(() => ({ error: 'gmail_unavailable' })), {
      status: upstream.status,
    });
  }

  const { authorizeUrl } = (await upstream.json()) as { authorizeUrl: string };
  const response = NextResponse.redirect(authorizeUrl);
  for (const cookie of upstream.headers.getSetCookie()) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
}
