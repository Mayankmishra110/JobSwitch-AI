import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/**
 * Migration runner.
 *
 * Plain SQL files, applied in filename order, recorded with a checksum. No ORM
 * and no migration framework: this schema's load-bearing parts are roles,
 * grants and RLS policies, and every ORM migration tool I know of either
 * cannot express those or fights you while you do.
 *
 * Each file runs inside its own transaction, so a failure leaves the database
 * on the last complete migration rather than half-applied.
 */

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export interface MigrationRecord {
  name: string;
  checksum: string;
  appliedAt: Date;
}

function checksum(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

async function ensureTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
  // The web role must be able to read this for its readiness check, but has no
  // DDL rights - so the grant is issued here, by the migration role, rather
  // than attempted at read time.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_web') THEN
        GRANT SELECT ON schema_migration TO app_web;
      END IF;
    END
    $$;
  `);
}

async function readMigrationFiles(): Promise<
  Array<{ name: string; sql: string }>
> {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATIONS_DIR, name), 'utf8'),
    })),
  );
}

export async function applied(pool: Pool): Promise<MigrationRecord[]> {
  await ensureTable(pool);
  const { rows } = await pool.query<{
    name: string;
    checksum: string;
    applied_at: Date;
  }>('SELECT name, checksum, applied_at FROM schema_migration ORDER BY name');
  return rows.map((r) => ({
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at,
  }));
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

export async function migrate(pool: Pool): Promise<MigrateResult> {
  await ensureTable(pool);

  const files = await readMigrationFiles();
  const done = new Map(
    (await applied(pool)).map((r) => [r.name, r.checksum] as const),
  );

  // A changed checksum means an already-applied file was edited. Silently
  // ignoring that produces environments whose schemas differ while both claim
  // to be up to date - the kind of drift that is discovered in production.
  for (const file of files) {
    const previous = done.get(file.name);
    if (previous !== undefined && previous !== checksum(file.sql)) {
      throw new Error(
        `Migration ${file.name} has changed since it was applied. ` +
          `Add a new migration instead of editing an applied one.`,
      );
    }
  }

  const pending = files.filter((f) => !done.has(f.name));
  const appliedNow: string[] = [];

  for (const file of pending) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(file.sql);
      await client.query(
        'INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)',
        [file.name, checksum(file.sql)],
      );
      await client.query('COMMIT');
      appliedNow.push(file.name);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${file.name} failed: ${String(error)}`, {
        cause: error,
      });
    } finally {
      client.release();
    }
  }

  return { applied: appliedNow, alreadyApplied: done.size };
}

export async function pendingMigrations(pool: Pool): Promise<string[]> {
  await ensureTable(pool);
  const files = await readMigrationFiles();
  const done = new Set((await applied(pool)).map((r) => r.name));
  return files.filter((f) => !done.has(f.name)).map((f) => f.name);
}

/**
 * Read-only pending check, for the readiness endpoint.
 *
 * Never issues DDL: the web role deliberately has no such rights, so the
 * writing variant above would make /readyz report the database as unavailable
 * on a perfectly healthy deployment. A missing schema_migration table means no
 * migration has ever run, which is reported as "everything is pending" rather
 * than as an error.
 */
export async function pendingMigrationsReadOnly(
  pool: Pool,
): Promise<string[]> {
  const files = await readMigrationFiles();

  let done: Set<string>;
  try {
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM schema_migration',
    );
    done = new Set(rows.map((r) => r.name));
  } catch (error) {
    // 42P01 = undefined_table.
    if ((error as { code?: string }).code === '42P01') {
      return files.map((f) => f.name);
    }
    throw error;
  }

  return files.filter((f) => !done.has(f.name)).map((f) => f.name);
}
