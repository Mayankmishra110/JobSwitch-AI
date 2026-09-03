import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AccountId, type ExperienceInput } from '@jobswitch/core';
import { createPool } from '../src/pool.js';
import { migrate } from '../src/migrate.js';
import { withAccount, withoutTenantContext } from '../src/context.js';
import * as identityRepo from '../src/repositories/identity.js';
import * as profileRepo from '../src/repositories/profile.js';

/**
 * Personal profile tests - RLS isolation plus repository behaviour (Phase 4).
 *
 * Same two-pool discipline as rls.test.ts: an owner pool that bypasses RLS,
 * used only for setup and for verifying what is really in the table, and a
 * webPool connected as app_web, which is the role RLS actually applies to.
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

  await ownerPool.query('DELETE FROM profile_experience');
  await ownerPool.query('DELETE FROM profile_skill');
  await ownerPool.query('DELETE FROM candidate_profile');
  await ownerPool.query('DELETE FROM account_member');
  await ownerPool.query('DELETE FROM app_user');
  await ownerPool.query('DELETE FROM account');

  const created = await withoutTenantContext(ownerPool, async (tx) => {
    const a = await identityRepo.createUserWithAccount(tx, {
      email: 'profile-a@example.com',
      fullName: 'Tenant A',
    });
    const b = await identityRepo.createUserWithAccount(tx, {
      email: 'profile-b@example.com',
      fullName: 'Tenant B',
    });
    return { a, b };
  });

  accountA = created.a.accountId;
  accountB = created.b.accountId;
});

afterAll(async () => {
  await webPool?.end();
  await ownerPool?.end();
});

describe('candidate_profile row-level security', () => {
  it('a tenant can create and read only its own profile', async () => {
    await withAccount(webPool, accountA, (tx) =>
      profileRepo.upsertProfile(tx, accountA, { headline: 'Tenant A headline' }),
    );
    await withAccount(webPool, accountB, (tx) =>
      profileRepo.upsertProfile(tx, accountB, { headline: 'Tenant B headline' }),
    );

    const { rows } = await ownerPool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM candidate_profile',
    );
    expect(rows[0]?.count).toBe(2);

    const seenByA = await withAccount(webPool, accountA, (tx) => profileRepo.getProfile(tx, accountA));
    const seenByB = await withAccount(webPool, accountB, (tx) => profileRepo.getProfile(tx, accountB));

    expect(seenByA?.headline).toBe('Tenant A headline');
    expect(seenByB?.headline).toBe('Tenant B headline');
  });

  it('an unfiltered query returns nothing without a tenant context', async () => {
    const row = await withoutTenantContext(webPool, (tx) => profileRepo.getProfile(tx, accountA));
    expect(row).toBeNull();
  });

  it('a raw unscoped SELECT is also empty for app_web', async () => {
    const { rows } = await webPool.query('SELECT account_id FROM candidate_profile');
    expect(rows).toHaveLength(0);
  });

  it('a tenant cannot write a profile attributed to another tenant', async () => {
    await expect(
      withAccount(webPool, accountA, (tx) =>
        tx.query(
          `INSERT INTO candidate_profile (account_id, headline) VALUES ($1, 'forged')`,
          [accountB],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a tenant cannot update another tenant\'s profile via a raw statement', async () => {
    await expect(
      withAccount(webPool, accountA, (tx) =>
        tx.query(`UPDATE candidate_profile SET headline = 'tampered' WHERE account_id = $1`, [
          accountB,
        ]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 }); // USING hides the row rather than erroring

    const untouched = await withAccount(webPool, accountB, (tx) => profileRepo.getProfile(tx, accountB));
    expect(untouched?.headline).toBe('Tenant B headline');
  });
});

describe('profile_skill and profile_experience row-level security', () => {
  it('a tenant sees only its own skills', async () => {
    await withAccount(webPool, accountA, (tx) => profileRepo.replaceSkills(tx, accountA, ['Go', 'SQL']));
    await withAccount(webPool, accountB, (tx) => profileRepo.replaceSkills(tx, accountB, ['Rust']));

    const skillsA = await withAccount(webPool, accountA, (tx) => profileRepo.listSkills(tx, accountA));
    const skillsB = await withAccount(webPool, accountB, (tx) => profileRepo.listSkills(tx, accountB));

    expect(skillsA.map((s) => s.skill)).toEqual(['Go', 'SQL']);
    expect(skillsB.map((s) => s.skill)).toEqual(['Rust']);
  });

  it('a tenant cannot insert a skill attributed to another tenant', async () => {
    await expect(
      withAccount(webPool, accountA, (tx) =>
        tx.query(`INSERT INTO profile_skill (account_id, skill) VALUES ($1, 'forged')`, [accountB]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a tenant sees only its own experience entries and cannot touch another\'s', async () => {
    const entryA = await withAccount(webPool, accountA, (tx) =>
      profileRepo.addExperience(tx, accountA, {
        company: 'Acme',
        title: 'Engineer',
        startDate: '2020-01-01',
        isCurrent: false,
        endDate: '2022-01-01',
      }),
    );

    const listedByB = await withAccount(webPool, accountB, (tx) =>
      profileRepo.getExperienceById(tx, accountB, entryA.id),
    );
    expect(listedByB).toBeNull();

    // A cross-tenant delete affects zero rows rather than the other tenant's row.
    const deleted = await withAccount(webPool, accountB, (tx) =>
      profileRepo.deleteExperience(tx, accountB, entryA.id),
    );
    expect(deleted).toBe(false);

    const stillThere = await withAccount(webPool, accountA, (tx) =>
      profileRepo.getExperienceById(tx, accountA, entryA.id),
    );
    expect(stillThere).not.toBeNull();
  });
});

describe('profile repository behaviour', () => {
  it('upsertProfile preserves fields omitted from a later call', async () => {
    await withAccount(webPool, accountA, (tx) =>
      profileRepo.upsertProfile(tx, accountA, {
        headline: 'Senior Engineer',
        currentTitle: 'Backend Engineer',
        desiredLocations: ['Bengaluru', 'Remote'],
      }),
    );

    const updated = await withAccount(webPool, accountA, (tx) =>
      profileRepo.upsertProfile(tx, accountA, { headline: 'Staff Engineer' }),
    );

    expect(updated.headline).toBe('Staff Engineer');
    expect(updated.currentTitle).toBe('Backend Engineer');
    expect(updated.desiredLocations).toEqual(['Bengaluru', 'Remote']);
  });

  it('setResume updates only the resume fields', async () => {
    await withAccount(webPool, accountA, (tx) =>
      profileRepo.upsertProfile(tx, accountA, { headline: 'Keep me' }),
    );

    const withResume = await withAccount(webPool, accountA, (tx) =>
      profileRepo.setResume(tx, accountA, { filename: 'resume.pdf', text: 'Experienced engineer.' }),
    );

    expect(withResume.resumeFilename).toBe('resume.pdf');
    expect(withResume.resumeText).toBe('Experienced engineer.');
    expect(withResume.resumeUploadedAt).not.toBeNull();
    expect(withResume.headline).toBe('Keep me');
  });

  it('replaceSkills de-duplicates case-insensitively, keeping the first spelling', async () => {
    const skills = await withAccount(webPool, accountA, (tx) =>
      profileRepo.replaceSkills(tx, accountA, ['React', 'react', 'TypeScript']),
    );
    expect(skills.map((s) => s.skill).sort()).toEqual(['React', 'TypeScript']);
  });

  it('replaceSkills with an empty array clears the list', async () => {
    await withAccount(webPool, accountA, (tx) => profileRepo.replaceSkills(tx, accountA, ['Go']));
    const cleared = await withAccount(webPool, accountA, (tx) => profileRepo.replaceSkills(tx, accountA, []));
    expect(cleared).toEqual([]);
    const listed = await withAccount(webPool, accountA, (tx) => profileRepo.listSkills(tx, accountA));
    expect(listed).toEqual([]);
  });

  it('lists experience with current roles first, then most recent start date', async () => {
    await ownerPool.query('DELETE FROM profile_experience WHERE account_id = $1', [accountA]);

    await withAccount(webPool, accountA, (tx) =>
      profileRepo.addExperience(tx, accountA, {
        company: 'Old Co',
        title: 'Junior Engineer',
        startDate: '2018-01-01',
        endDate: '2020-01-01',
        isCurrent: false,
      }),
    );
    await withAccount(webPool, accountA, (tx) =>
      profileRepo.addExperience(tx, accountA, {
        company: 'New Co',
        title: 'Staff Engineer',
        startDate: '2023-01-01',
        isCurrent: true,
      }),
    );
    await withAccount(webPool, accountA, (tx) =>
      profileRepo.addExperience(tx, accountA, {
        company: 'Mid Co',
        title: 'Senior Engineer',
        startDate: '2020-01-01',
        endDate: '2023-01-01',
        isCurrent: false,
      }),
    );

    const list = await withAccount(webPool, accountA, (tx) => profileRepo.listExperience(tx, accountA));
    expect(list.map((e) => e.company)).toEqual(['New Co', 'Mid Co', 'Old Co']);
  });

  it('updateExperience overwrites the targeted row only', async () => {
    const entry = await withAccount(webPool, accountA, (tx) =>
      profileRepo.addExperience(tx, accountA, {
        company: 'Acme',
        title: 'Engineer',
        startDate: '2021-01-01',
        isCurrent: true,
      }),
    );

    const updated = await withAccount(webPool, accountA, (tx) =>
      profileRepo.updateExperience(tx, accountA, entry.id, {
        company: 'Acme Corp',
        title: 'Senior Engineer',
        startDate: '2021-01-01',
        isCurrent: true,
      }),
    );

    expect(updated?.company).toBe('Acme Corp');
    expect(updated?.title).toBe('Senior Engineer');
  });

  it('updateExperience returns null for an id that does not exist under this account', async () => {
    const result = await withAccount(webPool, accountA, (tx) =>
      profileRepo.updateExperience(tx, accountA, '00000000-0000-4000-8000-000000000000', {
        company: 'Nope',
        title: 'Nope',
        startDate: '2021-01-01',
        isCurrent: true,
      }),
    );
    expect(result).toBeNull();
  });

  it('rejects an experience row that is both current and has an end date, even bypassing input validation', async () => {
    // Defense in depth: the CHECK constraint must hold even if a caller
    // skipped experienceInput's own refinement somehow.
    const invalid: ExperienceInput = {
      company: 'Acme',
      title: 'Engineer',
      startDate: '2021-01-01',
      endDate: '2022-01-01',
      isCurrent: true,
    };
    await expect(
      withAccount(webPool, accountA, (tx) => profileRepo.addExperience(tx, accountA, invalid)),
    ).rejects.toThrow();
  });

  it('rejects an experience row whose end date precedes its start date', async () => {
    const invalid: ExperienceInput = {
      company: 'Acme',
      title: 'Engineer',
      startDate: '2022-01-01',
      endDate: '2021-01-01',
      isCurrent: false,
    };
    await expect(
      withAccount(webPool, accountA, (tx) => profileRepo.addExperience(tx, accountA, invalid)),
    ).rejects.toThrow();
  });
});
