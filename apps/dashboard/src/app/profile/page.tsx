import type { CandidateProfile, ProfileSkill, EmailCredentialStatus, ResumeSourceSummary } from '@jobswitch/core';
import { apiGetOrRedirect } from '@/lib/apiServer';
import { ProfileForm } from './ProfileForm';
import { JobSearchToggle } from './JobSearchToggle';
import { ResumeSourceEditor, type ResumeSourceDetail } from './ResumeSourceEditor';

export const dynamic = 'force-dynamic';

interface JobSearchStatus {
  active: boolean;
  resume: { filename: string; uploadedAt: string } | null;
}

export default async function ProfilePage() {
  const [{ profile, skills }, jobSearch, gmail, { sources }] = await Promise.all([
    apiGetOrRedirect<{ profile: CandidateProfile | null; skills: ProfileSkill[] }>('/api/v1/profile'),
    apiGetOrRedirect<JobSearchStatus>('/api/v1/job-search/status'),
    apiGetOrRedirect<EmailCredentialStatus>('/api/v1/outreach/gmail/status'),
    apiGetOrRedirect<{ sources: ResumeSourceSummary[] }>('/api/v1/profile/resume-source'),
  ]);

  // The list endpoint omits `tex` (each entry can be tens of KB) - the
  // editor needs the full content, so fetch each variant's detail in
  // parallel. Fine at the scale one candidate's own templates ever reach
  // (a handful, not hundreds); revisit if that assumption stops holding.
  const resumeSources = await Promise.all(
    sources.map((s) => apiGetOrRedirect<{ source: ResumeSourceDetail }>(`/api/v1/profile/resume-source/${s.variantId}`)),
  );

  return (
    <main>
      <h1>Profile</h1>

      <JobSearchToggle active={jobSearch.active} resumeFilename={jobSearch.resume?.filename ?? null} />

      <ProfileForm profile={profile} skills={skills} />

      <ResumeSourceEditor sources={resumeSources.map((r) => r.source)} />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Outreach email</h3>
        {gmail.connected ? (
          <p className="form-success">Connected as {gmail.email} - outreach messages send from this address.</p>
        ) : (
          <p className="muted">
            No Gmail account connected yet. Connecting one lets you send outreach messages (and get notified by
            email) directly from JobSwitch AI.{' '}
            <a href="/api/gmail/authorize">Connect Gmail</a>
          </p>
        )}
      </div>
    </main>
  );
}
