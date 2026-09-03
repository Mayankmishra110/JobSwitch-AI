import {
  AccountId,
  type CandidateProfile,
  type ExperienceInput,
  type ProfileExperience,
  type ProfileSkill,
  type UpsertProfileInput,
  type WorkModePreference,
} from '@jobswitch/core';
import type { Queryable } from '../context.js';

/**
 * Personal profile repository - Layer 2 (ADR §L2, Phase 4).
 *
 * Every function requires an account-scoped transaction (see context.ts's
 * `withAccount`) even though RLS would also block a cross-tenant read or
 * write on its own - the account_id parameter and the RLS policy are two
 * independent checks, and neither is meant to be the only one.
 */

// ---------------------------------------------------------------------------
// candidate_profile
// ---------------------------------------------------------------------------

interface ProfileRow {
  account_id: string;
  headline: string | null;
  summary: string | null;
  current_title: string | null;
  years_experience: number | null;
  desired_titles: string[];
  desired_locations: string[];
  desired_work_mode: WorkModePreference | null;
  desired_salary_min: number | null;
  desired_salary_max: number | null;
  desired_salary_currency: string | null;
  resume_filename: string | null;
  resume_text: string | null;
  resume_uploaded_at: Date | null;
  linkedin_url: string | null;
  github_url: string | null;
  portfolio_url: string | null;
  created_at: Date;
  updated_at: Date;
}

const PROFILE_COLUMNS = `account_id, headline, summary, current_title, years_experience,
  desired_titles, desired_locations, desired_work_mode,
  desired_salary_min, desired_salary_max, desired_salary_currency,
  resume_filename, resume_text, resume_uploaded_at,
  linkedin_url, github_url, portfolio_url, created_at, updated_at`;

