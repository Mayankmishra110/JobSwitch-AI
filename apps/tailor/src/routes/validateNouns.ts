import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseResumeSource, validateProperNouns } from '@jobswitch/resume-core';

const validateNounsInput = z.object({
  tex: z.string().min(1, 'tex is required'),
  changes: z
    .array(
      z.object({
        field: z.string().min(1),
        original: z.string(),
        rewritten: z.string(),
      }),
    )
    .default([]),
});

export async function registerValidateNounsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/validate-nouns', async (request, reply) => {
    const parsed = validateNounsInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_failed', message: parsed.error.message });
    }

    const resume = parseResumeSource(parsed.data.tex);
    const flags = validateProperNouns(resume, parsed.data.changes);
    return { flags };
  });
}
