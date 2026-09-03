import type { FastifyInstance } from 'fastify';
import { Errors, startJobSearchInput } from '@jobswitch/core';
import { jobSearchRepo, withAccount } from '@jobswitch/db';

/**
 * Job search lifecycle - Layer 2, ephemeral resume retention (ADR D-31).
 *
 * "Start" and "upload a resume" are one request; "stop" is a synchronous,
 * transactional purge, not a queued job - see jobSearch.ts's stopJobSearch
 * for why that has to be true for "boom, gone" to be an honest claim.
 */
export async function registerJobSearchRoutes(app: FastifyInstance): Promise<void> {
  const { pool } = app.authDeps;

  app.get('/api/v1/job-search/status', { preHandler: app.requireAuth }, async (request) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    return withAccount(pool, principal.accountId, async (tx) => {
      const session = await jobSearchRepo.getActiveSession(tx, principal.accountId);
      if (!session) return { active: false, session: null, resume: null };

      const resume = await jobSearchRepo.getResumeUpload(tx, principal.accountId);
      return {
        active: true,
        session,
        resume: resume ? { filename: resume.filename, uploadedAt: resume.uploadedAt } : null,
      };
    });
  });

  app.post('/api/v1/job-search/start', { preHandler: app.requireAuth }, async (request) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    const parsed = startJobSearchInput.safeParse(request.body);
    if (!parsed.success) throw Errors.validation(parsed.error.flatten());

    const result = await withAccount(pool, principal.accountId, (tx) =>
      jobSearchRepo.startJobSearch(tx, principal.accountId, parsed.data),
    );

    return {
      session: result.session,
      resume: { filename: result.resume.filename, uploadedAt: result.resume.uploadedAt },
    };
  });

  app.post('/api/v1/job-search/stop', { preHandler: app.requireAuth }, async (request) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    const result = await withAccount(pool, principal.accountId, (tx) =>
      jobSearchRepo.stopJobSearch(tx, principal.accountId, 'user_action'),
    );
    if (!result) throw Errors.notFound('An active job search');

    return { session: result.session, purgedTables: result.purgedTables };
  });
}
