'use server';

import { redirect } from 'next/navigation';
import { confirmPasswordReset } from '@/lib/authRelay';

export interface ResetPasswordState {
  error: string | null;
}

export async function resetPasswordAction(
  _prev: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const token = String(formData.get('token') ?? '');
  const password = String(formData.get('password') ?? '');

  const result = await confirmPasswordReset(token, password);
  if (result.error) return { error: result.error };

  // Every session on the account was just revoked (apps/web's own rule -
  // see authRelay.ts) - redirect to sign-in rather than trying to log the
  // candidate back in here, the same "prove the new password actually
  // works" reasoning apps/web's own HTML flow already uses.
  redirect('/login?reset=1');
}
