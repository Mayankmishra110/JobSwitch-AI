/**
 * Seed the company index.
 *
 *   pnpm --filter @jobswitch/db seed
 *
 * Idempotent: re-running updates existing rows rather than duplicating them,
 * so it is safe to run on every deploy while the list is still being curated.
 */
import { createPool } from '../pool.js';
import { withoutTenantContext } from '../context.js';
import { SEED_COMPANIES, normalizeDomain } from '../seed/companies.js';

const url = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL_MIGRATE or DATABASE_URL must be set.');
  process.exit(1);
}

const pool = createPool({ connectionString: url, max: 2, applicationName: 'jobswitch-seed' });

try {
  const result = await withoutTenantContext(pool, async (tx) => {
    let companies = 0;
    let sources = 0;

    for (const c of SEED_COMPANIES) {
      const domain = normalizeDomain(c.domain);

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO company (name, normalized_domain, website, cadence_tier)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (normalized_domain)
         DO UPDATE SET name = EXCLUDED.name,
                       website = EXCLUDED.website,
                       cadence_tier = EXCLUDED.cadence_tier,
                       updated_at = now()
         RETURNING id`,
        [c.name, domain, c.website, c.cadenceTier ?? 'standard'],
      );
      const companyId = rows[0]?.id;
      if (!companyId) throw new Error(`company upsert failed for ${c.name}`);
      companies += 1;

      const inserted = await tx.query(
        `INSERT INTO career_source (company_id, ats_type, board_identifier)
         VALUES ($1, $2, $3)
         ON CONFLICT (ats_type, board_identifier) DO NOTHING`,
        [companyId, c.atsType, c.boardIdentifier],
      );
      sources += inserted.rowCount ?? 0;
    }

    return { companies, sources };
  });

  console.log(
    `Seeded ${result.companies} companies, ${result.sources} new career sources.`,
  );
  console.log(
    '\nNOTE: board tokens are unverified guesses. Run seed:verify on a machine\n' +
      'with network access to find the ones that 404.',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  await pool.end();
}
