import type { FastifyInstance } from 'fastify';
import {
  compileArtifactInput,
  Errors,
  Events,
  isUuid,
  type ResumeTailoringCompiledPayload,
} from '@jobswitch/core';
import { applicationsRepo, artifactsRepo, withAccount } from '@jobswitch/db';

/**
 * Resume artifacts (Phase 7) - GET one, download its PDF, and the compile
 * step: splice the candidate's accepted subset of Graph A's proposed
 * changes into the ORIGINAL resume_source (never the graph's own
 * already-spliced draft - see specs/resume-tailoring.md's own
 * fabrication_check bug for exactly why "which tex" matters here), then
 * compile it for real via apps/tailor. Synchronous, per
 * specs/application-workspace.md's documented deviation from the build
 * plan's literal `-> 202` contract: reinject+compile is deterministic
 * execution with no decision point, the same reasoning that already keeps
 * PDF compilation out of Graph A as a node.
 */
export async function registerArtifactRoutes(app: FastifyInstance): Promise<void> {
  const { pool, events, tailorClient } = app.authDeps;

  app.get<{ Params: { id: string } }>(
    '/api/v1/artifacts/:id',
    { preHandler: app.requireAuth },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That resume artifact');

      const artifact = await withAccount(pool, principal.accountId, (tx) =>
        artifactsRepo.getArtifactById(tx, principal.accountId, id),
      );
      if (!artifact) throw Errors.notFound('That resume artifact');
      return { artifact };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/artifacts/:id/pdf',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That resume artifact');

      const pdf = await withAccount(pool, principal.accountId, (tx) =>
        artifactsRepo.getArtifactPdf(tx, principal.accountId, id),
      );
      if (!pdf) throw Errors.notFound('A compiled PDF for that artifact');

      return reply
        .header('content-type', 'application/pdf')
        .header('x-pdf-sha256', pdf.pdfSha256)
        .send(pdf.pdfBytes);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/artifacts/:id/compile',
    { preHandler: app.requireAuth },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That resume artifact');

      const parsed = compileArtifactInput.safeParse(request.body);
      if (!parsed.success) throw Errors.validation(parsed.error.flatten());
      const { accepted } = parsed.data;

      const prepared = await withAccount(pool, principal.accountId, async (tx) => {
        const artifact = await artifactsRepo.getArtifactById(tx, principal.accountId, id);
        if (!artifact) throw Errors.notFound('That resume artifact');
        if (artifact.status !== 'proposed') {
          throw Errors.conflict(`This artifact is already ${artifact.status}, not proposed.`);
        }

        const resumeSource = await artifactsRepo.getResumeSource(tx, principal.accountId, artifact.variantId);
        if (!resumeSource) throw Errors.notFound('The resume this artifact was proposed against');
        if (resumeSource.sha256 !== artifact.sourceSha256) {
          // The candidate edited their resume template after this proposal
          // was made - the field offsets plan_edits reasoned about no
          // longer describe the current document. Splicing anyway risks
          // exactly the kind of silent corruption verifyKeepIntegrity
          // exists to catch one layer down; refusing here is the same
          // "hard stop, never partially trusted" rule applied one level up.
          throw Errors.conflict(
            'This resume has changed since this proposal was made - tailor again against the current version.',
          );
        }

        const unknownFields = accepted.filter(
          (field) => !artifact.proposedChanges.some((c) => c.field === field),
        );
        if (unknownFields.length > 0) {
          throw Errors.validation(`Unknown field id(s): ${unknownFields.join(', ')}`);
        }

        return { artifact, resumeSource };
      });

      const acceptedEdits = prepared.artifact.proposedChanges
        .filter((c) => accepted.includes(c.field))
        .map((c) => ({ field: c.field, rewritten: c.rewritten }));

      let publishStatus: 'compiled' | 'failed';
      try {
        const reinjected = await tailorClient.reinject(prepared.resumeSource.tex, acceptedEdits);
        if (!reinjected.integrityOk) {
          throw new Error(
            `reinject integrity check failed: ${JSON.stringify(reinjected.integrityViolations ?? [])}`,
          );
        }

        const compiled = await tailorClient.compile(reinjected.tex);

        await withAccount(pool, principal.accountId, (tx) =>
          artifactsRepo.markArtifactCompiled(tx, principal.accountId, id, {
            accepted,
            tex: reinjected.tex,
            pdfBytes: compiled.pdfBytes,
            pdfSha256: compiled.pdfSha256,
          }),
        );
        await withAccount(pool, principal.accountId, (tx) =>
          applicationsRepo.patchApplication(tx, principal.accountId, prepared.artifact.applicationId, {
            status: 'tailored',
          }),
        );
        publishStatus = 'compiled';
      } catch (error) {
        request.log.error({ err: error }, 'compiling resume artifact failed');
        await withAccount(pool, principal.accountId, (tx) =>
          artifactsRepo.markArtifactFailed(
            tx,
            principal.accountId,
            id,
            error instanceof Error ? error.message : String(error),
          ),
        );
        publishStatus = 'failed';
      }

      void events
        .publish(principal.accountId, Events.RESUME_TAILORING_COMPILED, {
          accountId: principal.accountId,
          applicationId: prepared.artifact.applicationId,
          artifactId: id,
          status: publishStatus,
        } satisfies ResumeTailoringCompiledPayload)
        .catch((error) => request.log.error({ err: error }, 'publishing resume.tailoring.compiled failed'));

      const artifact = await withAccount(pool, principal.accountId, (tx) =>
        artifactsRepo.getArtifactById(tx, principal.accountId, id),
      );
      if (publishStatus === 'failed') {
        throw Errors.conflict(`Compilation failed: ${artifact?.compileError ?? 'unknown error'}`);
      }
      return { artifact };
    },
  );
}
