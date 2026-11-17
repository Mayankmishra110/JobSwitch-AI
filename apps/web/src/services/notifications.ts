import {
  AccountId,
  Events,
  type JobSearchStoppedPayload,
  type MatchComputedPayload,
} from '@jobswitch/core';
import {
  emailCredentialRepo,
  identityRepo,
  withAccount,
  withoutTenantContext,
  type Pool,
} from '@jobswitch/db';
import type { Config } from '../config.js';
import type { EventBus } from './events.js';
import type { Mailer } from './mailer.js';
import { sendGmailMessage } from './gmailSend.js';

/**
 * Phase 8: wiring job_search.stopped/match.computed to real email, now
 * that both the event bus (Phase 5.5) and the Gmail integration (Phase 7)
 * exist - docs/BUILD_PLAN.md's own words for this phase.
 *
 * Sends through the SAME per-account Gmail credential outreach already
 * uses (repositories/emailCredential.ts), to that account's own
 * registered login email - "notify yourself, via your own connected
 * inbox" rather than a separate system service-account mailer, because no
 * such system account exists anywhere in this build (there was never a
 * transactional-email provider to wire up, only Gmail). An account with no
 * linked Gmail falls back to the general-purpose `Mailer`
 * (services/mailer.ts, `log`/`noop` today) rather than silently dropping
 * the notification - the same "degrade, don't drop" instinct
 * events.Publisher's own nil-safety already applies one layer down on the
 * Go side.
 *
 * Deliberately OFF by default (`NOTIFICATIONS_ENABLED`, config.ts): this
 * is new standing background behavior (a process-wide cross-account NATS
 * subscription, running for the life of the server), not a per-request
 * code path - the same "explicit config over a silent default" rule
 * MAIL_TRANSPORT and GOOGLE_* already follow in this codebase.
 */

async function accountEmail(pool: Pool, accountId: string): Promise<string | null> {
  return withoutTenantContext(pool, (tx) => identityRepo.findAccountOwnerEmail(tx, AccountId(accountId)));
}

async function sendNotification(
  pool: Pool,
  mailer: Mailer,
  config: Config,
  accountId: string,
  subject: string,
  text: string,
): Promise<void> {
  const to = await accountEmail(pool, accountId);
  if (!to) return; // no owning member found (e.g. a deleted account) - nothing to notify

  const refreshToken = config.gmail.enabled
    ? await withAccount(pool, AccountId(accountId), (tx) =>
        emailCredentialRepo.getDecryptedRefreshToken(tx, AccountId(accountId), config.gmail.enabled ? config.gmail.encryptionKey : ''),
      )
    : null;

  if (refreshToken && config.gmail.enabled) {
    await sendGmailMessage(
      { clientId: config.gmail.clientId, clientSecret: config.gmail.clientSecret },
      refreshToken,
      { from: 'me', to, subject, bodyText: text },
    );
    return;
  }

  await mailer.send({ to, subject, text });
}

function jobSearchStoppedMessage(payload: JobSearchStoppedPayload): { subject: string; text: string } {
  return {
    subject: 'Your job search has stopped',
    text: [
      'Your active job search on JobSwitch AI has stopped, and everything tied to it has been permanently deleted:',
      '',
      ...payload.purgedTables.map((t) => `- ${t}`),
      '',
      'Start a new search any time by uploading a resume again.',
    ].join('\n'),
  };
}

function matchComputedMessage(payload: MatchComputedPayload): { subject: string; text: string } | null {
  if (payload.matchesWritten === 0) return null; // nothing new to report - don't send an empty-handed email
  return {
    subject: `${payload.matchesWritten} job match${payload.matchesWritten === 1 ? '' : 'es'} found`,
    text: `Your latest matching run found ${payload.matchesWritten} live match${payload.matchesWritten === 1 ? '' : 'es'}. Sign in to review them.`,
  };
}

/**
 * Runs until `signal` aborts. Two independent subscriptions, not one
 * multiplexed on a shared subject wildcard - JOB_SEARCH_STOPPED and
 * MATCH_COMPUTED have different payload shapes and different messages, and
 * keeping them as two plain loops is more obviously correct than one loop
 * branching on an event-name string.
 */
export async function runNotificationSubscriber(
  pool: Pool,
  mailer: Mailer,
  config: Config,
  events: EventBus,
  signal: AbortSignal,
  onError: (context: string, error: unknown) => void = () => {},
): Promise<void> {
  await Promise.all([
    (async () => {
      for await (const { accountId, payload } of events.subscribeEvent(Events.JOB_SEARCH_STOPPED, signal)) {
        try {
          const message = jobSearchStoppedMessage(payload as JobSearchStoppedPayload);
          await sendNotification(pool, mailer, config, accountId, message.subject, message.text);
        } catch (error) {
          onError('job_search.stopped notification failed', error);
        }
      }
    })(),
    (async () => {
      for await (const { accountId, payload } of events.subscribeEvent(Events.MATCH_COMPUTED, signal)) {
        try {
          const message = matchComputedMessage(payload as MatchComputedPayload);
          if (!message) continue;
          await sendNotification(pool, mailer, config, accountId, message.subject, message.text);
        } catch (error) {
          onError('match.computed notification failed', error);
        }
      }
    })(),
  ]);
}