function toProfile(row: ProfileRow): CandidateProfile {
  return {
    accountId: AccountId(row.account_id),
    headline: row.headline,
    summary: row.summary,
    currentTitle: row.current_title,
    yearsExperience: row.years_experience,
    desiredTitles: row.desired_titles,
    desiredLocations: row.desired_locations,
    desiredWorkMode: row.desired_work_mode,
    desiredSalaryMin: row.desired_salary_min,
    desiredSalaryMax: row.desired_salary_max,
    desiredSalaryCurrency: row.desired_salary_currency,
    resumeFilename: row.resume_filename,
    resumeText: row.resume_text,
    resumeUploadedAt: row.resume_uploaded_at,
    linkedinUrl: row.linkedin_url,
    githubUrl: row.github_url,
    portfolioUrl: row.portfolio_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getProfile(
  tx: Queryable,
  accountId: AccountId,
): Promise<CandidateProfile | null> {
  const { rows } = await tx.query<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM candidate_profile WHERE account_id = $1`,
    [accountId],
  );
  return rows[0] ? toProfile(rows[0]) : null;
}

/**
 * Create or update the profile's core fields.
 *
 * A field omitted from `input` keeps its current value rather than being
 * cleared - there is no way yet to blank out a headline once set, which is a
 * deliberate MVP simplification (see the README's known gaps), not an
 * oversight. Resume fields are untouched here; `setResume` owns those.
 *
 * Reads the existing row before writing rather than a partial `SET` list, so
 * the statement is one deterministic INSERT ... ON CONFLICT regardless of
 * which fields the caller sent. Two concurrent upserts on the same account
 * can still race - acceptable for a single user's own profile, unlike the
 * queue, which is why that path uses SKIP LOCKED and this one does not.
 */
export async function upsertProfile(
  tx: Queryable,
  accountId: AccountId,
  input: UpsertProfileInput,
): Promise<CandidateProfile> {
  const existing = await getProfile(tx, accountId);

  const merged = {
    headline: input.headline !== undefined ? input.headline : (existing?.headline ?? null),
    summary: input.summary !== undefined ? input.summary : (existing?.summary ?? null),
    currentTitle:
      input.currentTitle !== undefined ? input.currentTitle : (existing?.currentTitle ?? null),
    yearsExperience:
      input.yearsExperience !== undefined
        ? input.yearsExperience
        : (existing?.yearsExperience ?? null),
    desiredTitles:
      input.desiredTitles !== undefined ? input.desiredTitles : (existing?.desiredTitles ?? []),
    desiredLocations:
      input.desiredLocations !== undefined
        ? input.desiredLocations
        : (existing?.desiredLocations ?? []),
    desiredWorkMode:
      input.desiredWorkMode !== undefined
        ? input.desiredWorkMode
        : (existing?.desiredWorkMode ?? null),
    desiredSalaryMin:
      input.desiredSalaryMin !== undefined
        ? input.desiredSalaryMin
        : (existing?.desiredSalaryMin ?? null),
    desiredSalaryMax:
      input.desiredSalaryMax !== undefined
        ? input.desiredSalaryMax
        : (existing?.desiredSalaryMax ?? null),
    desiredSalaryCurrency:
      input.desiredSalaryCurrency !== undefined
        ? input.desiredSalaryCurrency
        : (existing?.desiredSalaryCurrency ?? null),
    linkedinUrl:
      input.linkedinUrl !== undefined ? input.linkedinUrl : (existing?.linkedinUrl ?? null),
    githubUrl: input.githubUrl !== undefined ? input.githubUrl : (existing?.githubUrl ?? null),
    portfolioUrl:
      input.portfolioUrl !== undefined ? input.portfolioUrl : (existing?.portfolioUrl ?? null),
  };

  const { rows } = await tx.query<ProfileRow>(
    `INSERT INTO candidate_profile (
       account_id, headline, summary, current_title, years_experience,
       desired_titles, desired_locations, desired_work_mode,
       desired_salary_min, desired_salary_max, desired_salary_currency,
       linkedin_url, github_url, portfolio_url
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (account_id) DO UPDATE SET
       headline = EXCLUDED.headline,
       summary = EXCLUDED.summary,
       current_title = EXCLUDED.current_title,
       years_experience = EXCLUDED.years_experience,
       desired_titles = EXCLUDED.desired_titles,
       desired_locations = EXCLUDED.desired_locations,
       desired_work_mode = EXCLUDED.desired_work_mode,
       desired_salary_min = EXCLUDED.desired_salary_min,
       desired_salary_max = EXCLUDED.desired_salary_max,
       desired_salary_currency = EXCLUDED.desired_salary_currency,
       linkedin_url = EXCLUDED.linkedin_url,
       github_url = EXCLUDED.github_url,
       portfolio_url = EXCLUDED.portfolio_url,
       updated_at = now()
     RETURNING ${PROFILE_COLUMNS}`,
    [
      accountId,
      merged.headline,
      merged.summary,
      merged.currentTitle,
      merged.yearsExperience,
      merged.desiredTitles,
      merged.desiredLocations,
      merged.desiredWorkMode,
      merged.desiredSalaryMin,
      merged.desiredSalaryMax,
      merged.desiredSalaryCurrency,
      merged.linkedinUrl,
      merged.githubUrl,
      merged.portfolioUrl,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('candidate_profile upsert returned no row');
  return toProfile(row);
}

/**
 * Record an uploaded resume's extracted text.
 *
 * Text-only: there is no object store wired up yet (README known gaps), so
 * the original file is not retained anywhere - only what was extracted from
 * it, which is also all Phase 5 embedding will ever need to read.
 */
export async function setResume(
  tx: Queryable,
  accountId: AccountId,
  params: { filename: string; text: string },
): Promise<CandidateProfile> {
  const { rows } = await tx.query<ProfileRow>(
    `INSERT INTO candidate_profile (account_id, resume_filename, resume_text, resume_uploaded_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (account_id) DO UPDATE SET
       resume_filename = EXCLUDED.resume_filename,
       resume_text = EXCLUDED.resume_text,
       resume_uploaded_at = EXCLUDED.resume_uploaded_at,
       updated_at = now()
     RETURNING ${PROFILE_COLUMNS}`,
    [accountId, params.filename, params.text],
  );
  const row = rows[0];
  if (!row) throw new Error('candidate_profile resume upsert returned no row');
  return toProfile(row);
}

// ---------------------------------------------------------------------------
// profile_skill
// ---------------------------------------------------------------------------

interface SkillRow {
  id: string;
  account_id: string;
  skill: string;
  created_at: Date;
}

function toSkill(row: SkillRow): ProfileSkill {
  return {
    id: row.id,
    accountId: AccountId(row.account_id),
    skill: row.skill,
    createdAt: row.created_at,
  };
}

export async function listSkills(
  tx: Queryable,
  accountId: AccountId,
): Promise<ProfileSkill[]> {
  const { rows } = await tx.query<SkillRow>(
    `SELECT id, account_id, skill, created_at FROM profile_skill
     WHERE account_id = $1 ORDER BY lower(skill)`,
    [accountId],
  );
  return rows.map(toSkill);
}

/**
 * Replace the whole skill list in one call.
 *
 * Simpler than incremental add/remove for a Phase 4 UI that is realistically
 * a single tag-editor field, and it sidesteps having to reconcile
 * case-only duplicates ("React" vs "react") on the client.
 */
export async function replaceSkills(
  tx: Queryable,
  accountId: AccountId,
  skills: string[],
): Promise<ProfileSkill[]> {
  // De-duplicate case-insensitively, keeping the first spelling seen - the
  // unique index would reject the second insert otherwise.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const s of skills) {
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }

  await tx.query('DELETE FROM profile_skill WHERE account_id = $1', [accountId]);

  if (deduped.length === 0) return [];

  const values = deduped.map((_, i) => `($1, $${i + 2})`).join(', ');
  const { rows } = await tx.query<SkillRow>(
    `INSERT INTO profile_skill (account_id, skill) VALUES ${values}
     RETURNING id, account_id, skill, created_at`,
    [accountId, ...deduped],
  );
  return rows.map(toSkill).sort((a, b) => a.skill.localeCompare(b.skill));
}

// ---------------------------------------------------------------------------
// profile_experience
// ---------------------------------------------------------------------------

interface ExperienceRow {
  id: string;
  account_id: string;
  company: string;
  title: string;
  location: string | null;
  start_date: string;
  end_date: string | null;
  is_current: boolean;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

function toExperience(row: ExperienceRow): ProfileExperience {
  return {
    id: row.id,
    accountId: AccountId(row.account_id),
    company: row.company,
    title: row.title,
    location: row.location,
    startDate: row.start_date,
    endDate: row.end_date,
    isCurrent: row.is_current,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listExperience(
  tx: Queryable,
  accountId: AccountId,
): Promise<ProfileExperience[]> {
  const { rows } = await tx.query<ExperienceRow>(
    `SELECT id, account_id, company, title, location, start_date, end_date,
            is_current, description, created_at, updated_at
     FROM profile_experience
     WHERE account_id = $1
     ORDER BY is_current DESC, start_date DESC`,
    [accountId],
  );
  return rows.map(toExperience);
}

export async function getExperienceById(
  tx: Queryable,
  accountId: AccountId,
  experienceId: string,
): Promise<ProfileExperience | null> {
  const { rows } = await tx.query<ExperienceRow>(
    `SELECT id, account_id, company, title, location, start_date, end_date,
            is_current, description, created_at, updated_at
     FROM profile_experience
     WHERE account_id = $1 AND id = $2`,
    [accountId, experienceId],
  );
  return rows[0] ? toExperience(rows[0]) : null;
}

export async function addExperience(
  tx: Queryable,
  accountId: AccountId,
  input: ExperienceInput,
): Promise<ProfileExperience> {
  const { rows } = await tx.query<ExperienceRow>(
    `INSERT INTO profile_experience
       (account_id, company, title, location, start_date, end_date, is_current, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, account_id, company, title, location, start_date, end_date,
               is_current, description, created_at, updated_at`,
    [
      accountId,
      input.company,
      input.title,
      input.location ?? null,
      input.startDate,
      input.endDate ?? null,
      input.isCurrent,
      input.description ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('profile_experience insert returned no row');
  return toExperience(row);
}

/**
 * Full replace of one entry's fields, merged with what is already there.
 *
 * Takes the already-merged, already-validated result rather than a partial
 * patch, so the invariants `experienceInput` enforces (end >= start, not
 * both current and ended) hold for the row this actually writes - not just
 * for whichever fields the caller happened to send.
 */
export async function updateExperience(
  tx: Queryable,
  accountId: AccountId,
  experienceId: string,
  input: ExperienceInput,
): Promise<ProfileExperience | null> {
  const { rows } = await tx.query<ExperienceRow>(
    `UPDATE profile_experience
     SET company = $3, title = $4, location = $5, start_date = $6,
         end_date = $7, is_current = $8, description = $9, updated_at = now()
     WHERE account_id = $1 AND id = $2
     RETURNING id, account_id, company, title, location, start_date, end_date,
               is_current, description, created_at, updated_at`,
    [
      accountId,
      experienceId,
      input.company,
      input.title,
      input.location ?? null,
      input.startDate,
      input.endDate ?? null,
      input.isCurrent,
      input.description ?? null,
    ],
  );
  return rows[0] ? toExperience(rows[0]) : null;
}

export async function deleteExperience(
  tx: Queryable,
  accountId: AccountId,
  experienceId: string,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    'DELETE FROM profile_experience WHERE account_id = $1 AND id = $2',
    [accountId, experienceId],
  );
  return (rowCount ?? 0) > 0;
}
