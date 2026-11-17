'use server';

import { revalidatePath } from 'next/cache';
import { apiMutate, ApiError } from '@/lib/apiServer';
import type { ResumeArtifact, OutreachDraft } from '@jobswitch/core';

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: string } | null;
    return body?.message ?? fallback;
  }
  return fallback;
}

export async function tailorApplication(
  applicationId: string,
  variantId: string,
): Promise<{ artifact: ResumeArtifact | null; error: string | null }> {
  try {
    const { artifact } = await apiMutate<{ artifact: ResumeArtifact }>(
      'POST',
      `/api/v1/applications/${applicationId}/tailor`,
      { variantId },
    );
    revalidatePath(`/applications/${applicationId}`);
    return { artifact, error: null };
  } catch (error) {
    return { artifact: null, error: errorMessage(error, 'Tailoring failed.') };
  }
}

export async function compileArtifact(
  applicationId: string,
  artifactId: string,
  accepted: string[],
): Promise<{ artifact: ResumeArtifact | null; error: string | null }> {
  try {
    const { artifact } = await apiMutate<{ artifact: ResumeArtifact }>(
      'POST',
      `/api/v1/artifacts/${artifactId}/compile`,
      { accepted },
    );
    revalidatePath(`/applications/${applicationId}`);
    return { artifact, error: null };
  } catch (error) {
    return { artifact: null, error: errorMessage(error, 'Compilation failed.') };
  }
}

export async function createOutreach(
  applicationId: string,
  toEmail: string,
  toName: string,
): Promise<{ error: string | null }> {
  try {
    await apiMutate('POST', `/api/v1/applications/${applicationId}/outreach`, {
      toEmail,
      ...(toName ? { toName } : {}),
    });
  } catch (error) {
    return { error: errorMessage(error, 'Could not create the draft.') };
  }
  revalidatePath(`/applications/${applicationId}`);
  return { error: null };
}

export async function patchOutreach(
  applicationId: string,
  outreachId: string,
  subject: string,
  body: string,
): Promise<{ error: string | null }> {
  try {
    await apiMutate('PATCH', `/api/v1/outreach/${outreachId}`, { subject, body });
  } catch (error) {
    return { error: errorMessage(error, 'Could not save the draft.') };
  }
  revalidatePath(`/applications/${applicationId}`);
  return { error: null };
}

export async function approveOutreach(applicationId: string, outreachId: string): Promise<{ error: string | null }> {
  try {
    await apiMutate<{ outreach: OutreachDraft }>('POST', `/api/v1/outreach/${outreachId}/approve`);
  } catch (error) {
    return { error: errorMessage(error, 'Could not approve the draft.') };
  }
  revalidatePath(`/applications/${applicationId}`);
  return { error: null };
}

export async function sendOutreach(applicationId: string, outreachId: string): Promise<{ error: string | null }> {
  try {
    await apiMutate<{ outreach: OutreachDraft }>('POST', `/api/v1/outreach/${outreachId}/send`);
  } catch (error) {
    return { error: errorMessage(error, 'Could not send - connect Gmail on the Profile tab first.') };
  }
  revalidatePath(`/applications/${applicationId}`);
  return { error: null };
}
