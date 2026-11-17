'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiMutate } from '@/lib/apiServer';
import type { JobApplication } from '@jobswitch/core';

export async function dismissMatch(matchId: string): Promise<void> {
  await apiMutate('POST', `/api/v1/matches/${matchId}/dismiss`);
  revalidatePath('/matches');
}

export async function trackMatch(matchId: string): Promise<void> {
  const { application } = await apiMutate<{ application: JobApplication }>('POST', `/api/v1/matches/${matchId}/track`);
  revalidatePath('/matches');
  revalidatePath('/pipeline');
  redirect(`/applications/${application.id}`);
}
