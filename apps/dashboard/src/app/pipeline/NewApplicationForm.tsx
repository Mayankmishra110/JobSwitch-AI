'use client';

import { useActionState, useState } from 'react';
import { createManualApplication } from './actions';

export function NewApplicationForm() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createManualApplication, { error: null });

  if (!open) {
    return (
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        + Track a new application
      </button>
    );
  }

  return (
    <form action={formAction} className="card">
      <label>
        Company
        <input name="manualCompany" required />
      </label>
      <label>
        Title
        <input name="manualTitle" required />
      </label>
      <label>
        Job description
        <textarea name="manualJdText" rows={6} required />
      </label>
      {state.error && <p className="form-error">{state.error}</p>}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Adding…' : 'Add'}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
