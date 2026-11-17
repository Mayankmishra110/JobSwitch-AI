import { connect, type NatsConnection } from '@nats-io/transport-node';
import { accountSubject, accountWildcardSubject } from '@jobswitch/core';

/**
 * D-26's event bus client for apps/web - the one process that both
 * publishes (job_search.stopped, after the D-31 purge commits) and
 * subscribes (the SSE bridge, GET /api/v1/events/stream).
 *
 * Connects lazily, not at server boot: most routes, and most of this
 * app's own tests (auth, profile, rate-limit), never touch an event at
 * all, and forcing every one of them to depend on a running NATS server
 * would be a far bigger blast radius than the feature actually needs.
 * The connection is memoized once established, exactly like
 * packages/db's own pool - one real connection per process, not one per
 * call.
 */
export interface EventBus {
  publish(accountId: string, event: string, payload: unknown): Promise<void>;
  /**
   * `signal` matters more here than it looks: without an explicit way to
   * force the underlying NATS subscription closed, a client that
   * disconnects while this generator is blocked waiting for the *next*
   * message would leak that subscription forever - a `for await` loop
   * only notices anything once another message arrives, which may never
   * happen. Aborting the signal calls `sub.unsubscribe()` directly, which
   * is what actually terminates the blocked iterator.
   */
  subscribeAccount(
    accountId: string,
    signal: AbortSignal,
  ): AsyncIterable<{ event: string; payload: unknown }>;
  /**
   * Cross-account: every account's occurrence of exactly one event name -
   * `account.*.<event>` (NATS `*` matches exactly one token, so this never
   * also matches a different event for some account). The one real caller
   * is Phase 8's notification subscriber (services/notifications.ts),
   * which by its nature has to react to job_search.stopped/match.computed
   * for whichever account it happened to, not one account chosen ahead of
   * time - the SSE bridge's per-connection subscribeAccount above is the
   * wrong shape for that.
   */
  subscribeEvent(
    event: string,
    signal: AbortSignal,
  ): AsyncIterable<{ accountId: string; payload: unknown }>;
  close(): Promise<void>;
}

export function createEventBus(natsUrl: string): EventBus {
  let connection: Promise<NatsConnection> | null = null;

  function getConnection(): Promise<NatsConnection> {
    if (!connection) {
      connection = connect({ servers: natsUrl });
    }
    return connection;
  }

  return {
    async publish(accountId, event, payload) {
      const nc = await getConnection();
      nc.publish(accountSubject(accountId, event), JSON.stringify(payload));
    },

    async *subscribeAccount(accountId, signal) {
      const nc = await getConnection();
      const sub = nc.subscribe(accountWildcardSubject(accountId));
      const onAbort = () => sub.unsubscribe();
      signal.addEventListener('abort', onAbort);
      try {
        for await (const m of sub) {
          // Subject shape is `account.<accountId>.<event...>` - strip the
          // first two tokens to recover the event name exactly as
          // packages/core's Events catalog defines it.
          const event = m.subject.split('.').slice(2).join('.');
          yield { event, payload: m.json() };
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        sub.unsubscribe();
      }
    },

    async *subscribeEvent(event, signal) {
      const nc = await getConnection();
      const sub = nc.subscribe(`account.*.${event}`);
      const onAbort = () => sub.unsubscribe();
      signal.addEventListener('abort', onAbort);
      try {
        for await (const m of sub) {
          const accountId = m.subject.split('.')[1] ?? '';
          yield { accountId, payload: m.json() };
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        sub.unsubscribe();
      }
    },

    async close() {
      if (!connection) return;
      const nc = await connection;
      await nc.drain();
    },
  };
}
