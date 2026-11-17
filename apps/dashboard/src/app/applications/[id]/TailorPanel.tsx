'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import type { ResumeArtifact, ResumeSourceSummary } from '@jobswitch/core';
import { tailorApplication, compileArtifact } from './actions';

export function TailorPanel({
  applicationId,
  variants,
  initialArtifact,
}: {
  applicationId: string;
  variants: ResumeSourceSummary[];
  initialArtifact: ResumeArtifact | null;
}) {
  const [artifact, setArtifact] = useState(initialArtifact);
  const [variantId, setVariantId] = useState(variants[0]?.variantId ?? '');
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [flagsReviewed, setFlagsReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (variants.length === 0) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Tailor your resume</h3>
        <p className="muted">
          You haven't added a resume template yet. <Link href="/profile">Add one on the Profile tab</Link> before
          tailoring.
        </p>
      </div>
    );
  }

  function runTailor() {
    setError(null);
    startTransition(async () => {
      const result = await tailorApplication(applicationId, variantId);
      if (result.error) setError(result.error);
      if (result.artifact) {
        setArtifact(result.artifact);
        setAccepted(new Set(result.artifact.proposedChanges.map((c) => c.field)));
        setFlagsReviewed(false);
      }
    });
  }

  function runCompile() {
    if (!artifact) return;
    setError(null);
    startTransition(async () => {
      const result = await compileArtifact(applicationId, artifact.id, Array.from(accepted));
      if (result.error) setError(result.error);
      if (result.artifact) setArtifact(result.artifact);
    });
  }

  const hasUnreviewedFlags = (artifact?.flags.length ?? 0) > 0 && !flagsReviewed;
  const canCompile = artifact?.status === 'proposed' && !hasUnreviewedFlags && !pending;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Tailor your resume</h3>

      <label>
        Resume variant
        <select value={variantId} onChange={(e) => setVariantId(e.target.value)} disabled={pending}>
          {variants.map((v) => (
            <option key={v.variantId} value={v.variantId}>
              {v.label}
            </option>
          ))}
        </select>
      </label>

      <button type="button" className="btn btn-primary" onClick={runTailor} disabled={pending}>
        {pending ? 'Working…' : 'Tailor for this role'}
      </button>

      {error && <p className="form-error">{error}</p>}

      {artifact && artifact.status === 'failed' && (
        <p className="form-error">Tailoring failed: {artifact.compileError}</p>
      )}

      {artifact && artifact.status !== 'failed' && (
        <div style={{ marginTop: 16 }}>
          {artifact.proposedChanges.length > 0 ? (
            <>
              <h4>Proposed changes - review before compiling</h4>
              {artifact.proposedChanges.map((change) => (
                <label key={change.field} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={accepted.has(change.field)}
                    disabled={artifact.status === 'compiled'}
                    onChange={(e) => {
                      const next = new Set(accepted);
                      if (e.target.checked) next.add(change.field);
                      else next.delete(change.field);
                      setAccepted(next);
                    }}
                    style={{ marginTop: 4, width: 'auto' }}
                  />
                  <span>
                    <strong>{change.field}</strong>: {change.rewritten}
                  </span>
                </label>
              ))}
            </>
          ) : (
            artifact.status === 'proposed' && (
              <p className="muted">No changes were proposed - your resume already matches well. You can still compile it as-is.</p>
            )
          )}

          {artifact.flags.length > 0 && (
            <div className="banner" style={{ background: '#fef9c3', color: '#854d0e' }}>
              <p style={{ margin: '0 0 8px' }}>
                <strong>{artifact.flags.length} flag(s)</strong> - these look like new claims not in your original
                resume:
              </p>
              <ul style={{ margin: '0 0 8px' }}>
                {artifact.flags.map((f, i) => (
                  <li key={i}>
                    "{f.token}" in {f.field} ({f.reason.replace('-', ' ')})
                  </li>
                ))}
              </ul>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0 }}>
                <input
                  type="checkbox"
                  checked={flagsReviewed}
                  onChange={(e) => setFlagsReviewed(e.target.checked)}
                  style={{ width: 'auto', margin: 0 }}
                />
                I've reviewed these and confirm they're accurate
              </label>
            </div>
          )}

          {artifact.status === 'proposed' && (
            <button type="button" className="btn btn-primary" onClick={runCompile} disabled={!canCompile}>
              {pending ? 'Compiling…' : 'Compile selected changes'}
            </button>
          )}

          {artifact.status === 'compiled' && (
            <p className="form-success">
              Compiled. <a href={`/api/artifacts/${artifact.id}/pdf`}>Download PDF</a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
