'use server';

import { revalidatePath } from 'next/cache';
import { apiMutate } from '@/lib/apiServer';

export async function updateApplicationStatus(applicationId: string, status: string): Promise<void> {
  await apiMutate('PATCH', `/api/v1/applications/${applicationId}`, { status });
  revalidatePath('/pipeline');
}

export async function createManualApplication(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const manualCompany = String(formData.get('manualCompany') ?? '').trim();
  const manualTitle = String(formData.get('manualTitle') ?? '').trim();
  const manualJdText = String(formData.get('manualJdText') ?? '').trim();

  try {
    await apiMutate('POST', '/api/v1/applications', { manualCompany, manualTitle, manualJdText });
  } catch {
    return { error: 'Could not create that application - check every field is filled in.' };
  }
  revalidatePath('/pipeline');
  return { error: null };
}
