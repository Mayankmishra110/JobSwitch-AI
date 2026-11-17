'use client';

import { useActionState } from 'react';
import { resetPasswordAction, type ResetPasswordState } from './actions';

const initial: ResetPasswordState = { error: null };

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(resetPasswordAction, initial);

  return (
    <div className="auth-card">
      <h1>Choose a new password</h1>
      <form action={formAction} className="auth-form">
        <input type="hidden" name="token" value={token} />
        <label>
          New password
          <input name="password" type="password" required autoComplete="new-password" minLength={8} />
        </label>
        {state.error && <p className="form-error">{state.error}</p>}
        <button type="submit" className="btn btn-primary" disabled={pending || !token}>
          {pending ? 'Saving…' : 'Update password'}
        </button>
      </form>
      {!token && <p className="form-error">This link is missing its token - request a new one.</p>}
    </div>
  );
}
