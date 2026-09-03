import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError, type Principal } from '@jobswitch/core';
import { createPool, type Pool } from '@jobswitch/db';
import { type Config, isProduction } from './config.js';
import { createLogMailer, createNoopMailer, type Mailer } from './services/mailer.js';
import type { AuthDeps } from './services/auth.js';
import { resolveSession } from './services/auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAppRoutes } from './routes/app.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerJobSearchRoutes } from './routes/jobSearch.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyInstance {
    authDeps: AuthDeps;
    /** API guard: 401 with a JSON body. */
    requireAuth: (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>;
    /** Page guard: redirect to the sign-in page. */
    requirePage: (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>;
  }
}

export interface BuildOptions {
  config: Config;
  pool?: Pool;
  mailer?: Mailer;
}

export async function buildServer(
  options: BuildOptions,
): Promise<FastifyInstance> {
  const { config } = options;

  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: isProduction(config) ? 'info' : 'debug',
            redact: {
              // These would otherwise land in logs verbatim on every request.
              paths: [
                'req.headers.cookie',
                'req.headers.authorization',
                'req.body.password',
                'req.body.token',
              ],
              remove: true,
            },
          },
  });

  const pool =
    options.pool ??
    createPool({
      connectionString: config.DATABASE_URL,
      max: config.DATABASE_POOL_MAX,
      applicationName: 'jobswitch-web',
      ssl: config.DATABASE_SSL,
    });

  const mailer =
    options.mailer ??
    (config.MAIL_TRANSPORT === 'log'
      ? createLogMailer(app.log)
      : createNoopMailer());

  app.decorate('authDeps', { pool, config, mailer } satisfies AuthDeps);
  app.decorateRequest('principal', null);

  await app.register(helmet, {
    // No inline scripts anywhere; styles are inline in the page head, which is
    // why style-src needs 'unsafe-inline' and script-src does not.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    hsts: isProduction(config)
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
    referrerPolicy: { policy: 'same-origin' },
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(formbody);

  // In-memory store: correct for a single VPS (ADR D-13 - no Redis at MVP).
  // Becomes per-instance and therefore weaker the moment there are two web
  // processes, which is the point at which this needs a shared store.
  await app.register(rateLimit, {
    global: false,
    max: 100,
    timeWindow: '1 minute',
  });

  // Attach the principal to every request. Never throws: routes decide whether
  // authentication is required.
  app.addHook('preHandler', async (request) => {
    const raw = request.cookies[config.SESSION_COOKIE_NAME];
    if (!raw) return;
    try {
      request.principal = await resolveSession(app.authDeps, raw);
    } catch (error) {
      request.log.error({ err: error }, 'session resolution failed');
      request.principal = null;
    }
  });

  // Two guards rather than one that sniffs the Accept header. A browser
  // navigating to a page can send almost anything in Accept, and a page that
  // answers a navigation with a JSON 401 looks broken. The route knows what it
  // is; the header does not.
  app.decorate('requireAuth', async (request, reply) => {
    if (request.principal) return;
    return reply
      .status(401)
      .send({ error: 'unauthenticated', message: 'Please sign in to continue.' });
  });

  app.decorate('requirePage', async (request, reply) => {
    if (request.principal) return;
    return reply.redirect('/login');
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      // Client errors are expected traffic, not incidents. Logging them at
      // error level would bury real failures under wrong-password noise.
      request.log.debug({ code: error.code }, error.message);
      return reply
        .status(error.status)
        .send({ error: error.code, message: error.safeMessage });
    }

    if ((error as { validation?: unknown }).validation) {
      return reply
        .status(400)
        .send({ error: 'validation_failed', message: 'Check the submitted fields.' });
    }

    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({
        error: 'rate_limited',
        message: 'Too many attempts. Please wait a moment and try again.',
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: 'internal',
      message: 'Something went wrong on our end.',
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: 'not_found', message: 'No such route.' }),
  );

  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerAppRoutes(app);
  await registerProfileRoutes(app);
  await registerJobSearchRoutes(app);

  // Close the pool with the server, but only if we created it - a pool passed
  // in by a test is that test's to manage.
  if (!options.pool) {
    app.addHook('onClose', async () => {
      await pool.end();
    });
  }

  return app;
}
