import Link from 'next/link';
import type { JobApplication } from '@jobswitch/core';
import { apiGetOrRedirect } from '@/lib/apiServer';
import { StatusSelect } from './StatusSelect';
import { NewApplicationForm } from './NewApplicationForm';

export const dynamic = 'force-dynamic';

export default async function PipelinePage() {
  const { applications } = await apiGetOrRedirect<{ applications: JobApplication[] }>('/api/v1/applications');

  return (
    <main>
      <h1>Pipeline</h1>
      <p className="muted">Every application you're tracking, grouped by status - most recently touched first.</p>

      <NewApplicationForm />

      <div className="card" style={{ marginTop: 16 }}>
        {applications.length === 0 ? (
          <p className="muted">Nothing tracked yet. Track a match from the Matches tab, or add one above.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Company</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {applications.map((app) => (
                <tr key={app.id}>
                  <td>
                    <Link href={`/applications/${app.id}`}>{app.postingTitle ?? app.manualTitle ?? 'Untitled role'}</Link>
                  </td>
                  <td>{app.postingCompany ?? app.manualCompany ?? '—'}</td>
                  <td>
                    <StatusSelect applicationId={app.id} status={app.status} />
                  </td>
                  <td className="muted">{new Date(app.updatedAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
