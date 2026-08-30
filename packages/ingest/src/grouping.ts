import { jobsRepo, type Queryable } from '@jobswitch/db';
import { textSimilarity } from './normalize.js';

/**
 * Group linking (ADR D-03).
 *
 * Links postings believed to describe the same underlying role. It NEVER
 * merges them: both source records keep their own row, their own apply URL and
 * their own version history, and a link can be removed with nothing lost.
 *
 * Linking changes exactly two things, both at the presentation layer:
 *   - match lists render one card per group;
 *   - notification suppression is keyed on the group, which is what stops a
 *     repost firing "NEW JOB!" at someone who already dismissed it.
 *
 * The thresholds are deliberately high. The failure modes are not symmetric:
 * a missed link shows a duplicate card, which the user sees and shrugs at; a
 * wrong link hides a posting they needed, and they never learn it happened.
 * When uncertain, do not link.
 */

/** Same content, seen again after the earlier posting closed. */
export const REPOST_SIMILARITY_THRESHOLD = 0.75;

/** Same role visible through two of a company's sources. */
export const CROSS_SOURCE_SIMILARITY_THRESHOLD = 0.8;

/** How long after closing a re-appearance still counts as a repost. */
export const REPOST_WINDOW_DAYS = 120;

export interface LinkInput {
  postingId: string;
  companyId: string;
  careerSourceId: string;
  normalizedTitle: string;
  fingerprint: string;
  descriptionText: string | null;
}

export type LinkDecision =
  | { linked: false; reason: 'no_candidate' | 'below_threshold' }
  | {
      linked: true;
      reason: 'repost' | 'cross_source' | 'location_variant';
      groupId: string;
      confidence: number;
    };

/**
 * Decide whether a newly created posting belongs with an existing one.
 *
 * Only called for postings that were just created - an update to a known
 * posting cannot change its identity, so re-evaluating grouping on every run
 * would burn queries to reach the same answer.
 */
export async function linkNewPosting(
  tx: Queryable,
  input: LinkInput,
): Promise<LinkDecision> {
  const candidates = await jobsRepo.findGroupCandidates(tx, {
    companyId: input.companyId,
    normalizedTitle: input.normalizedTitle,
    excludePostingId: input.postingId,
  });

  if (candidates.length === 0) return { linked: false, reason: 'no_candidate' };

  const cutoff = Date.now() - REPOST_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  let best: {
    candidate: (typeof candidates)[number];
    reason: 'repost' | 'cross_source' | 'location_variant';
    confidence: number;
  } | null = null;

  for (const candidate of candidates) {
    // An identical fingerprint is the strongest possible signal: byte-identical
    // normalized content at the same company under the same title.
    const identical = candidate.fingerprint === input.fingerprint;

    const similarity = identical
      ? 1
      : input.descriptionText
        ? await similarityToCandidate(tx, candidate.id, input.descriptionText)
        : 0;

    const sameSource = candidate.careerSourceId === input.careerSourceId;
    const closedRecently =
      candidate.closedAt !== null && candidate.closedAt.getTime() >= cutoff;

    let reason: 'repost' | 'cross_source' | 'location_variant' | null = null;

    if (sameSource && closedRecently && similarity >= REPOST_SIMILARITY_THRESHOLD) {
      // Same board, previous instance closed, same role: a repost.
      reason = 'repost';
    } else if (!sameSource && similarity >= CROSS_SOURCE_SIMILARITY_THRESHOLD) {
      // Two of the company's boards showing one role. Both postings keep their
      // own apply URL - they may genuinely differ.
      reason = 'cross_source';
    } else if (
      sameSource &&
      candidate.closedAt === null &&
      similarity >= CROSS_SOURCE_SIMILARITY_THRESHOLD
    ) {
      // Same board, both open, same title and near-identical text: separate
      // requisitions for different cities. Still separate postings, because
      // the user may need to apply to a specific one.
      reason = 'location_variant';
    }

    if (reason && (!best || similarity > best.confidence)) {
      best = { candidate, reason, confidence: similarity };
    }
  }

  if (!best) return { linked: false, reason: 'below_threshold' };

  const groupId = await jobsRepo.linkIntoGroup(tx, {
    postingId: input.postingId,
    companyId: input.companyId,
    existingGroupId: best.candidate.groupId,
    representativePostingId: best.candidate.id,
    reason: best.reason,
    confidence: Number(best.confidence.toFixed(4)),
  });

  if (best.reason === 'repost') {
    await jobsRepo.markAsRepost(tx, input.postingId);
  }

  return {
    linked: true,
    reason: best.reason,
    groupId,
    confidence: best.confidence,
  };
}

async function similarityToCandidate(
  tx: Queryable,
  candidateId: string,
  descriptionText: string,
): Promise<number> {
  const { rows } = await tx.query<{ description_text: string | null }>(
    `SELECT v.description_text
     FROM job_posting jp
     JOIN job_posting_version v ON v.id = jp.current_version_id
     WHERE jp.id = $1`,
    [candidateId],
  );

  const other = rows[0]?.description_text;
  if (!other) return 0;

  return textSimilarity(descriptionText, other);
}
