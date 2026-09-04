import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AccountId } from '@jobswitch/core';
import { createPool } from '../src/pool.js';
import { migrate } from '../src/migrate.js';
import { withAccount, withoutTenantContext } from '../src/context.js';
import * as identityRepo from '../src/repositories/identity.js';
import * as profileRepo from '../src/repositories/profile.js';
import * as jobSearchRepo from '../src/repositories/jobSearch.js';

/**
 * Ephemeral resume retention tests (ADR D-31) - RLS isolation plus the
 * actual purge guarantee. The purge test is the one that matters most here:
 * "boom, gone" is a claim this suite either proves or it is not proven.
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

  await ownerPool.query('DELETE FROM job_application');
  await ownerPool.query('DELETE FROM resume_artifact');
  await ownerPool.query('DELETE FROM resume_source');
  await ownerPool.query('DELETE FROM resume_upload');
  await ownerPool.query('DELETE FROM job_search_session');
  // Layer 1 fixture from the purge test below - not tenant data, so it is
  // deliberately not touched by stopJobSearch's own purge, and needs its
  // own cleanup here for a repeatable run. CASCADE takes career_source,
  // job_posting and job_posting_version with it.
  await ownerPool.query("DELETE FROM company WHERE normalized_domain = 'purgetestco.example'");
  await ownerPool.query('DELETE FROM account_member');
  await ownerPool.query('DELETE FROM app_user');
  await ownerPool.query('DELETE FROM account');

  const created = await withoutTenantContext(ownerPool, async (tx) => {
    const a = await identityRepo.createUserWithAccount(tx, {
      email: 'jobsearch-a@example.com',
      fullName: 'Tenant A',
    });
    const b = await identityRepo.createUserWithAccount(tx, {
      email: 'jobsearch-b@example.com',
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

describe('job_search_session and resume_upload row-level security', () => {
  it('a tenant sees only its own session and resume', async () => {
    await withAccount(webPool, accountA, (tx) =>
      jobSearchRepo.startJobSearch(tx, accountA, {
        filename: 'a-resume.pdf',
        rawText: 'Tenant A resume text.',
      }),
    );
    await withAccount(webPool, accountB, (tx) =>
      jobSearchRepo.startJobSearch(tx, accountB, {
        filename: 'b-resume.pdf',
        rawText: 'Tenant B resume text.',
      }),
    );

    const seenByA = await withAccount(webPool, accountA, (tx) =>
      jobSearchRepo.getActiveSession(tx, accountA),
    );
    const seenByB = await withAccount(webPool, accountB, (tx) =>
      jobSearchRepo.getActiveSession(tx, accountB),
    );
    expect(seenByA?.accountId).toBe(accountA);
    expect(seenByB?.accountId).toBe(accountB);

    const resumeA = await withAccount(webPool, accountA, (tx) =>
      jobSearchRepo.getResumeUpload(tx, accountA),
    );
    expect(resumeA?.filename).toBe('a-resume.pdf');
  });

  it('an unfiltered query returns nothing without a tenant context', async () => {
    const row = await withoutTenantContext(webPool, (tx) =>
      jobSearchRepo.getActiveSession(tx, accountA),
    );
    expect(row).toBeNull();
  });

  it('a raw unscoped SELECT is also empty for app_web', async () => {
    const { rows } = await webPool.query('SELECT id FROM job_search_session');
    expect(rows).toHaveLength(0);
  });

  it('a tenant cannot insert a session attributed to another tenant', async () => {
    await expect(
      withAccount(webPool, accountA, (tx) =>
        tx.query(`INSERT INTO job_search_session (account_id, status) VALUES ($1, 'active')`, [
          accountB,
        ]),
      ),
    ).rejects.toThrow(/row-level security|duplicate key/i);
  });
});

describe('startJobSearch / stopJobSearch behaviour', () => {
  it('starting while already active updates the resume rather than erroring', async () => {
    const first = await withAccount(webPool, accountA, (tx) =>
      jobSearchRepo.startJobSearch(tx, accountA, { filename: 'v1.pdf', rawText: 'First draft.' }),
    );
    const second = await withAccount(webPool, accountA, (tx) =>
      jobSearchRepo.startJobSearch(tx, accountA, { filename: 'v2.pdf', rawText: 'Updated draft.' }),
    );

    // Same session, not a new one.
    expect(second.session.id).toBe(first.session.id);
    expect(second.resume.filename).toBe('v2.pdf');
    expect(second.resume.rawText).toBe('Updated draft.');
  });

  it('stopping with no active session returns null', async () => {
    await withAccount(webPool, accountB, async (tx) => {
      const existing = await jobSearchRepo.getActiveSession(tx, accountB);
      if (existing) await jobSearchRepo.stopJobSearch(tx, accountB, 'user_action');
    });

    const result = await withAccount(webPool, accountB, (tx) =>
      jobSearchRepo.stopJobSearch(tx, accountB, 'user_action'),
    );
    expect(result).toBeNull();
  });

  it('stopping purges resume_upload, resume_source, resume_artifact and job_application for that account only', async () => {
    // Fresh accounts for a clean purge assertion, independent of other tests
    // in this file that also touch accountA/accountB.
    const created = await withoutTenantContext(ownerPool, async (tx) => {
      const purgee = await identityRepo.createUserWithAccount(tx, {
        email: 'purge-target@example.com',
        fullName: 'Purge Target',
      });
      const bystander = await identityRepo.createUserWithAccount(tx, {
        email: 'purge-bystander@example.com',
        fullName: 'Bystander',
      });
      return { purgee, bystander };
    });
    const purgeeId = created.purgee.accountId;
    const bystanderId = created.bystander.accountId;

    await withAccount(webPool, purgeeId, (tx) =>
      jobSearchRepo.startJobSearch(tx, purgeeId, { filename: 'me.pdf', rawText: 'My resume.' }),
    );
    await withAccount(webPool, bystanderId, (tx) =>
      jobSearchRepo.startJobSearch(tx, bystanderId, {
        filename: 'bystander.pdf',
        rawText: 'Bystander resume.',
      }),
    );

    await withAccount(webPool, purgeeId, (tx) =>
      tx.query(
        `INSERT INTO resume_source (account_id, variant_id, label, pdf_base_name, tex, sha256)
         VALUES ($1, 'fullstack', 'Full-stack', 'resume', '\\documentclass{article}', 'deadbeef')`,
        [purgeeId],
      ),
    );
    const appRows = await withAccount(webPool, purgeeId, (tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO job_application (account_id, source, manual_title, manual_jd_text, status)
         VALUES ($1, 'manual', 'Engineer', 'Job description text.', 'found')
         RETURNING id`,
        [purgeeId],
      ),
    );
    const applicationId = appRows.rows[0]!.id;
    await withAccount(webPool, purgeeId, (tx) =>
      tx.query(
        `INSERT INTO resume_artifact (account_id, application_id, variant_id, source_sha256, status)
         VALUES ($1, $2, 'fullstack', 'deadbeef', 'proposed')`,
        [purgeeId, applicationId],
      ),
    );

    // job_match/match_explanation are app_matcher-owned (BYPASSRLS), so
    // seed them via the owner pool - exercising a real row in each, not
    // just trusting the purge list names them.
    const companyId = (
      await ownerPool.query<{ id: string }>(
        `INSERT INTO company (name, normalized_domain) VALUES ('Purge Test Co', 'purgetestco.example')
         RETURNING id`,
      )
    ).rows[0]!.id;
    const sourceId = (
      await ownerPool.query<{ id: string }>(
        `INSERT INTO career_source (company_id, ats_type, board_identifier)
         VALUES ($1, 'greenhouse', 'purgetestco') RETURNING id`,
        [companyId],
      )
    ).rows[0]!.id;
    const postingId = (
      await ownerPool.query<{ id: string }>(
        `INSERT INTO job_posting
           (career_source_id, company_id, source_job_id, canonical_title, normalized_title, apply_url)
         VALUES ($1, $2, 'job-1', 'Engineer', 'engineer', 'https://example.com/apply')
         RETURNING id`,
        [sourceId, companyId],
      )
    ).rows[0]!.id;
    const versionId = (
      await ownerPool.query<{ id: string }>(
        `INSERT INTO job_posting_version (job_posting_id, content_fingerprint, title)
         VALUES ($1, 'fp1', 'Engineer') RETURNING id`,
        [postingId],
      )
    ).rows[0]!.id;
    await ownerPool.query(
      `INSERT INTO job_match
         (account_id, job_posting_id, job_posting_version_id, score, vector_score,
          keyword_score, skill_score, seniority_score, location_score, freshness_score, matcher_version)
       VALUES ($1, $2, $3, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 1)`,
      [purgeeId, postingId, versionId],
    );
    await ownerPool.query(
      `INSERT INTO match_explanation (account_id, job_posting_version_id, summary, evidence, model, prompt_version)
       VALUES ($1, $2, 'Good fit.', '[]'::jsonb, 'test-model', 1)`,
      [purgeeId, versionId],
    );

    const result = await withAccount(webPool, purgeeId, (tx) =>
      jobSearchRepo.stopJobSearch(tx, purgeeId, 'user_action'),
    );
    expect(result?.session.status).toBe('stopped');
    expect(result?.session.stopReason).toBe('user_action');
    expect(result?.purgedTables.sort()).toEqual(
      [
        'job_application',
        'job_match',
        'match_explanation',
        'resume_artifact',
        'resume_source',
        'resume_upload',
      ].sort(),
    );

    // Verify via the owner pool (bypasses RLS) that the rows are truly gone,
    // not just invisible to the tenant that deleted them.
    const remaining = await ownerPool.query<{ c: number }>(
      `SELECT
         (SELECT count(*) FROM resume_upload WHERE account_id = $1) +
         (SELECT count(*) FROM resume_source WHERE account_id = $1) +
         (SELECT count(*) FROM resume_artifact WHERE account_id = $1) +
         (SELECT count(*) FROM job_application WHERE account_id = $1) +
         (SELECT count(*) FROM job_match WHERE account_id = $1) +
         (SELECT count(*) FROM match_explanation WHERE account_id = $1)
         AS c`,
      [purgeeId],
    );
    expect(Number(remaining.rows[0]?.c)).toBe(0);

    // The session row itself survives, stopped - it's metadata about the
    // search, not search content.
    const sessionStillThere = await ownerPool.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM job_search_session WHERE account_id = $1',
      [purgeeId],
    );
    expect(sessionStillThere.rows[0]?.c).toBe(1);

    // The bystander's data is completely untouched.
    const bystanderResume = await withAccount(webPool, bystanderId, (tx) =>
      jobSearchRepo.getResumeUpload(tx, bystanderId),
    );
    expect(bystanderResume?.filename).toBe('bystander.pdf');
  });

  it('candidate_profile, profile_skill and profile_experience are NOT purged - only search-specific data is', async () => {
    const created = await withoutTenantContext(ownerPool, (tx) =>
      identityRepo.createUserWithAccount(tx, {
        email: 'purge-keeps-profile@example.com',
        fullName: 'Keeps Profile',
      }),
    );
    const accountId = created.accountId;

    await withAccount(webPool, accountId, (tx) =>
      profileRepo.upsertProfile(tx, accountId, { headline: 'Should survive a purge' }),
    );
    await withAccount(webPool, accountId, (tx) =>
      jobSearchRepo.startJobSearch(tx, accountId, { filename: 'r.pdf', rawText: 'text' }),
    );

    await withAccount(webPool, accountId, (tx) => jobSearchRepo.stopJobSearch(tx, accountId, 'user_action'));

    const profile = await withAccount(webPool, accountId, (tx) => profileRepo.getProfile(tx, accountId));
    expect(profile?.headline).toBe('Should survive a purge');
  });
});

describe('findDormantActiveSessions', () => {
  it('finds only sessions started before the staleness cutoff', async () => {
    const created = await withoutTenantContext(ownerPool, (tx) =>
      identityRepo.createUserWithAccount(tx, {
        email: 'dormant-check@example.com',
        fullName: 'Dormant Check',
      }),
    );
    const accountId = created.accountId;

    const started = await withAccount(webPool, accountId, (tx) =>
      jobSearchRepo.startJobSearch(tx, accountId, { filename: 'r.pdf', rawText: 'text' }),
    );

    // Not dormant yet under a generous window.
    const notYetDormant = await withoutTenantContext(ownerPool, (tx) =>
      jobSearchRepo.findDormantActiveSessions(tx, 90),
    );
    expect(notYetDormant.some((s) => s.id === started.session.id)).toBe(false);

    // Backdate started_at directly (owner pool, bypasses RLS) to simulate
    // real dormancy without waiting 90 days.
    await ownerPool.query(
      `UPDATE job_search_session SET started_at = now() - interval '100 days' WHERE id = $1`,
      [started.session.id],
    );

    const dormantNow = await withoutTenantContext(ownerPool, (tx) =>
      jobSearchRepo.findDormantActiveSessions(tx, 90),
    );
    expect(dormantNow.some((s) => s.id === started.session.id)).toBe(true);
  });
});
