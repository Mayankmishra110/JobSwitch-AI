'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { forgotPasswordAction, type ForgotPasswordState } from './actions';

const initial: ForgotPasswordState = { notice: null };

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(forgotPasswordAction, initial);

  return (
    <div className="auth-card">
      <h1>Reset your password</h1>
      {state.notice ? (
        <p className="form-success">{state.notice}</p>
      ) : (
        <form action={formAction} className="auth-form">
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
      <p className="muted" style={{ marginTop: 16 }}>
        <Link href="/login">Back to sign in</Link>
      </p>
    </div>
  );
}
