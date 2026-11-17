import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { CompileError, compileTex } from '../services/compile.js';

const compileInput = z.object({
  tex: z.string().min(1, 'tex is required'),
});

/**
 * PDF compilation is deliberately a plain endpoint, not something with its
 * own retry/queue logic here - the build plan's own framing ("PDF
 * compilation is deliberately not a graph node - it's a plain function
 * call after candidate approval, outside the graph") applies the same way
 * at this layer: compile once, report success or a real compiler error,
 * and let the caller (services/ai's Graph A, eventually apps/web) decide
 * what to do with a failure.
 */
export async function registerCompileRoutes(app: FastifyInstance, config: Config): Promise<void> {
  app.post('/v1/compile', async (request, reply) => {
    const parsed = compileInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_failed', message: parsed.error.message });
    }

    try {
      const result = await compileTex(parsed.data.tex, config.LATEX_ENGINE);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('X-Pdf-Sha256', result.pdfSha256)
        .send(result.pdfBytes);
    } catch (error) {
      if (error instanceof CompileError) {
        // 422, not 500: a document that fails to compile is a real,
        // expected outcome (a malformed edit that slipped past the
        // upstream LaTeX-safety/integrity checks), not a bug in this
        // service - the caller surfaces compile_error on resume_artifact
        // rather than treating this as an internal failure.
        return reply.status(422).send({
          error: 'compile_failed',
          message: error.message,
          log: error.log.slice(-4000),
        });
      }
      throw error;
    }
  });
}
