import type { FastifyInstance } from 'fastify';
import { Errors } from '@jobswitch/core';
import { identityRepo, withoutTenantContext } from '@jobswitch/db';
import { dashboardPage } from '../views/pages.js';

/** The authenticated shell. Phase 2 replaces this with the real dashboard. */
export async function registerAppRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) =>
    reply.redirect(request.principal ? '/app' : '/login'),
  );

  app.get('/app', { preHandler: app.requirePage }, async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    const user = await withoutTenantContext(app.authDeps.pool, (tx) =>
      identityRepo.findUserById(tx, principal.userId),
    );
    if (!user) throw Errors.unauthenticated();

    return reply.type('text/html').send(
      dashboardPage({
        email: user.email,
        accountId: principal.accountId,
        userId: principal.userId,
        role: principal.role,
      }),
    );
  });

  app.get('/api/v1/me', { preHandler: app.requireAuth }, async (request) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    const user = await withoutTenantContext(app.authDeps.pool, (tx) =>
      identityRepo.findUserById(tx, principal.userId),
    );
    if (!user) throw Errors.unauthenticated();

    return {
      user: { id: user.id, email: user.email, fullName: user.fullName },
      account: { id: principal.accountId, role: principal.role },
    };
  });
}
