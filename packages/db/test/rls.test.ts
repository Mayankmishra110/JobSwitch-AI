import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AccountId } from '@jobswitch/core';
import { createPool } from '../src/pool.js';
import { migrate } from '../src/migrate.js';
import { withAccount, withoutTenantContext } from '../src/context.js';
import * as identityRepo from '../src/repositories/identity.js';
import * as auditRepo from '../src/repositories/audit.js';

/**
 * Tenant isolation tests (ADR D-14).
 *
 * These are the highest-value tests in the repository. Everything else here
 * can be wrong and produce a bug; this being wrong produces one user reading
 * another user's job search.
 *
 * Two pools deliberately:
 *   ownerPool - the migration/owner role, which bypasses RLS by design and is
 *               used to set up and to verify what is really in the table;
 *   webPool   - connects as app_web, the role the request path actually uses,
 *               and is therefore the role RLS applies to.
 *
 * Testing only through the owner pool would pass while proving nothing.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_TEST ??
  'postgres://jobswitch:devpassword@127.0.0.1:5432/jobswitch_test';

const WEB_URL =
  process.env.DATABASE_URL_TEST_WEB ??
  'postgres://app_web_test:webpassword@127.0.0.1:5432/jobswitch_test';

let ownerPool: Pool;
let webPool: Pool;
let accountA: AccountId;
let accountB: AccountId;

beforeAll(async () => {
  ownerPool = createPool({ connectionString: ADMIN_URL, max: 4 });
  await migrate(ownerPool);

  // A real login role that is a member of app_web. Production grants app_web
  // to the deployed application user in exactly this way.
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

  webPool = createPool({ connectionString: WEB_URL, max: 4 });

  await ownerPool.query('DELETE FROM audit_log');
  await ownerPool.query('DELETE FROM account_member');
  await ownerPool.query('DELETE FROM app_user');
  await ownerPool.query('DELETE FROM account');

  const created = await withoutTenantContext(ownerPool, async (tx) => {
    const a = await identityRepo.createUserWithAccount(tx, {
      email: 'alice@example.com',
      fullName: 'Alice',
    });
    const b = await identityRepo.createUserWithAccount(tx, {
      email: 'bob@example.com',
      fullName: 'Bob',
    });
    return { a, b };
  });

  accountA = created.a.accountId;
  accountB = created.b.accountId;

  // One audit row in each tenant, written through the RLS-bound role.
  await withAccount(webPool, accountA, (tx) =>
    auditRepo.writeAuditEntry(tx, {
      accountId: accountA,
      actorUserId: created.a.user.id,
      action: 'user.signed_up',
      metadata: { tenant: 'A' },
    }),
  );
  await withAccount(webPool, accountB, (tx) =>
    auditRepo.writeAuditEntry(tx, {
      accountId: accountB,
      actorUserId: created.b.user.id,
      action: 'user.signed_up',
      metadata: { tenant: 'B' },
    }),
  );
});

afterAll(async () => {
  await webPool?.end();
  await ownerPool?.end();
});

describe('row-level security', () => {
  it('both rows really exist in the table', async () => {
    // Sanity check via the owner role, which bypasses RLS. Without this, a
    // policy that hides everything from everyone would pass every test below.
    const { rows } = await ownerPool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM audit_log',
    );
    expect(rows[0]?.count).toBe(2);
  });

  it('a tenant sees only its own rows', async () => {
    const seenByA = await withAccount(webPool, accountA, (tx) =>
      auditRepo.listAuditEntries(tx),
    );
    const seenByB = await withAccount(webPool, accountB, (tx) =>
      auditRepo.listAuditEntries(tx),
    );

    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(1);
    expect(seenByA[0]?.accountId).toBe(accountA);
    expect(seenByB[0]?.accountId).toBe(accountB);
    expect(seenByA[0]?.metadata).toEqual({ tenant: 'A' });
  });

  it('an unfiltered query returns nothing without a tenant context', async () => {
    // The core safety property: a forgotten WHERE clause returns zero rows
    // rather than every tenant's rows.
    const rows = await withoutTenantContext(webPool, (tx) =>
      auditRepo.listAuditEntries(tx),
    );
    expect(rows).toHaveLength(0);
  });

  it('a raw unscoped SELECT is also empty for app_web', async () => {
    // Not going through the repository, in case the repository itself were
    // ever to add a filter and mask a broken policy.
    const { rows } = await webPool.query('SELECT id FROM audit_log');
    expect(rows).toHaveLength(0);
  });

  it('a tenant cannot insert a row attributed to another tenant', async () => {
    // The WITH CHECK half of the policy. Without it, reads would be isolated
    // while writes were not.
    await expect(
      withAccount(webPool, accountA, (tx) =>
        auditRepo.writeAuditEntry(tx, {
          accountId: accountB,
          actorUserId: null,
          action: 'user.signed_in',
          metadata: { forged: true },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('the tenant context does not leak between pooled connections', async () => {
    // SET LOCAL is transaction-scoped, so the context must be gone by the time
    // this connection is handed to the next caller. A plain SET would leak here
    // and hand one user another user's tenant.
    await withAccount(webPool, accountA, async (tx) => {
      const { rows } = await tx.query<{ v: string | null }>(
        `SELECT current_setting('app.current_account_id', true) AS v`,
      );
      expect(rows[0]?.v).toBe(accountA);
    });

    for (let i = 0; i < 5; i += 1) {
      const { rows } = await webPool.query<{ v: string | null }>(
        `SELECT current_setting('app.current_account_id', true) AS v`,
      );
      expect(rows[0]?.v ?? '').toBe('');
    }
  });

  it('the tenant context is released even when the callback throws', async () => {
    await expect(
      withAccount(webPool, accountA, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const { rows } = await webPool.query<{ v: string | null }>(
      `SELECT current_setting('app.current_account_id', true) AS v`,
    );
    expect(rows[0]?.v ?? '').toBe('');
  });

  it('audit_log is append-only for app_web', async () => {
    // No UPDATE or DELETE policy exists, so both must fail regardless of the
    // tenant context.
    await expect(
      withAccount(webPool, accountA, (tx) =>
        tx.query(`UPDATE audit_log SET action = 'tampered'`),
      ),
    ).rejects.toThrow();

    await expect(
      withAccount(webPool, accountA, (tx) => tx.query('DELETE FROM audit_log')),
    ).rejects.toThrow();
  });
});

describe('worker role isolation', () => {
  it('app_ingest has no access to tenant tables at all', async () => {
    // ADR D-14's highest-value property. Ingestion adapters process untrusted
    // third-party content; a compromised adapter must not reach user data.
    await ownerPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ingest_test') THEN
          CREATE ROLE app_ingest_test LOGIN PASSWORD 'ingestpassword';
        END IF;
      END
      $$;
    `);
    await ownerPool.query('GRANT app_ingest TO app_ingest_test');

    const ingestPool = createPool({
      connectionString:
        'postgres://app_ingest_test:ingestpassword@127.0.0.1:5432/jobswitch_test',
      max: 1,
    });

    try {
      await expect(ingestPool.query('SELECT * FROM audit_log')).rejects.toThrow(
        /permission denied/i,
      );
      await expect(ingestPool.query('SELECT * FROM app_user')).rejects.toThrow(
        /permission denied/i,
      );
      await expect(
        ingestPool.query('SELECT * FROM user_credential'),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        ingestPool.query('SELECT * FROM user_session'),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await ingestPool.end();
    }
  });
});
