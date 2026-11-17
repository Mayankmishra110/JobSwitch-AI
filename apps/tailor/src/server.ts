import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerParseRoutes } from './routes/parse.js';
import { registerValidateNounsRoutes } from './routes/validateNouns.js';
import { registerReinjectRoutes } from './routes/reinject.js';
import { registerCompileRoutes } from './routes/compile.js';

/**
 * Stateless LaTeX span-surgery service (the build plan's `apps/tailor`) -
 * no database connection anywhere, same boundary as services/ai
 * (specs/architecture.md). Every route below is a pure function over its
 * request body plus, for /v1/compile, a real local LaTeX engine - nothing
 * here reads or writes Postgres, and nothing needs to.
 */

export interface BuildOptions {
  config: Config;
}

export async function buildServer(options: BuildOptions): Promise<FastifyInstance> {
  const { config } = options;

  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: 'info' },
  });

  // Internal-caller authentication, mirroring services/ai's
  // require_internal_token exactly: unset INTERNAL_TOKEN skips the check
  // entirely (local dev); configured, every /v1/* route requires an exact
  // X-Internal-Token match. /healthz is deliberately exempt, same as
  // services/ai's own healthz - a health checker (k8s liveness probe)
  // should never need a secret to ask "are you up."
  app.addHook('preHandler', async (request, reply) => {
    if (!config.INTERNAL_TOKEN) return;
    if (!request.url.startsWith('/v1/')) return;
    if (request.headers['x-internal-token'] !== config.INTERNAL_TOKEN) {
      return reply.status(401).send({ error: 'missing or invalid X-Internal-Token' });
    }
  });

  app.setErrorHandler((error: Error & { validation?: unknown }, request, reply) => {
    if (error.validation) {
      return reply.status(400).send({ error: 'validation_failed', message: error.message });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong.' });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: 'not_found', message: 'No such route.' }),
  );

  await registerHealthRoutes(app);
  await registerParseRoutes(app);
  await registerValidateNounsRoutes(app);
  await registerReinjectRoutes(app);
  await registerCompileRoutes(app, config);

  return app;
}
