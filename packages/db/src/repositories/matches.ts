import { AccountId, type JobMatchSummary } from '@jobswitch/core';
import type { Queryable } from '../context.js';

/**
 * The matches feed (Phase 7) - read-only over `job_match` (written only by
 * services/backend) plus the two actions the request path IS allowed to
 * take on an existing row: dismiss (job_match.dismissed_at, the one column
 * app_web has UPDATE on - migration 0011) and track (create a
 * job_application from it - see repositories/applications.ts's
 * createApplicationFromMatch).
 */

interface MatchRow {
  id: string;
  account_id: string;
  job_posting_id: string;
  job_posting_version_id: string;
  title: string;
  company: string | null;
  score: number;
  vector_score: number;
  keyword_score: number;
  skill_score: number;
  seniority_score: number;
  location_score: number;
  comp_score: number | null;
  freshness_score: number;
  ranked_at: Date;
  explanation_summary: string | null;
  explanation_evidence: Array<{ claim: string; fact_ref: string; provenance: string }> | null;
}

const MATCH_SELECT = `
  SELECT m.id, m.account_id, m.job_posting_id, m.job_posting_version_id,
         v.title, co.name AS company,
         m.score, m.vector_score, m.keyword_score, m.skill_score, m.seniority_score,
         m.location_score, m.comp_score, m.freshness_score, m.ranked_at,
         e.summary AS explanation_summary, e.evidence AS explanation_evidence
  FROM job_match m
  JOIN job_posting_version v ON v.id = m.job_posting_version_id
  JOIN job_posting jp ON jp.id = m.job_posting_id
  JOIN company co ON co.id = jp.company_id
  LEFT JOIN match_explanation e
    ON e.account_id = m.account_id AND e.job_posting_version_id = m.job_posting_version_id
`;

function toSummary(row: MatchRow): JobMatchSummary {
  return {
    id: row.id,
    accountId: AccountId(row.account_id),
    jobPostingId: row.job_posting_id,
    jobPostingVersionId: row.job_posting_version_id,
    title: row.title,
    company: row.company,
    score: row.score,
    vectorScore: row.vector_score,
    keywordScore: row.keyword_score,
    skillScore: row.skill_score,
    seniorityScore: row.seniority_score,
    locationScore: row.location_score,
    compScore: row.comp_score,
    freshnessScore: row.freshness_score,
    rankedAt: row.ranked_at,
    explanation:
      row.explanation_summary != null && row.explanation_evidence != null
        ? {
            summary: row.explanation_summary,
            evidence: row.explanation_evidence.map((e) => ({
              claim: e.claim,
              factRef: e.fact_ref,
              provenance: e.provenance,
            })),
          }
        : null,
  };
}

/** The feed's own order: best (non-dismissed) matches first - mirrors job_match_feed_idx. */
export async function listMatches(tx: Queryable, accountId: AccountId): Promise<JobMatchSummary[]> {
  const { rows } = await tx.query<MatchRow>(
    `${MATCH_SELECT} WHERE m.account_id = $1 AND m.dismissed_at IS NULL ORDER BY m.score DESC`,
    [accountId],
  );
  return rows.map(toSummary);
}

export async function getMatchById(
  tx: Queryable,
  accountId: AccountId,
  matchId: string,
): Promise<JobMatchSummary | null> {
  const { rows } = await tx.query<MatchRow>(`${MATCH_SELECT} WHERE m.account_id = $1 AND m.id = $2`, [
    accountId,
    matchId,
  ]);
  return rows[0] ? toSummary(rows[0]) : null;
}

/** The only write app_web is granted on job_match (column-level UPDATE (dismissed_at), migration 0011). */
export async function dismissMatch(
  tx: Queryable,
  accountId: AccountId,
  matchId: string,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE job_match SET dismissed_at = now() WHERE account_id = $1 AND id = $2 AND dismissed_at IS NULL`,
    [accountId, matchId],
  );
  return (rowCount ?? 0) > 0;
}
