'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { performAuthRequest } from '@/lib/authRelay';

/**
 * Relays credentials to apps/web's real /auth/login and /auth/signup - the
 * only auth code in this whole app is "forward this form, copy the cookie
 * apps/web decided to set." Password hashing, rate limiting, and session
 * issuance all happen entirely in apps/web; this action never sees a
 * password hash or a session's internal shape, only the finished cookie.
 *
 * The actual fetch/parse logic lives in lib/authRelay.ts (tested there
 * directly, against a real apps/web) - this file is deliberately just the
 * `cookies().set() + redirect()` glue a `'use server'` file's own
 * export-must-be-an-async-function restriction can't avoid holding.
 */

export interface AuthActionState {
  error: string | null;
}

async function relayAuth(path: '/auth/login' | '/auth/signup', body: Record<string, string>): Promise<string | null> {
  const result = await performAuthRequest(path, body);
  if (result.error || !result.cookie) return result.error;

  const store = await cookies();
  store.set('js_session', result.cookie.value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    ...(result.cookie.expiresAt ? { expires: result.cookie.expiresAt } : {}),
  });
  return null;
}

export async function loginAction(_prev: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  const error = await relayAuth('/auth/login', { email, password });
  if (error) return { error };
  redirect('/pipeline');
}

export async function signupAction(_prev: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const fullName = String(formData.get('fullName') ?? '');

  const error = await relayAuth('/auth/signup', { email, password, ...(fullName ? { fullName } : {}) });
  if (error) return { error };
  redirect('/pipeline');
}
