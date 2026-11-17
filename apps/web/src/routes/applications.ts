import type { FastifyInstance } from 'fastify';
import {
  createApplicationInput,
  Errors,
  Events,
  isUuid,
  patchApplicationInput,
  tailorApplicationInput,
  type ApplicationStatusChangedPayload,
  type ResumeTailoringProposedPayload,
} from '@jobswitch/core';
import { applicationsRepo, artifactsRepo, outreachRepo, profileRepo, withAccount } from '@jobswitch/db';

/**
 * The application tracker (Phase 7) - job_application/application_event,
 * plus the tailor endpoint that kicks off Graph A. See
 * specs/application-workspace.md for the deliberate deviation from the
 * build plan's literal `POST .../tailor -> 202 {queueJobId}` contract:
 * this runs synchronously (see that spec for why).
 */
export async function registerApplicationRoutes(app: FastifyInstance): Promise<void> {
  const { pool, events, aiClient } = app.authDeps;

  app.get('/api/v1/applications', { preHandler: app.requireAuth }, async (request) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    const applications = await withAccount(pool, principal.accountId, (tx) =>
      applicationsRepo.listApplications(tx, principal.accountId),
    );
    return { applications };
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/applications/:id',
    { preHandler: app.requireAuth },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That application');

      return withAccount(pool, principal.accountId, async (tx) => {
        const application = await applicationsRepo.getApplicationById(tx, principal.accountId, id);
        if (!application) throw Errors.notFound('That application');

        // Sequential, not Promise.all - tx is a single pooled client (see
        // profile.ts route's own comment for the same reasoning).
        const events_ = await applicationsRepo.listApplicationEvents(tx, principal.accountId, id);
        const artifacts = await artifactsRepo.listArtifactsForApplication(tx, principal.accountId, id);
        const outreach = await outreachRepo.listOutreachForApplication(tx, principal.accountId, id);

        return { application, events: events_, artifacts, outreach };
      });
    },
  );

  app.post('/api/v1/applications', { preHandler: app.requireAuth }, async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    const parsed = createApplicationInput.safeParse(request.body);
    if (!parsed.success) throw Errors.validation(parsed.error.flatten());

    const application = await withAccount(pool, principal.accountId, (tx) =>
      applicationsRepo.createManualApplication(tx, principal.accountId, parsed.data),
    );
    return reply.status(201).send({ application });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/v1/applications/:id',
    { preHandler: app.requireAuth },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That application');

      const parsed = patchApplicationInput.safeParse(request.body);
      if (!parsed.success) throw Errors.validation(parsed.error.flatten());
      const patch = parsed.data;

      const result = await withAccount(pool, principal.accountId, (tx) =>
        applicationsRepo.patchApplication(tx, principal.accountId, id, {
          status: patch.status,
          notes: patch.notes,
          nextActionAt: patch.nextActionAt ? new Date(patch.nextActionAt) : undefined,
          appliedAt: patch.appliedAt ? new Date(patch.appliedAt) : undefined,
        }),
      );
      if (!result) throw Errors.notFound('That application');

      if (result.statusChanged) {
        void events
          .publish(principal.accountId, Events.APPLICATION_STATUS_CHANGED, {
            accountId: principal.accountId,
            applicationId: id,
            fromStatus: result.fromStatus,
            toStatus: result.application.status,
          } satisfies ApplicationStatusChangedPayload)
          .catch((error) => request.log.error({ err: error }, 'publishing application.status_changed failed'));
      }

      return { application: result.application };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/applications/:id/tailor',
    { preHandler: app.requireAuth },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That application');

      const parsed = tailorApplicationInput.safeParse(request.body);
      if (!parsed.success) throw Errors.validation(parsed.error.flatten());
      const { variantId } = parsed.data;

      // Everything this needs to actually call the AI service is gathered
      // and validated inside one transaction; the AI call itself happens
      // OUTSIDE it (see below) - an LLM call can take several seconds, and
      // holding a pooled connection/transaction open for that whole span
      // would starve the pool under any real concurrent load.
      const prepared = await withAccount(pool, principal.accountId, async (tx) => {
        const application = await applicationsRepo.getApplicationById(tx, principal.accountId, id);
        if (!application) throw Errors.notFound('That application');

        const jobContext = applicationsRepo.jobContextFor(application);
        if (!jobContext) {
          throw Errors.validation('This application has no job description to tailor against yet.');
        }

        const resumeSource = await artifactsRepo.getResumeSource(tx, principal.accountId, variantId);
        if (!resumeSource) throw Errors.notFound('That resume variant');

        const facts = await profileRepo.buildCandidateFacts(tx, principal.accountId);

        await applicationsRepo.patchApplication(tx, principal.accountId, id, { status: 'tailoring' });

        return { jobContext, resumeSource, facts };
      });

      let artifactId: string;
      let publishStatus: 'proposed' | 'failed';

      try {
        const result = await aiClient.tailorResume({
          tex: prepared.resumeSource.tex,
          job: prepared.jobContext,
          facts: prepared.facts,
        });

        const artifact = await withAccount(pool, principal.accountId, (tx) =>
          artifactsRepo.createArtifact(tx, principal.accountId, {
            applicationId: id,
            variantId,
            sourceSha256: prepared.resumeSource.sha256,
            status: 'proposed',
            proposedChanges: result.proposedChanges,
            flags: result.flags,
            tex: result.tex,
          }),
        );
        artifactId = artifact.id;
        publishStatus = 'proposed';
      } catch (error) {
        request.log.error({ err: error }, 'tailoring resume failed');
        const artifact = await withAccount(pool, principal.accountId, (tx) =>
          artifactsRepo.createArtifact(tx, principal.accountId, {
            applicationId: id,
            variantId,
            sourceSha256: prepared.resumeSource.sha256,
            status: 'failed',
            compileError: error instanceof Error ? error.message : String(error),
          }),
        );
        artifactId = artifact.id;
        publishStatus = 'failed';
      }

      void events
        .publish(principal.accountId, Events.RESUME_TAILORING_PROPOSED, {
          accountId: principal.accountId,
          applicationId: id,
          artifactId,
          status: publishStatus,
        } satisfies ResumeTailoringProposedPayload)
        .catch((error) => request.log.error({ err: error }, 'publishing resume.tailoring.proposed failed'));

      const artifact = await withAccount(pool, principal.accountId, (tx) =>
        artifactsRepo.getArtifactById(tx, principal.accountId, artifactId),
      );
      return { artifact };
    },
  );
}
