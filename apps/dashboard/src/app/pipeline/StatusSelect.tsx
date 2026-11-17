'use client';

import { useTransition } from 'react';
import { updateApplicationStatus } from './actions';

const STATUSES = [
  'found',
  'tailoring',
  'tailored',
  'applied',
  'responded',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
] as const;

export function StatusSelect({ applicationId, status }: { applicationId: string; status: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <select
      value={status}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value;
        startTransition(() => {
          void updateApplicationStatus(applicationId, next);
        });
      }}
    >
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
