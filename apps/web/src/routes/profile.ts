import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  Errors,
  experienceInput,
  isUuid,
  replaceSkillsInput,
  resumeVariantIdInput,
  updateExperienceInput,
  upsertProfileInput,
  upsertResumeSourceInput,
  type ExperienceInput,
} from '@jobswitch/core';
import { artifactsRepo, profileRepo, withAccount } from '@jobswitch/db';

/**
 * Personal profile routes - Layer 2, Phase 4.
 *
 * Every handler runs inside `withAccount`, the only sanctioned way for
 * request-path code to touch a tenant-scoped table (see context.ts). RLS
 * would also block a cross-tenant read or write on its own - these two checks
 * are deliberately independent, not one relying on the other.
 */
export async function registerProfileRoutes(app: FastifyInstance): Promise<void> {
  const { pool } = app.authDeps;

  app.get('/api/v1/profile', { preHandler: app.requireAuth }, async (request) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    return withAccount(pool, principal.accountId, async (tx) => {
      // Sequential, not Promise.all: tx is a single pooled client, and a
      // client can only have one query in flight at a time.
      const profile = await profileRepo.getProfile(tx, principal.accountId);
      const skills = await profileRepo.listSkills(tx, principal.accountId);
      const experience = await profileRepo.listExperience(tx, principal.accountId);
      return { profile, skills, experience };
    });
  });

  app.put('/api/v1/profile', { preHandler: app.requireAuth }, async (request) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    const parsed = upsertProfileInput.safeParse(request.body);
    if (!parsed.success) throw Errors.validation(parsed.error.flatten());

    const profile = await withAccount(pool, principal.accountId, (tx) =>
      profileRepo.upsertProfile(tx, principal.accountId, parsed.data),
    );
    return { profile };
  });

  app.put('/api/v1/profile/skills', { preHandler: app.requireAuth }, async (request) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    const parsed = replaceSkillsInput.safeParse(request.body);
    if (!parsed.success) throw Errors.validation(parsed.error.flatten());

    const skills = await withAccount(pool, principal.accountId, (tx) =>
      profileRepo.replaceSkills(tx, principal.accountId, parsed.data.skills),
    );
    return { skills };
  });

  app.post('/api/v1/profile/experience', { preHandler: app.requireAuth }, async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    const parsed = experienceInput.safeParse(request.body);
    if (!parsed.success) throw Errors.validation(parsed.error.flatten());

    const entry = await withAccount(pool, principal.accountId, (tx) =>
      profileRepo.addExperience(tx, principal.accountId, parsed.data),
    );
    return reply.status(201).send({ experience: entry });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/v1/profile/experience/:id',
    { preHandler: app.requireAuth },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That experience entry');

      const parsedPatch = updateExperienceInput.safeParse(request.body);
      if (!parsedPatch.success) throw Errors.validation(parsedPatch.error.flatten());
      const patch = parsedPatch.data;

      return withAccount(pool, principal.accountId, async (tx) => {
        const existing = await profileRepo.getExperienceById(tx, principal.accountId, id);
        if (!existing) throw Errors.notFound('That experience entry');

        // Marking a role current clears its end date unless the caller also
        // sent one explicitly - otherwise a role that once had an end date
        // could never be marked current again through this endpoint, since
        // there is no separate way to null out endDate on its own.
        const clearEndDate = patch.isCurrent === true && patch.endDate === undefined;

        const merged: ExperienceInput = {
          company: patch.company ?? existing.company,
          title: patch.title ?? existing.title,
          location: patch.location !== undefined ? patch.location : (existing.location ?? undefined),
          startDate: patch.startDate ?? existing.startDate,
          endDate: clearEndDate
            ? undefined
            : patch.endDate !== undefined
              ? patch.endDate
              : (existing.endDate ?? undefined),
          isCurrent: patch.isCurrent !== undefined ? patch.isCurrent : existing.isCurrent,
          description:
            patch.description !== undefined ? patch.description : (existing.description ?? undefined),
        };

        const revalidated = experienceInput.safeParse(merged);
        if (!revalidated.success) throw Errors.validation(revalidated.error.flatten());

        const updated = await profileRepo.updateExperience(tx, principal.accountId, id, revalidated.data);
        if (!updated) throw Errors.notFound('That experience entry');
        return { experience: updated };
      });
    },
  );

  // ---- resume_source - the candidate's LaTeX template(s) (Phase 7) ------

  app.get('/api/v1/profile/resume-source', { preHandler: app.requireAuth }, async (request) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    const sources = await withAccount(pool, principal.accountId, (tx) =>
      artifactsRepo.listResumeSources(tx, principal.accountId),
    );
    // tex omitted from the list view - each entry can be tens of KB, and
    // the picker (screen 2's tailor button) only needs variantId/label.
    return { sources: sources.map(({ tex: _tex, ...rest }) => rest) };
  });

  app.get<{ Params: { variantId: string } }>(
    '/api/v1/profile/resume-source/:variantId',
    { preHandler: app.requireAuth },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const source = await withAccount(pool, principal.accountId, (tx) =>
        artifactsRepo.getResumeSource(tx, principal.accountId, request.params.variantId),
      );
      if (!source) throw Errors.notFound('That resume');
      return { source };
    },
  );

  app.put<{ Params: { variantId: string } }>(
    '/api/v1/profile/resume-source/:variantId',
    { preHandler: app.requireAuth },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const parsedVariant = resumeVariantIdInput.safeParse(request.params.variantId);
      if (!parsedVariant.success) throw Errors.validation(parsedVariant.error.flatten());

      const parsed = upsertResumeSourceInput.safeParse(request.body);
      if (!parsed.success) throw Errors.validation(parsed.error.flatten());

      const sha256 = createHash('sha256').update(parsed.data.tex, 'utf8').digest('hex');

      const source = await withAccount(pool, principal.accountId, (tx) =>
        artifactsRepo.upsertResumeSource(tx, principal.accountId, {
          variantId: parsedVariant.data,
          label: parsed.data.label,
          pdfBaseName: parsed.data.pdfBaseName,
          tex: parsed.data.tex,
          sha256,
        }),
      );
      return { source };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/profile/experience/:id',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That experience entry');

      const deleted = await withAccount(pool, principal.accountId, (tx) =>
        profileRepo.deleteExperience(tx, principal.accountId, id),
      );
      if (!deleted) throw Errors.notFound('That experience entry');
      return reply.status(204).send();
    },
  );
}
