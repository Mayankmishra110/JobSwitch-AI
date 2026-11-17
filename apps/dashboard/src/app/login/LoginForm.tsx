'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { loginAction, signupAction, type AuthActionState } from './actions';

const initialState: AuthActionState = { error: null };

export function LoginForm() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [loginState, loginFormAction, loginPending] = useActionState(loginAction, initialState);
  const [signupState, signupFormAction, signupPending] = useActionState(signupAction, initialState);
  const searchParams = useSearchParams();
  const justReset = searchParams.get('reset') === '1';

  const state = mode === 'login' ? loginState : signupState;
  const action = mode === 'login' ? loginFormAction : signupFormAction;
  const pending = mode === 'login' ? loginPending : signupPending;

  return (
    <div className="auth-card">
      <h1>JobSwitch AI</h1>
      <div className="auth-tabs">
        <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
          Sign in
        </button>
        <button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>
          Create account
        </button>
      </div>

      {justReset && mode === 'login' && (
        <p className="form-success">Password updated. Sign in with your new password.</p>
      )}

      <form action={action} className="auth-form">
        {mode === 'signup' && (
          <label>
            Full name
            <input name="fullName" type="text" autoComplete="name" />
          </label>
        )}
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Password
          <input name="password" type="password" required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </label>

        {state.error && <p className="form-error">{state.error}</p>}

        <button type="submit" disabled={pending}>
          {pending ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      {mode === 'login' && (
        <p className="muted" style={{ marginTop: 12 }}>
          <Link href="/forgot-password">Forgot your password?</Link>
        </p>
      )}
    </div>
  );
}
