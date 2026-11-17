import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AccountId } from '@jobswitch/core';
import { createPool } from '../src/pool.js';
import { migrate } from '../src/migrate.js';
import { withAccount, withoutTenantContext } from '../src/context.js';
import * as identityRepo from '../src/repositories/identity.js';
import * as applicationsRepo from '../src/repositories/applications.js';
import * as artifactsRepo from '../src/repositories/artifacts.js';
import * as outreachRepo from '../src/repositories/outreach.js';
import * as matchesRepo from '../src/repositories/matches.js';
import * as emailCredentialRepo from '../src/repositories/emailCredential.js';

/**
 * Phase 7's application workspace - job_application/application_event,
 * resume_source/resume_artifact, outreach_draft, job_match's dismiss/track,
 * and email_credential's encrypted storage. Same two-pool discipline as
 * profile.test.ts: an owner pool (bypasses RLS, used for setup and
 * ground-truth verification) and a webPool connected as app_web, the role
 * every function under test actually runs as.
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

async function seedPosting(
  sourceJobId: string,
): Promise<{ jobPostingId: string; jobPostingVersionId: string }> {
  const companyId = (
    await ownerPool.query<{ id: string }>(
      `INSERT INTO company (name, normalized_domain) VALUES ($1, $2) RETURNING id`,
      [`AppWorkspace Co ${sourceJobId}`, `appworkspaceco-${sourceJobId}.example`],
    )
  ).rows[0]!.id;
  const sourceId = (
    await ownerPool.query<{ id: string }>(
      `INSERT INTO career_source (company_id, ats_type, board_identifier)
       VALUES ($1, 'greenhouse', $2) RETURNING id`,
      [companyId, `appworkspaceco-${sourceJobId}`],
    )
  ).rows[0]!.id;
  const postingId = (
    await ownerPool.query<{ id: string }>(
      `INSERT INTO job_posting
         (career_source_id, company_id, source_job_id, canonical_title, normalized_title, apply_url)
       VALUES ($1, $2, $3, 'Staff Engineer', 'staff engineer', 'https://example.com/apply')
       RETURNING id`,
      [sourceId, companyId, sourceJobId],
    )
  ).rows[0]!.id;
  const versionId = (
    await ownerPool.query<{ id: string }>(
      `INSERT INTO job_posting_version (job_posting_id, content_fingerprint, title, description_text)
       VALUES ($1, $2, 'Staff Engineer', 'Build great things.') RETURNING id`,
      [postingId, `fp-${sourceJobId}`],
    )
  ).rows[0]!.id;
  await ownerPool.query(`UPDATE job_posting SET current_version_id = $2 WHERE id = $1`, [
    postingId,
    versionId,
  ]);
  return { jobPostingId: postingId, jobPostingVersionId: versionId };
}

async function seedMatch(accountId: AccountId, sourceJobId: string): Promise<string> {
  const { jobPostingId, jobPostingVersionId } = await seedPosting(sourceJobId);
  const { rows } = await ownerPool.query<{ id: string }>(
    `INSERT INTO job_match
       (account_id, job_posting_id, job_posting_version_id, score, vector_score,
        keyword_score, skill_score, seniority_score, location_score, freshness_score, matcher_version)
     VALUES ($1, $2, $3, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 1)
     RETURNING id`,
    [accountId, jobPostingId, jobPostingVersionId],
  );
  return rows[0]!.id;
}

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

  await ownerPool.query('DELETE FROM outreach_draft');
  await ownerPool.query('DELETE FROM email_credential');
  await ownerPool.query('DELETE FROM resume_artifact');
  await ownerPool.query('DELETE FROM job_application');
  await ownerPool.query('DELETE FROM resume_source');
  await ownerPool.query("DELETE FROM job_match");
  await ownerPool.query('DELETE FROM account_member');
  await ownerPool.query('DELETE FROM app_user');
  await ownerPool.query('DELETE FROM account');

  const created = await withoutTenantContext(ownerPool, async (tx) => {
    const a = await identityRepo.createUserWithAccount(tx, {
      email: 'workspace-a@example.com',
      fullName: 'Tenant A',
    });
    const b = await identityRepo.createUserWithAccount(tx, {
      email: 'workspace-b@example.com',
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

describe('job_application / application_event', () => {
  it('createManualApplication logs a found event and lists in board order', async () => {
    const app = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.createManualApplication(tx, accountA, {
        manualCompany: 'Acme',
        manualTitle: 'Backend Engineer',
        manualJdText: 'Write Go services.',
      }),
    );
    expect(app.status).toBe('found');
    expect(app.source).toBe('manual');

    const events = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.listApplicationEvents(tx, accountA, app.id),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: null, toStatus: 'found' });

    const listed = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.listApplications(tx, accountA),
    );
    expect(listed.map((a) => a.id)).toContain(app.id);
  });

  it('patchApplication writes both the row and an event only when status actually changes', async () => {
    const app = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.createManualApplication(tx, accountA, {
        manualCompany: 'Beta Co',
        manualTitle: 'SRE',
        manualJdText: 'Keep things up.',
      }),
    );

    const notesOnly = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.patchApplication(tx, accountA, app.id, { notes: 'Applied via referral.' }),
    );
    expect(notesOnly?.statusChanged).toBe(false);

    const statusChange = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.patchApplication(tx, accountA, app.id, { status: 'applied' }),
    );
    expect(statusChange?.statusChanged).toBe(true);
    expect(statusChange?.fromStatus).toBe('found');
    expect(statusChange?.application.status).toBe('applied');
    expect(statusChange?.application.notes).toBe('Applied via referral.');

    const events = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.listApplicationEvents(tx, accountA, app.id),
    );
    // One for the initial 'found', one for found -> applied - the notes-only
    // patch must not have added a third.
    expect(events).toHaveLength(2);
  });

  it('a tenant cannot see or patch another tenant\'s application', async () => {
    const app = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.createManualApplication(tx, accountA, {
        manualCompany: 'Secret Co',
        manualTitle: 'Engineer',
        manualJdText: 'Confidential role.',
      }),
    );

    const seenByB = await withAccount(webPool, accountB, (tx) =>
      applicationsRepo.getApplicationById(tx, accountB, app.id),
    );
    expect(seenByB).toBeNull();

    const patchedByB = await withAccount(webPool, accountB, (tx) =>
      applicationsRepo.patchApplication(tx, accountB, app.id, { status: 'applied' }),
    );
    expect(patchedByB).toBeNull();
  });

  it('jobContextFor prefers manual fields, and reads the matched posting for a match-sourced application', async () => {
    const manual = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.createManualApplication(tx, accountA, {
        manualCompany: 'Manual Co',
        manualTitle: 'Manual Title',
        manualJdText: 'Manual JD text.',
      }),
    );
    expect(applicationsRepo.jobContextFor(manual)).toEqual({
      title: 'Manual Title',
      company: 'Manual Co',
      description: 'Manual JD text.',
    });

    const matchId = await seedMatch(accountA, 'jd-context');
    const match = await withAccount(webPool, accountA, (tx) => matchesRepo.getMatchById(tx, accountA, matchId));
    const tracked = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.createApplicationFromMatch(tx, accountA, match!.jobPostingId),
    );
    const context = applicationsRepo.jobContextFor(tracked);
    expect(context?.title).toBe('Staff Engineer');
    expect(context?.description).toBe('Build great things.');
  });

  it('createApplicationFromMatch is idempotent for the same (account, posting)', async () => {
    const matchId = await seedMatch(accountA, 'jd-idempotent');
    const match = await withAccount(webPool, accountA, (tx) => matchesRepo.getMatchById(tx, accountA, matchId));

    const first = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.createApplicationFromMatch(tx, accountA, match!.jobPostingId),
    );
    const second = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.createApplicationFromMatch(tx, accountA, match!.jobPostingId),
    );
    expect(second.id).toBe(first.id);

    const events = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.listApplicationEvents(tx, accountA, first.id),
    );
    expect(events).toHaveLength(1); // not doubled by the second call
  });
});

describe('resume_source / resume_artifact', () => {
  it('upsertResumeSource is a real upsert keyed on (account, variant)', async () => {
    const created = await withAccount(webPool, accountA, (tx) =>
      artifactsRepo.upsertResumeSource(tx, accountA, {
        variantId: 'fullstack',
        label: 'Full-stack',
        pdfBaseName: 'resume',
        tex: '\\documentclass{article}\\begin{document}v1\\end{document}',
        sha256: 'hash-v1',
      }),
    );
    expect(created.sha256).toBe('hash-v1');

    const updated = await withAccount(webPool, accountA, (tx) =>
      artifactsRepo.upsertResumeSource(tx, accountA, {
        variantId: 'fullstack',
        label: 'Full-stack',
        pdfBaseName: 'resume',
        tex: '\\documentclass{article}\\begin{document}v2\\end{document}',
        sha256: 'hash-v2',
      }),
    );
    expect(updated.sha256).toBe('hash-v2');

    const sources = await withAccount(webPool, accountA, (tx) => artifactsRepo.listResumeSources(tx, accountA));
    expect(sources.filter((s) => s.variantId === 'fullstack')).toHaveLength(1);
  });

  it('createArtifact -> markArtifactCompiled round-trips proposed_changes/flags/accepted correctly', async () => {
    const app = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.createManualApplication(tx, accountA, {
        manualCompany: 'Artifact Co',
        manualTitle: 'Engineer',
        manualJdText: 'Do engineering.',
      }),
    );
    await withAccount(webPool, accountA, (tx) =>
      artifactsRepo.upsertResumeSource(tx, accountA, {
        variantId: 'main',
        label: 'Main',
        pdfBaseName: 'resume',
        tex: 'original tex',
        sha256: 'source-hash',
      }),
    );

    const artifact = await withAccount(webPool, accountA, (tx) =>
      artifactsRepo.createArtifact(tx, accountA, {
        applicationId: app.id,
        variantId: 'main',
        sourceSha256: 'source-hash',
        status: 'proposed',
        proposedChanges: [{ field: 'summary', rewritten: 'New summary', sourceFactRefs: ['current_title'] }],
        flags: [{ field: 'summary', token: 'Kubernetes', reason: 'new-entity', rewritten: 'New summary' }],
        tex: 'spliced tex',
      }),
    );
    expect(artifact.status).toBe('proposed');
    expect(artifact.proposedChanges).toEqual([
      { field: 'summary', rewritten: 'New summary', sourceFactRefs: ['current_title'] },
    ]);
    expect(artifact.hasPdf).toBe(false);

    const compiled = await withAccount(webPool, accountA, (tx) =>
      artifactsRepo.markArtifactCompiled(tx, accountA, artifact.id, {
        accepted: ['summary'],
        tex: 'final tex',
        pdfBytes: Buffer.from('%PDF-1.4 fake'),
        pdfSha256: 'pdf-hash',
      }),
    );
    expect(compiled?.status).toBe('compiled');
    expect(compiled?.accepted).toEqual(['summary']);
    expect(compiled?.hasPdf).toBe(true);

    const pdf = await withAccount(webPool, accountA, (tx) => artifactsRepo.getArtifactPdf(tx, accountA, artifact.id));
    expect(pdf?.pdfSha256).toBe('pdf-hash');
    expect(pdf?.pdfBytes.toString()).toBe('%PDF-1.4 fake');
  });

  it('markArtifactFailed records the error and leaves no PDF', async () => {
    const app = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.createManualApplication(tx, accountA, {
        manualCompany: 'Fail Co',
        manualTitle: 'Engineer',
        manualJdText: 'JD text.',
      }),
    );
    const artifact = await withAccount(webPool, accountA, (tx) =>
      artifactsRepo.createArtifact(tx, accountA, {
        applicationId: app.id,
        variantId: 'main',
        sourceSha256: 'source-hash',
        status: 'failed',
        compileError: 'LLM returned garbage',
      }),
    );
    expect(artifact.status).toBe('failed');
    expect(artifact.compileError).toBe('LLM returned garbage');

    const failed = await withAccount(webPool, accountA, (tx) =>
      artifactsRepo.markArtifactFailed(tx, accountA, artifact.id, 'compile blew up'),
    );
    expect(failed?.status).toBe('failed');
    expect(failed?.compileError).toBe('compile blew up');
    expect(failed?.hasPdf).toBe(false);
  });

  it('a tenant cannot read another tenant\'s resume_artifact PDF', async () => {
    const app = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.createManualApplication(tx, accountA, {
        manualCompany: 'Isolation Co',
        manualTitle: 'Engineer',
        manualJdText: 'JD text.',
      }),
    );
    const artifact = await withAccount(webPool, accountA, (tx) =>
      artifactsRepo.createArtifact(tx, accountA, {
        applicationId: app.id,
        variantId: 'main',
        sourceSha256: 'hash',
        status: 'proposed',
      }),
    );
    await withAccount(webPool, accountA, (tx) =>
      artifactsRepo.markArtifactCompiled(tx, accountA, artifact.id, {
        accepted: [],
        tex: 'tex',
        pdfBytes: Buffer.from('secret pdf'),
        pdfSha256: 'secret-hash',
      }),
    );

    const seenByB = await withAccount(webPool, accountB, (tx) => artifactsRepo.getArtifactPdf(tx, accountB, artifact.id));
    expect(seenByB).toBeNull();
  });
});

describe('outreach_draft', () => {
  it('draft -> approve -> send transitions, each gated on the prior status', async () => {
    const app = await withAccount(webPool, accountA, (tx) =>
      applicationsRepo.createManualApplication(tx, accountA, {
        manualCompany: 'Outreach Co',
        manualTitle: 'Engineer',
        manualJdText: 'JD text.',
      }),
    );

    const draft = await withAccount(webPool, accountA, (tx) =>
      outreachRepo.createOutreachDraft(
        tx,
        accountA,
        app.id,
        { toEmail: 'recruiter@example.com', toName: 'Recruiter' },
        { subject: 'Interested', body: 'Hello.' },
      ),
    );
    expect(draft.status).toBe('draft');

    // Sending before approval is refused.
    const sendBeforeApproval = await withAccount(webPool, accountA, (tx) =>
      outreachRepo.markOutreachSent(tx, accountA, draft.id, 'gmail-msg-1'),
    );
    expect(sendBeforeApproval).toBeNull();

    const patched = await withAccount(webPool, accountA, (tx) =>
      outreachRepo.patchOutreachDraft(tx, accountA, draft.id, { subject: 'Very interested' }),
    );
    expect(patched?.subject).toBe('Very interested');

    const approved = await withAccount(webPool, accountA, (tx) =>
      outreachRepo.approveOutreachDraft(tx, accountA, draft.id),
    );
    expect(approved?.status).toBe('approved');

    // Editing after approval is refused.
    const patchAfterApproval = await withAccount(webPool, accountA, (tx) =>
      outreachRepo.patchOutreachDraft(tx, accountA, draft.id, { subject: 'Too late' }),
    );
    expect(patchAfterApproval).toBeNull();

    // Approving twice is a no-op-turned-null, not a silent double-approve.
    const approveAgain = await withAccount(webPool, accountA, (tx) =>
      outreachRepo.approveOutreachDraft(tx, accountA, draft.id),
    );
    expect(approveAgain).toBeNull();

    const sent = await withAccount(webPool, accountA, (tx) =>
      outreachRepo.markOutreachSent(tx, accountA, draft.id, 'gmail-msg-1'),
    );
    expect(sent?.status).toBe('sent');
    expect(sent?.gmailMessageId).toBe('gmail-msg-1');

    // Sending twice (a compare-and-set race) fails cleanly the second time.
    const sendAgain = await withAccount(webPool, accountA, (tx) =>
      outreachRepo.markOutreachSent(tx, accountA, draft.id, 'gmail-msg-2'),
    );
    expect(sendAgain).toBeNull();
  });
});

describe('job_match dismiss/track', () => {
  it('listMatches excludes dismissed rows, and dismiss is idempotent', async () => {
    const matchId = await seedMatch(accountA, 'dismiss-flow');

    const before = await withAccount(webPool, accountA, (tx) => matchesRepo.listMatches(tx, accountA));
    expect(before.map((m) => m.id)).toContain(matchId);

    const dismissed = await withAccount(webPool, accountA, (tx) => matchesRepo.dismissMatch(tx, accountA, matchId));
    expect(dismissed).toBe(true);

    const after = await withAccount(webPool, accountA, (tx) => matchesRepo.listMatches(tx, accountA));
    expect(after.map((m) => m.id)).not.toContain(matchId);

    const dismissAgain = await withAccount(webPool, accountA, (tx) => matchesRepo.dismissMatch(tx, accountA, matchId));
    expect(dismissAgain).toBe(false);
  });

  it('a tenant cannot dismiss another tenant\'s match', async () => {
    const matchId = await seedMatch(accountA, 'cross-tenant-dismiss');
    const dismissedByB = await withAccount(webPool, accountB, (tx) => matchesRepo.dismissMatch(tx, accountB, matchId));
    expect(dismissedByB).toBe(false);

    const stillThere = await withAccount(webPool, accountA, (tx) => matchesRepo.getMatchById(tx, accountA, matchId));
    expect(stillThere?.id).toBe(matchId);
  });
});

describe('email_credential encryption round-trip', () => {
  const KEY = 'test-encryption-key-do-not-use-in-prod';

  it('stores the refresh token encrypted, decryptable only with the right key', async () => {
    const status = await withAccount(webPool, accountA, (tx) => emailCredentialRepo.getCredentialStatus(tx, accountA));
    expect(status).toEqual({ connected: false, email: null });

    await withAccount(webPool, accountA, (tx) =>
      emailCredentialRepo.upsertCredential(
        tx,
        accountA,
        { email: 'candidate@gmail.com', refreshToken: '1//real-refresh-token', scope: 'gmail.send' },
        KEY,
      ),
    );

    const connected = await withAccount(webPool, accountA, (tx) => emailCredentialRepo.getCredentialStatus(tx, accountA));
    expect(connected).toEqual({ connected: true, email: 'candidate@gmail.com' });

    // The raw column never holds plaintext - a real pgcrypto ciphertext,
    // not a passthrough.
    const raw = await ownerPool.query<{ encrypted_refresh_token: Buffer }>(
      'SELECT encrypted_refresh_token FROM email_credential WHERE account_id = $1',
      [accountA],
    );
    expect(raw.rows[0]!.encrypted_refresh_token.toString('utf8')).not.toContain('real-refresh-token');

    const decrypted = await withAccount(webPool, accountA, (tx) =>
      emailCredentialRepo.getDecryptedRefreshToken(tx, accountA, KEY),
    );
    expect(decrypted).toBe('1//real-refresh-token');

    await expect(
      withAccount(webPool, accountA, (tx) =>
        emailCredentialRepo.getDecryptedRefreshToken(tx, accountA, 'wrong-key-wrong-key-wrong-key'),
      ),
    ).rejects.toThrow();
  });

  it('upsertCredential replaces an existing credential rather than duplicating it', async () => {
    await withAccount(webPool, accountA, (tx) =>
      emailCredentialRepo.upsertCredential(
        tx,
        accountA,
        { email: 'candidate-new@gmail.com', refreshToken: 'token-2', scope: 'gmail.send' },
        KEY,
      ),
    );
    const status = await withAccount(webPool, accountA, (tx) => emailCredentialRepo.getCredentialStatus(tx, accountA));
    expect(status.email).toBe('candidate-new@gmail.com');

    const count = await ownerPool.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM email_credential WHERE account_id = $1',
      [accountA],
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it('deleteCredential removes the row', async () => {
    const deleted = await withAccount(webPool, accountA, (tx) => emailCredentialRepo.deleteCredential(tx, accountA));
    expect(deleted).toBe(true);
    const status = await withAccount(webPool, accountA, (tx) => emailCredentialRepo.getCredentialStatus(tx, accountA));
    expect(status.connected).toBe(false);
  });

  it('a tenant cannot read another tenant\'s credential status or token', async () => {
    await withAccount(webPool, accountA, (tx) =>
      emailCredentialRepo.upsertCredential(
        tx,
        accountA,
        { email: 'a@gmail.com', refreshToken: 'a-token', scope: 'gmail.send' },
        KEY,
      ),
    );
    const seenByB = await withAccount(webPool, accountB, (tx) => emailCredentialRepo.getCredentialStatus(tx, accountB));
    expect(seenByB).toEqual({ connected: false, email: null });
  });
});
