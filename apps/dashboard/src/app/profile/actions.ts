'use server';

import { revalidatePath } from 'next/cache';
import { apiMutate } from '@/lib/apiServer';

export async function updateProfile(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const headline = String(formData.get('headline') ?? '').trim();
  const currentTitle = String(formData.get('currentTitle') ?? '').trim();
  const desiredTitles = String(formData.get('desiredTitles') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const desiredLocations = String(formData.get('desiredLocations') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    await apiMutate('PUT', '/api/v1/profile', {
      ...(headline ? { headline } : {}),
      ...(currentTitle ? { currentTitle } : {}),
      ...(desiredTitles.length ? { desiredTitles } : {}),
      ...(desiredLocations.length ? { desiredLocations } : {}),
    });
  } catch {
    return { error: 'Could not save your profile.' };
  }
  revalidatePath('/profile');
  return { error: null };
}

export async function replaceSkills(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const skills = String(formData.get('skills') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    await apiMutate('PUT', '/api/v1/profile/skills', { skills });
  } catch {
    return { error: 'Could not save your skills.' };
  }
  revalidatePath('/profile');
  return { error: null };
}

export async function startJobSearch(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const filename = String(formData.get('filename') ?? '').trim();
  const rawText = String(formData.get('rawText') ?? '').trim();

  try {
    await apiMutate('POST', '/api/v1/job-search/start', { filename, rawText });
  } catch {
    return { error: 'Could not start your job search - paste your full resume text (at least 50 characters).' };
  }
  revalidatePath('/profile');
  return { error: null };
}

export async function stopJobSearch(): Promise<void> {
  await apiMutate('POST', '/api/v1/job-search/stop');
  revalidatePath('/profile');
}

export async function upsertResumeSource(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const variantId = String(formData.get('variantId') ?? '').trim();
  const label = String(formData.get('label') ?? '').trim();
  const pdfBaseName = String(formData.get('pdfBaseName') ?? '').trim();
  const tex = String(formData.get('tex') ?? '').trim();

  try {
    await apiMutate('PUT', `/api/v1/profile/resume-source/${encodeURIComponent(variantId)}`, {
      label,
      pdfBaseName,
      tex,
    });
  } catch {
    return {
      error:
        'Could not save that resume - variant ids use only lowercase letters, digits, and hyphens, and every field is required.',
    };
  }
  revalidatePath('/profile');
  return { error: null };
}
