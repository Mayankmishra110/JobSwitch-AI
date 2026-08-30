import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Pool } from '../src/pool.js';
import { migrate, pendingMigrationsReadOnly } from '../src/migrate.js';

/**
 * Regression: the readiness endpoint runs as app_web, which has no DDL rights.
 * The writing pending-check issued CREATE TABLE IF NOT EXISTS and therefore
 * made /readyz report a healthy database as unavailable.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_TEST ??
  'postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test';
const WEB_URL =
  process.env.DATABASE_URL_TEST_WEB ??
  'postgres://app_web_test:webpassword@127.0.0.1:5432/jobswitch_test';

let ownerPool: Pool;
let webPool: Pool;

beforeAll(async () => {
  ownerPool = createPool({ connectionString: ADMIN_URL, max: 2 });
  await migrate(ownerPool);
  await ownerPool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_web_test') THEN
        CREATE ROLE app_web_test LOGIN PASSWORD 'webpassword';
      END IF;
    END
    $$;
  `);
  await ownerPool.query('GRANT app_web TO app_web_test');
  webPool = createPool({ connectionString: WEB_URL, max: 2 });
});

afterAll(async () => {
  await webPool?.end();
  await ownerPool?.end();
});

describe('migration status', () => {
  it('is readable by app_web without DDL rights', async () => {
    const pending = await pendingMigrationsReadOnly(webPool);
    expect(pending).toEqual([]);
  });

  it('confirms app_web genuinely cannot issue DDL', async () => {
    // Proves the test above is meaningful rather than accidentally passing
    // because the role is over-privileged.
    await expect(
      webPool.query('CREATE TABLE should_not_be_allowed (id int)'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('is idempotent', async () => {
    const result = await migrate(ownerPool);
    expect(result.applied).toEqual([]);
  });
});
