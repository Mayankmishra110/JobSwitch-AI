'use client';

import { useActionState, useState } from 'react';
import { upsertResumeSource } from './actions';

export interface ResumeSourceDetail {
  variantId: string;
  label: string;
  pdfBaseName: string;
  tex: string;
  sha256: string;
}

const initial = { error: null as string | null };
const VARIANT_ID_HINT = 'Lowercase letters, digits, and hyphens only (e.g. "fullstack") - this is the id, set once.';

export function ResumeSourceEditor({ sources }: { sources: ResumeSourceDetail[] }) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Resume templates</h3>
      <p className="muted">The LaTeX source Graph A tailors against. Add at least one before tailoring an application.</p>

      {sources.length === 0 && !adding && <p className="muted">No resume templates yet.</p>}

      {sources.map((source) => (
        <ResumeSourceForm key={source.variantId} source={source} />
      ))}

      {adding ? (
        <ResumeSourceForm onSaved={() => setAdding(false)} />
      ) : (
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          + Add a resume template
        </button>
      )}
    </div>
  );
}

function ResumeSourceForm({ source, onSaved }: { source?: ResumeSourceDetail; onSaved?: () => void }) {
  const [state, formAction, pending] = useActionState(
    async (prev: typeof initial, formData: FormData) => {
      const result = await upsertResumeSource(prev, formData);
      if (!result.error) onSaved?.();
      return result;
    },
    initial,
  );

  return (
    <form action={formAction} style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
      <label>
        Variant id
        <input
          name="variantId"
          defaultValue={source?.variantId}
          readOnly={Boolean(source)}
          required
          pattern="[a-z0-9][a-z0-9-]{0,98}[a-z0-9]?"
          title={VARIANT_ID_HINT}
        />
        {!source && <span className="muted">{VARIANT_ID_HINT}</span>}
      </label>
      <label>
        Label
        <input name="label" defaultValue={source?.label} placeholder="Full-stack" required />
      </label>
      <label>
        PDF filename base (no extension)
        <input name="pdfBaseName" defaultValue={source?.pdfBaseName} placeholder="resume" required />
      </label>
      <label>
        LaTeX source
        <textarea name="tex" defaultValue={source?.tex} rows={14} style={{ fontFamily: 'monospace', fontSize: 13 }} required />
      </label>
      {source && <p className="muted">sha256: {source.sha256.slice(0, 16)}…</p>}
      {state.error && <p className="form-error">{state.error}</p>}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
