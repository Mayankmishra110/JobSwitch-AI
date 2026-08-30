/**
 * Probe every seeded board token and report which resolve.
 *
 *   pnpm --filter @jobswitch/db seed:verify
 *
 * Requires outbound network access. Sources whose token 404s are disabled, so
 * the scheduler stops enqueueing work that cannot succeed - a wrong token is
 * not a transient failure and retrying it nightly forever is pure waste.
 */
import { createPool } from '../pool.js';

const url = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL_MIGRATE or DATABASE_URL must be set.');
  process.exit(1);
}

const pool = createPool({ connectionString: url, max: 2 });
const disable = process.argv.includes('--disable-failures');

const { rows } = await pool.query<{
  id: string; name: string; ats_type: string; board_identifier: string;
}>(
  `SELECT s.id, c.name, s.ats_type, s.board_identifier
   FROM career_source s JOIN company c ON c.id = s.company_id
   WHERE s.status <> 'disabled'
   ORDER BY c.name`,
);

let ok = 0;
const failed: Array<{ id: string; name: string; token: string; status: number }> = [];

for (const row of rows) {
  if (row.ats_type !== 'greenhouse') continue;
  const probe = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(row.board_identifier)}/jobs`;
  try {
    const res = await fetch(probe, { headers: { accept: 'application/json' } });
    if (res.ok) {
      const body = (await res.json()) as { jobs?: unknown[] };
      console.log(`  OK    ${row.name.padEnd(16)} ${row.board_identifier.padEnd(18)} ${body.jobs?.length ?? 0} postings`);
      ok += 1;
    } else {
      console.log(`  FAIL  ${row.name.padEnd(16)} ${row.board_identifier.padEnd(18)} HTTP ${res.status}`);
      failed.push({ id: row.id, name: row.name, token: row.board_identifier, status: res.status });
    }
  } catch (error) {
    console.log(`  ERROR ${row.name.padEnd(16)} ${row.board_identifier.padEnd(18)} ${String(error)}`);
    failed.push({ id: row.id, name: row.name, token: row.board_identifier, status: 0 });
  }
  // Be a good citizen: one request at a time, with a pause.
  await new Promise((r) => setTimeout(r, 300));
}

console.log(`\n${ok} verified, ${failed.length} failed.`);

if (failed.length > 0 && disable) {
  await pool.query(
    `UPDATE career_source SET status = 'disabled', updated_at = now()
     WHERE id = ANY($1::uuid[])`,
    [failed.map((f) => f.id)],
  );
  console.log(`Disabled ${failed.length} sources with unresolvable tokens.`);
} else if (failed.length > 0) {
  console.log('Re-run with --disable-failures to disable them.');
}

await pool.end();
