import type { ApplicationEvent, JobApplication, OutreachDraft, ResumeArtifact, ResumeSourceSummary } from '@jobswitch/core';
import { apiGetOrRedirect } from '@/lib/apiServer';
import { TailorPanel } from './TailorPanel';
import { OutreachPanel } from './OutreachPanel';
import { LiveProgress } from './LiveProgress';

export const dynamic = 'force-dynamic';

interface ApplicationDetail {
  application: JobApplication;
  events: ApplicationEvent[];
  artifacts: ResumeArtifact[];
  outreach: OutreachDraft[];
}

export default async function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [detail, { sources }] = await Promise.all([
    apiGetOrRedirect<ApplicationDetail>(`/api/v1/applications/${id}`),
    apiGetOrRedirect<{ sources: ResumeSourceSummary[] }>('/api/v1/profile/resume-source'),
  ]);
  const { application, events, artifacts, outreach } = detail;
  const jdText = application.postingDescription ?? application.manualJdText;

  return (
    <main>
      <LiveProgress applicationId={id} />

      <h1>
        {application.postingTitle ?? application.manualTitle}{' '}
        <span className="muted">· {application.postingCompany ?? application.manualCompany}</span>
      </h1>
      <p>
        <span className="badge badge-status">{application.status}</span>
      </p>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Job description</h3>
        <p style={{ whiteSpace: 'pre-wrap' }}>{jdText}</p>
        {application.manualUrl && (
          <p>
            <a href={application.manualUrl} target="_blank" rel="noreferrer">
              Original posting
            </a>
          </p>
        )}
      </div>

      <TailorPanel applicationId={id} variants={sources} initialArtifact={artifacts[0] ?? null} />

      <OutreachPanel applicationId={id} drafts={outreach} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>History</h3>
        {events.length === 0 ? (
          <p className="muted">No events yet.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {events.map((e) => (
              <li key={e.id} className="muted">
                {new Date(e.occurredAt).toLocaleString()} - {e.fromStatus ? `${e.fromStatus} → ` : ''}
                {e.toStatus}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
