import type { JobMatchSummary } from '@jobswitch/core';
import { apiGetOrRedirect } from '@/lib/apiServer';
import { MatchActions } from './MatchActions';
import { ScoreBar } from './ScoreBar';

export const dynamic = 'force-dynamic';

export default async function MatchesPage() {
  const { matches } = await apiGetOrRedirect<{ matches: JobMatchSummary[] }>('/api/v1/matches');

  return (
    <main>
      <h1>Matches</h1>
      <p className="muted">Ranked by fit - dismiss what isn't relevant, track what is.</p>

      {matches.length === 0 ? (
        <div className="card">
          <p className="muted">
            No live matches yet. Matches are computed for accounts with an active job search - check the Profile tab.
          </p>
        </div>
      ) : (
        matches.map((match) => (
          <article key={match.id} className="card">
            <h3 style={{ marginTop: 0 }}>
              {match.title} {match.company && <span className="muted">· {match.company}</span>}
            </h3>

            <ScoreBar label="Overall" value={match.score} />
            <ScoreBar label="Skills" value={match.skillScore} />
            <ScoreBar label="Seniority" value={match.seniorityScore} />
            <ScoreBar label="Location" value={match.locationScore} />

            {match.explanation && (
              <div className="banner" style={{ marginTop: 12 }}>
                <p style={{ margin: '0 0 8px' }}>{match.explanation.summary}</p>
                <div className="btn-row">
                  {match.explanation.evidence.map((e, i) => (
                    <span key={i} className={`badge badge-${e.provenance}`} title={e.claim}>
                      {e.provenance.replace('_', ' ')}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <MatchActions matchId={match.id} />
          </article>
        ))
      )}
    </main>
  );
}
