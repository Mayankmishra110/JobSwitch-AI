'use server';

import { requestPasswordReset } from '@/lib/authRelay';

export interface ForgotPasswordState {
  notice: string | null;
}

export async function forgotPasswordAction(
  _prev: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const email = String(formData.get('email') ?? '');
  const notice = await requestPasswordReset(email);
  return { notice };
}
