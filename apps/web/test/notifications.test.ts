import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Events, type JobSearchStoppedPayload, type MatchComputedPayload } from '@jobswitch/core';
import { createPool, identityRepo, withoutTenantContext, type Pool } from '@jobswitch/db';
import { loadConfig, type Config } from '../src/config.js';
import { createEventBus, type EventBus } from '../src/services/events.js';
import { runNotificationSubscriber } from '../src/services/notifications.js';
import type { Mailer, OutboundEmail } from '../src/services/mailer.js';

/**
 * Phase 8's notification subscriber - run against the REAL NATS service
 * (docker-compose's `nats`), a real Postgres account/user, and a fake
 * `Mailer` that records what would have been sent (no Gmail credential is
 * configured in this suite, matching this build's real, disclosed state -
 * see specs/application-workspace.md - so every send here goes through
 * the general-purpose Mailer fallback, not a real Gmail call).
 */

const DB_URL =
  process.env.DATABASE_URL_TEST ??
  'postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test';
const NATS_URL = process.env.NATS_URL_TEST ?? 'nats://127.0.0.1:4222';

let pool: Pool;
let config: Config;

beforeAll(async () => {
  pool = createPool({ connectionString: DB_URL, max: 5 });
  config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-32',
    APP_ORIGIN: 'http://localhost:3000',
    MAIL_TRANSPORT: 'noop',
    NATS_URL,
  });
});

afterAll(async () => {
  await pool?.end();
});

function recordingMailer(): Mailer & { sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = [];
  return {
    sent,
    async send(email) {
      sent.push(email);
    },
  };
}

async function createAccount(email: string): Promise<string> {
  const created = await withoutTenantContext(pool, (tx) =>
    identityRepo.createUserWithAccount(tx, { email, fullName: 'Notify Test' }),
  );
  return created.accountId;
}

let events: EventBus;
let abortController: AbortController;
let subscriberDone: Promise<void>;

afterEach(async () => {
  abortController?.abort();
  await subscriberDone?.catch(() => {});
  await events?.close();
});

describe('runNotificationSubscriber', () => {
  it('emails the account owner when job_search.stopped fires for their account', async () => {
    const accountId = await createAccount('notify-stop@example.com');
    const mailer = recordingMailer();
    events = createEventBus(NATS_URL);
    abortController = new AbortController();
    subscriberDone = runNotificationSubscriber(pool, mailer, config, events, abortController.signal);

    // Give the two subscribeEvent loops time to actually establish their
    // NATS subscriptions before publishing - otherwise this publish could
    // race ahead of `nc.subscribe()` actually registering.
    await new Promise((r) => setTimeout(r, 200));

    await events.publish(accountId, Events.JOB_SEARCH_STOPPED, {
      accountId,
      purgedTables: ['resume_upload', 'job_application'],
    } satisfies JobSearchStoppedPayload);

    await vi_waitFor(() => mailer.sent.length > 0);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('notify-stop@example.com');
    expect(mailer.sent[0]!.subject).toContain('stopped');
    expect(mailer.sent[0]!.text).toContain('resume_upload');
  });

  it('emails the account owner when match.computed reports at least one match', async () => {
    const accountId = await createAccount('notify-match@example.com');
    const mailer = recordingMailer();
    events = createEventBus(NATS_URL);
    abortController = new AbortController();
    subscriberDone = runNotificationSubscriber(pool, mailer, config, events, abortController.signal);
    await new Promise((r) => setTimeout(r, 200));

    await events.publish(accountId, Events.MATCH_COMPUTED, {
      accountId,
      matchesWritten: 3,
    } satisfies MatchComputedPayload);

    await vi_waitFor(() => mailer.sent.length > 0);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('notify-match@example.com');
    expect(mailer.sent[0]!.subject).toContain('3');
  });

  it('does NOT email when match.computed reports zero matches', async () => {
    const accountId = await createAccount('notify-zero@example.com');
    const mailer = recordingMailer();
    events = createEventBus(NATS_URL);
    abortController = new AbortController();
    subscriberDone = runNotificationSubscriber(pool, mailer, config, events, abortController.signal);
    await new Promise((r) => setTimeout(r, 200));

    await events.publish(accountId, Events.MATCH_COMPUTED, {
      accountId,
      matchesWritten: 0,
    } satisfies MatchComputedPayload);

    // Prove absence by racing a real, later signal rather than a bare
    // sleep-and-hope: publish a second, real job_search.stopped for the
    // SAME account and wait for that mail instead - if the zero-match
    // event had (wrongly) sent something, it would already be in
    // mailer.sent by the time this second, later event's mail arrives.
    await events.publish(accountId, Events.JOB_SEARCH_STOPPED, {
      accountId,
      purgedTables: [],
    } satisfies JobSearchStoppedPayload);
    await vi_waitFor(() => mailer.sent.length > 0);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toContain('stopped');
  });

  it('only notifies the account the event was published for, never another one', async () => {
    const accountA = await createAccount('notify-isolation-a@example.com');
    const accountB = await createAccount('notify-isolation-b@example.com');
    const mailer = recordingMailer();
    events = createEventBus(NATS_URL);
    abortController = new AbortController();
    subscriberDone = runNotificationSubscriber(pool, mailer, config, events, abortController.signal);
    await new Promise((r) => setTimeout(r, 200));

    await events.publish(accountB, Events.JOB_SEARCH_STOPPED, {
      accountId: accountB,
      purgedTables: ['resume_upload'],
    } satisfies JobSearchStoppedPayload);
    await vi_waitFor(() => mailer.sent.length > 0);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('notify-isolation-b@example.com');
    void accountA; // seeded only to prove its mailbox stays untouched
  });
});

async function vi_waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}
