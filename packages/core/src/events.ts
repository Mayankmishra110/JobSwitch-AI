/**
 * D-26's domain event catalog: NATS JetStream subjects, one per event.
 *
 * NATS is for fan-out (one fact, many independent consumers) and
 * cross-service/cross-language handoff - job_queue (packages/db/src/
 * repositories/queue.ts) stays exactly as it is for same-language,
 * single-consumer task claiming, which is a genuinely different shape.
 * Neither replaces the other; see specs/events-and-realtime.md.
 *
 * Subject shape: `account.<accountId>.<event>` for every event that
 * belongs to one tenant - this is what lets the SSE bridge subscribe to
 * exactly `account.<id>.>` and receive every event for that account with
 * no server-side fan-out logic of its own, and what keeps one account's
 * events structurally unreachable from another's subscription.
 *
 * Load-bearing payload rule (D-26): every event carries `accountId` and a
 * row reference, NEVER the content itself. An event embedding raw resume
 * text, for example, would give that text a second home inside
 * JetStream's own retention window - D-31's purge guarantee would then
 * need to chase copies through the event bus too. Pass-by-reference keeps
 * the purge boundary exactly at the tables D-31 already names.
 */

export function accountSubject(accountId: string, event: string): string {
  return `account.${accountId}.${event}`;
}

/** The wildcard subject one account's own SSE connection subscribes to. */
export function accountWildcardSubject(accountId: string): string {
  return `account.${accountId}.>`;
}

/**
 * The full catalog names every event the build plan's own table names,
 * whether or not it has a real publisher yet - a name reserved now is a
 * subject nothing else will accidentally collide with later. Every entry
 * below except JOB_POSTING_CREATED/JOB_VERSION_EMBEDDED now has a real
 * publisher AND a real consumer (the SSE bridge) as of Phase 7.
 *
 * `JOB_POSTING_CREATED`/`JOB_VERSION_EMBEDDED` are catalog entries only,
 * not wired via NATS: their one real consumer today (queue the next
 * processing step) is already `job_queue` - `run.ts`'s own
 * `embed.job_version` enqueue (specs/matching-pipeline.md), a
 * same-language, single-consumer task, exactly job_queue's shape per
 * D-26's own "what moves to NATS vs. what stays" reasoning. They would
 * earn a NATS event the day a second, independent consumer exists (the
 * plan names "ops telemetry" as one candidate) - inventing that publish
 * today with no real subscriber would be untested code with no way to
 * verify it does anything.
 */
export const Events = {
  /** Reserved - see doc comment above. Not published anywhere yet. */
  JOB_POSTING_CREATED: 'job.posting.created',
  /** Reserved - see doc comment above. Not published anywhere yet. */
  JOB_VERSION_EMBEDDED: 'job_version.embedded',
  /** Wired, Phase 5.5: services/backend's RunForAccount, after UpsertMatches commits. */
  MATCH_COMPUTED: 'match.computed',
  /** Wired, Phase 7: apps/web's PATCH /applications/:id and .../track, after the status-changing transaction commits. */
  APPLICATION_STATUS_CHANGED: 'application.status_changed',
  /** Wired, Phase 7: apps/web's POST /applications/:id/tailor, after the resume_artifact row commits. */
  RESUME_TAILORING_PROPOSED: 'resume.tailoring.proposed',
  /** Wired, Phase 7: apps/web's POST /artifacts/:id/compile, after the resume_artifact row commits. */
  RESUME_TAILORING_COMPILED: 'resume.tailoring.compiled',
  /** Wired, Phase 7: apps/web's POST /applications/:id/outreach, after the outreach_draft row commits. */
  OUTREACH_DRAFT_CREATED: 'outreach.draft.created',
  /**
   * Wired, Phase 5.5: apps/web's stop endpoint, AFTER D-31's purge
   * transaction commits, never before - "boom, gone" is a claim about
   * *when*, and this event existing is itself a signal that the purge
   * already happened.
   */
  JOB_SEARCH_STOPPED: 'job_search.stopped',
} as const;

export interface MatchComputedPayload {
  accountId: string;
  matchesWritten: number;
}

export interface JobSearchStoppedPayload {
  accountId: string;
  purgedTables: string[];
}

export interface ApplicationStatusChangedPayload {
  accountId: string;
  applicationId: string;
  fromStatus: string | null;
  toStatus: string;
}

export interface ResumeTailoringProposedPayload {
  accountId: string;
  applicationId: string;
  artifactId: string;
  status: 'proposed' | 'failed';
}

export interface ResumeTailoringCompiledPayload {
  accountId: string;
  applicationId: string;
  artifactId: string;
  status: 'compiled' | 'failed';
}

export interface OutreachDraftCreatedPayload {
  accountId: string;
  applicationId: string;
  outreachId: string;
}
