'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * D-26/D-27's "live progress via SSE" for this application - honestly
 * scoped to what Graph A/B can actually report today (single-response
 * only, per specs/resume-tailoring.md's own named gap): a completion
 * signal, not granular per-node progress. Refreshing the page's Server
 * Component data on arrival is what actually shows the new artifact/
 * outreach state - this banner is a heads-up that something just
 * finished, not the data source itself.
 */
export function LiveProgress({ applicationId }: { applicationId: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    const source = new EventSource('/api/events/stream');

    const relevant: Record<string, string> = {
      'resume.tailoring.proposed': 'New tailoring proposal ready.',
      'resume.tailoring.compiled': 'Resume compiled.',
      'outreach.draft.created': 'Outreach draft ready.',
      'application.status_changed': 'Status updated.',
    };

    function handle(event: MessageEvent) {
      let payload: { applicationId?: string } = {};
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.applicationId !== applicationId) return;
      setMessage(relevant[event.type] ?? 'Updated.');
      router.refresh();
    }

    for (const eventName of Object.keys(relevant)) {
      source.addEventListener(eventName, handle);
    }

    return () => source.close();
  }, [applicationId, router]);

  if (!message) return null;
  return <div className="banner">🔔 {message}</div>;
}
