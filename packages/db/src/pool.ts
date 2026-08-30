import pg from 'pg';

const { Pool } = pg;

/**
 * Postgres connection pools.
 *
 * `pg` returns DATE, TIMESTAMP and TIMESTAMPTZ as strings under some
 * configurations and as Dates under others. Pin the parsers so the repository
 * layer has one contract rather than a per-driver-version surprise.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export interface PoolConfig {
  connectionString: string;
  /** Small by default: a solo VPS does not need 50 idle connections. */
  max?: number;
  applicationName?: string;
  ssl?: boolean;
}

export function createPool(config: PoolConfig): pg.Pool {
  return new Pool({
    connectionString: config.connectionString,
    max: config.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: config.applicationName ?? 'jobswitch',
    ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });
}

export type { Pool, PoolClient } from 'pg';
