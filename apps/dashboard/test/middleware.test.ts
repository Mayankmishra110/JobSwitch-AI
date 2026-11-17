import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../src/middleware';

/**
 * Pure function tests, no network - `middleware` takes a `NextRequest`
 * and returns a `NextResponse`, both plain classes constructible directly
 * in a test. This is deliberately the ONLY check this file makes (see
 * middleware.ts's own doc comment): whether a `js_session` cookie is
 * present, never whether it's actually valid.
 */

function requestTo(path: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost:3001'), {
    headers: cookie ? { cookie: `js_session=${cookie}` } : {},
  });
}

describe('middleware', () => {
  it('redirects to /login when there is no session cookie', () => {
    const response = middleware(requestTo('/pipeline'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3001/login');
  });

  it('lets a request with no cookie through to /login itself', () => {
    const response = middleware(requestTo('/login'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('redirects an authenticated request away from /login to /pipeline', () => {
    const response = middleware(requestTo('/login', 'some-real-looking-token'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3001/pipeline');
  });

  it('lets an authenticated request through to a protected page', () => {
    const response = middleware(requestTo('/pipeline', 'some-real-looking-token'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('never redirects based on the cookie\'s value - presence is the only check', () => {
    // Deliberately an obviously-wrong-looking token: middleware still lets
    // it through, because it is not middleware's job to validate the
    // cookie (see the file's own doc comment) - apps/web's real 401 is
    // what actually gates an invalid session, one layer down.
    const response = middleware(requestTo('/pipeline', 'not-even-base64url!!!'));
    expect(response.headers.get('location')).toBeNull();
  });

  it.each(['/forgot-password', '/reset-password'])('lets an unauthenticated request through to %s', (path) => {
    const response = middleware(requestTo(path));
    expect(response.headers.get('location')).toBeNull();
  });

  it.each(['/forgot-password', '/reset-password'])(
    'does NOT bounce an authenticated request away from %s - unlike /login, resetting your password while signed in is normal',
    (path) => {
      const response = middleware(requestTo(path, 'some-real-looking-token'));
      expect(response.headers.get('location')).toBeNull();
    },
  );
});
