/**
 * Process entrypoint.
 *
 * Migrations are NOT run here. A web process that migrates on boot races every
 * other instance during a rolling deploy, and needs DDL rights it should not
 * have. Migration is a deploy step (see docs/DEPLOYMENT.md); /readyz reports
 * when the schema is behind.
 */
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const app = await buildServer({ config });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
