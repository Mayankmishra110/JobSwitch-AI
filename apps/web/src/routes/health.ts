import type { FastifyInstance } from 'fastify';
import { pendingMigrationsReadOnly } from '@jobswitch/db';

/**
 * Health endpoints.
 *
 * /healthz  - liveness. Is the process up? No dependencies touched, so a
 *             database blip does not cause the orchestrator to kill a
 *             perfectly healthy process.
 * /readyz   - readiness. Can it actually serve? Checks the database and
 *             reports pending migrations, which is the usual reason a fresh
 *             deploy is up but wrong.
 */
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const { pool } = app.authDeps;
    try {
      await pool.query('SELECT 1');
      const pending = await pendingMigrationsReadOnly(pool);
      if (pending.length > 0) {
        return reply.status(503).send({
          status: 'degraded',
          database: 'ok',
          pendingMigrations: pending,
        });
      }
      return reply.send({ status: 'ok', database: 'ok', pendingMigrations: [] });
    } catch (error) {
      app.log.error({ err: error }, 'readiness check failed');
      return reply.status(503).send({ status: 'unavailable', database: 'error' });
    }
  });
}
