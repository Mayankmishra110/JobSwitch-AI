import { NextResponse, type NextRequest } from 'next/server';

/**
 * A UX redirect only, never authorization - this is the whole of this
 * app's "auth code," and it checks nothing about the cookie beyond
 * whether one is present. The real check happens server-side on every
 * apiServer.ts call, which forwards the cookie to apps/web and gets back
 * a real 401 if it's invalid, expired, or revoked; a page that gets one
 * redirects to /login itself (see e.g. pipeline/page.tsx). A present-but-
 * invalid cookie reaching this far and failing later is a strictly
 * correct outcome, not a security gap - middleware's only job is skipping
 * the round trip for the common case (no cookie at all).
 */
// /forgot-password and /reset-password are public the same way /login is,
// but - unlike /login - an already-authenticated visitor is left alone
// rather than bounced to /pipeline: resetting your password without
// signing out first is a normal, harmless thing to want to do.
const PUBLIC_PATHS = ['/login', '/forgot-password', '/reset-password'];

export function middleware(request: NextRequest) {
  const hasSession = request.cookies.has('js_session');
  const { pathname } = request.nextUrl;
  const isLoginPage = pathname.startsWith('/login');
  const isPublicPage = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  if (!hasSession && !isPublicPage) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  if (hasSession && isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = '/pipeline';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icon.svg).*)'],
};
