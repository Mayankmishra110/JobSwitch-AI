'use client';

import { useState, useTransition } from 'react';
import type { OutreachDraft } from '@jobswitch/core';
import { approveOutreach, createOutreach, patchOutreach, sendOutreach } from './actions';

export function OutreachPanel({ applicationId, drafts }: { applicationId: string; drafts: OutreachDraft[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function runCreate(formData: FormData) {
    setError(null);
    const toEmail = String(formData.get('toEmail') ?? '');
    const toName = String(formData.get('toName') ?? '');
    startTransition(async () => {
      const result = await createOutreach(applicationId, toEmail, toName);
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Outreach</h3>

      {drafts.length === 0 && (
        <form action={runCreate}>
          <label>
            Recruiter email
            <input name="toEmail" type="email" required />
          </label>
          <label>
            Recruiter name (optional)
            <input name="toName" />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? 'Drafting…' : 'Draft outreach message'}
          </button>
        </form>
      )}

      {drafts.map((draft) => (
        <OutreachDraftCard key={draft.id} applicationId={applicationId} draft={draft} />
      ))}
    </div>
  );
}

function OutreachDraftCard({ applicationId, draft }: { applicationId: string; draft: OutreachDraft }) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const editable = draft.status === 'draft';

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
      <p className="muted">
        To: {draft.toName ? `${draft.toName} <${draft.toEmail}>` : draft.toEmail} ·{' '}
        <span className="badge badge-status">{draft.status}</span>
      </p>
      <label>
        Subject
        <input value={subject} disabled={!editable} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label>
        Message
        <textarea rows={6} value={body} disabled={!editable} onChange={(e) => setBody(e.target.value)} />
      </label>

      {error && <p className="form-error">{error}</p>}

      <div className="btn-row">
        {editable && (
          <>
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await patchOutreach(applicationId, draft.id, subject, body);
                  if (result.error) setError(result.error);
                })
              }
            >
              Save
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await approveOutreach(applicationId, draft.id);
                  if (result.error) setError(result.error);
                })
              }
            >
              Approve
            </button>
          </>
        )}
        {draft.status === 'approved' && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await sendOutreach(applicationId, draft.id);
                if (result.error) setError(result.error);
              })
            }
          >
            {pending ? 'Sending…' : 'Send'}
          </button>
        )}
        {draft.status === 'sent' && <p className="form-success">Sent {draft.sentAt ? new Date(draft.sentAt).toLocaleString() : ''}</p>}
      </div>
    </div>
  );
}
