import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseResumeSource } from '@jobswitch/resume-core';

const parseInput = z.object({
  tex: z.string().min(1, 'tex is required'),
});

export async function registerParseRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/parse', async (request, reply) => {
    const parsed = parseInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_failed', message: parsed.error.message });
    }

    const result = parseResumeSource(parsed.data.tex);
    return { fields: result.fields, structured: result.structured };
  });
}
