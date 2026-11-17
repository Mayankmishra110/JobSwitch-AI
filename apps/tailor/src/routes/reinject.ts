import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyAcceptedChanges, parseResumeSource, verifyKeepIntegrity } from '@jobswitch/resume-core';

const reinjectInput = z.object({
  tex: z.string().min(1, 'tex is required'),
  accepted: z
    .array(
      z.object({
        field: z.string().min(1),
        rewritten: z.string(),
      }),
    )
    .default([]),
});

export async function registerReinjectRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/reinject', async (request, reply) => {
    const parsed = reinjectInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_failed', message: parsed.error.message });
    }

    const resume = parseResumeSource(parsed.data.tex);
    const result = applyAcceptedChanges(resume, parsed.data.accepted);
    // The caller (services/ai's Graph A) treats a false integrityOk as a
    // hard stop, never a partially-trusted result - see
    // verifyKeepIntegrity's own doc comment for what it actually checks.
    const integrity = verifyKeepIntegrity(resume, parsed.data.accepted, result.tex);

    return {
      tex: result.tex,
      applied: result.applied,
      skipped: result.skipped,
      integrityOk: integrity.ok,
      ...(integrity.ok ? {} : { integrityViolations: integrity.violations }),
    };
  });
}
