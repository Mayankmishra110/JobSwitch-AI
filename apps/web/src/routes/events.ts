import type { FastifyInstance } from 'fastify';
import { Errors } from '@jobswitch/core';

/**
 * D-26's SSE bridge: a plain `GET`, so it carries the existing
 * `js_session` cookie automatically through the same `requireAuth`
 * preHandler every other route already uses - no new auth story, no CORS
 * story, exactly the point of choosing SSE over WebSocket (which can't
 * send the cookie the same way in-browser).
 *
 * Subscribes to exactly this caller's own account subject
 * (`account.<id>.>`) - structurally unable to see another account's
 * events, not just filtered not to.
 */
export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/events/stream', { preHandler: app.requireAuth }, async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    // Fastify would otherwise try to send its own response once this
    // handler returns - hijack() tells it this route owns the raw
    // response for as long as the connection stays open.
    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx's own response buffering, if ever fronted by one
    });

    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());

    // A comment line (no `event:`/`data:`) is a valid SSE keepalive that
    // browsers ignore as a message - sent immediately so a client/proxy
    // sees bytes right away rather than an apparently-hung connection.
    reply.raw.write(': connected\n\n');

    try {
      for await (const { event, payload } of app.authDeps.events.subscribeAccount(
        principal.accountId,
        controller.signal,
      )) {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    } catch (error) {
      request.log.error({ err: error }, 'SSE stream failed');
    } finally {
      reply.raw.end();
    }
  });
}
