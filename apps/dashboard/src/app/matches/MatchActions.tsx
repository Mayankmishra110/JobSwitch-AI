'use client';

import { useTransition } from 'react';
import { dismissMatch, trackMatch } from './actions';

export function MatchActions({ matchId }: { matchId: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="btn-row">
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending}
        onClick={() => startTransition(() => trackMatch(matchId))}
      >
        Track
      </button>
      <button
        type="button"
        className="btn"
        disabled={pending}
        onClick={() => startTransition(() => dismissMatch(matchId))}
      >
        Dismiss
      </button>
    </div>
  );
}
