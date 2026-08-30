/**
 * Migration CLI.
 *
 *   pnpm migrate            apply pending migrations
 *   pnpm migrate:status     list applied and pending
 *
 * Connects with DATABASE_URL_MIGRATE if set, otherwise DATABASE_URL. In
 * production these differ: migrations need DDL rights that the running
 * application must not have.
 */
import { createPool } from '../pool.js';
import { applied, migrate, pendingMigrations } from '../migrate.js';

const url = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL_MIGRATE or DATABASE_URL must be set.');
  process.exit(1);
}

const command = process.argv[2] ?? 'up';
const pool = createPool({ connectionString: url, max: 2, applicationName: 'jobswitch-migrate' });

try {
  if (command === 'status') {
    const done = await applied(pool);
    const pending = await pendingMigrations(pool);
    console.log(`Applied (${done.length}):`);
    for (const m of done) console.log(`  ${m.name}  ${m.appliedAt.toISOString()}`);
    console.log(`Pending (${pending.length}):`);
    for (const name of pending) console.log(`  ${name}`);
  } else if (command === 'up') {
    const result = await migrate(pool);
    if (result.applied.length === 0) {
      console.log(`Up to date (${result.alreadyApplied} migrations applied).`);
    } else {
      for (const name of result.applied) console.log(`Applied ${name}`);
    }
  } else {
    console.error(`Unknown command: ${command}. Use "up" or "status".`);
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  await pool.end();
}
