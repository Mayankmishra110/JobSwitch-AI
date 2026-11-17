'use client';

import { useActionState, useTransition } from 'react';
import { startJobSearch, stopJobSearch } from './actions';

const initial = { error: null as string | null };

export function JobSearchToggle({
  active,
  resumeFilename,
}: {
  active: boolean;
  resumeFilename: string | null;
}) {
  const [startState, startAction, startPending] = useActionState(startJobSearch, initial);
  const [stopPending, startTransition] = useTransition();

  if (active) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Job search: active</h3>
        <p className="muted">Resume on file: {resumeFilename ?? 'unknown'}</p>
        <p className="muted">
          Stopping permanently deletes your resume, matches, applications, and outreach drafts from this search.
        </p>
        <button
          type="button"
          className="btn btn-danger"
          disabled={stopPending}
          onClick={() => startTransition(() => stopJobSearch())}
        >
          {stopPending ? 'Stopping…' : 'Stop job search'}
        </button>
      </div>
    );
  }

  return (
    <form action={startAction} className="card">
      <h3 style={{ marginTop: 0 }}>Job search: stopped</h3>
      <label>
        Resume filename
        <input name="filename" defaultValue="resume.pdf" required />
      </label>
      <label>
        Paste your resume text
        <textarea name="rawText" rows={8} required minLength={50} />
      </label>
      {startState.error && <p className="form-error">{startState.error}</p>}
      <button type="submit" className="btn btn-primary" disabled={startPending}>
        {startPending ? 'Starting…' : 'Start job search'}
      </button>
    </form>
  );
}
