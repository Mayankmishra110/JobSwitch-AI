import type { FastifyInstance } from 'fastify';
import { Errors, isUuid } from '@jobswitch/core';
import { applicationsRepo, matchesRepo, withAccount } from '@jobswitch/db';

/**
 * The matches feed (Phase 7) - read-only over job_match plus the two
 * actions the request path can take on an existing row: dismiss and track
 * (turn a match into a tracked application). See
 * repositories/matches.ts's own doc comment for the grant boundary this
 * rests on.
 */
export async function registerMatchRoutes(app: FastifyInstance): Promise<void> {
  const { pool } = app.authDeps;

  app.get('/api/v1/matches', { preHandler: app.requireAuth }, async (request) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    const matches = await withAccount(pool, principal.accountId, (tx) =>
      matchesRepo.listMatches(tx, principal.accountId),
    );
    return { matches };
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/matches/:id/dismiss',
    { preHandler: app.requireAuth },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That match');

      const dismissed = await withAccount(pool, principal.accountId, (tx) =>
        matchesRepo.dismissMatch(tx, principal.accountId, id),
      );
      if (!dismissed) throw Errors.notFound('That match');
      return { dismissed: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/matches/:id/track',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That match');

      const application = await withAccount(pool, principal.accountId, async (tx) => {
        const match = await matchesRepo.getMatchById(tx, principal.accountId, id);
        if (!match) throw Errors.notFound('That match');
        return applicationsRepo.createApplicationFromMatch(tx, principal.accountId, match.jobPostingId);
      });

      return reply.status(201).send({ application });
    },
  );
}
