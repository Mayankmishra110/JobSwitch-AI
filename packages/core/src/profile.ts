import { z } from 'zod';
import type { AccountId } from './ids.js';

/**
 * The personal layer (L2), Phase 4.
 *
 * candidate_profile is one row per account - the data a Phase 5 match gets
 * computed against, not the match itself. Skills and experience are separate
 * tables rather than columns because Phase 5 hard-filters on skills and
 * Phase 7 autofill needs individually addressable work-history entries, not a
 * paragraph to re-parse.
 */

export type WorkModePreference = 'remote' | 'hybrid' | 'onsite' | 'any';

/**
 * Fact provenance (ADR D-22/D-22a).
 *
 * Every fact in a candidate's profile is exactly one of these five kinds,
 * and the system must always know which. A match explanation or a tailored
 * resume edit that cites a fact has to be able to say whether that fact was
 * verified, self-reported, a search preference, model-inferred, or
 * model-written prose - because "matched on 4 years Python (verified from
 * your resume)" and "matched on 4 years Python (the model guessed)" are not
 * the same claim, and this product's premise is that the difference matters.
 *
 * `selfAsserted` was added after the original four (verifiedFact,
 * preference, aiInference, generatedText): a hand-typed headline is neither
 * "extracted from a document" nor "a search criterion" - it needed its own
 * name (D-22a).
 */
export type FactProvenance =
  | 'verified_fact'
  | 'self_asserted'
  | 'preference'
  | 'ai_inference'
  | 'generated_text';

export interface CandidateProfile {
  accountId: AccountId;
  headline: string | null;
  headlineProvenance: FactProvenance;
  summary: string | null;
  summaryProvenance: FactProvenance;
  currentTitle: string | null;
  currentTitleProvenance: FactProvenance;
  yearsExperience: number | null;
  yearsExperienceProvenance: FactProvenance;
  /** Always 'preference' (D-22) - a search criterion, not a fact about the past. */
  desiredTitles: string[];
  desiredLocations: string[];
  desiredWorkMode: WorkModePreference | null;
  desiredSalaryMin: number | null;
  desiredSalaryMax: number | null;
  desiredSalaryCurrency: string | null;
  /** Always 'self_asserted' (D-22). */
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProfileSkill {
  id: string;
  accountId: AccountId;
  skill: string;
  provenance: FactProvenance;
  /** Free text, e.g. 'resume:experience[0].bullets[2]' - where this was seen. */
  evidenceRef: string | null;
  /** Required when provenance is 'ai_inference' (DB CHECK, not just here). */
  confidence: number | null;
  createdAt: Date;
}

/**
 * One provenance-tagged fact about a candidate, in the shape both
 * services/ai's Fact (app/models.py) and services/backend's Fact
 * (internal/clients/ai.go) already require - every fact sent to an LLM
 * boundary carries the provenance it was actually recorded with, per D-22.
 * TS's own caller (apps/web, calling services/ai directly for tailoring -
 * see specs/application-workspace.md) builds this the same way Go's
 * internal/worker/explain.go already does for match explanation, so the
 * two independent callers stay in parity without sharing code across the
 * language boundary.
 */
export interface CandidateFact {
  ref: string;
  text: string;
  provenance: FactProvenance;
}

export interface ProfileExperience {
  id: string;
  accountId: AccountId;
  company: string;
  title: string;
  location: string | null;
  startDate: string;
  endDate: string | null;
  isCurrent: boolean;
  description: string | null;
  provenance: FactProvenance;
  evidenceRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Ephemeral resume retention (ADR D-31).
 *
 * Split off candidate_profile deliberately - see packages/db's
 * 0009_provenance_and_retention.sql. Everything here is purged the moment
 * job_search_session turns off; candidate_profile's other fields are not.
 */
export interface ResumeUpload {
  accountId: AccountId;
  filename: string;
  rawText: string;
  uploadedAt: Date;
}

export type JobSearchStatus = 'active' | 'stopped';
export type JobSearchStopReason = 'user_action' | 'scheduled_sweep_inactivity';

export interface JobSearchSession {
  id: string;
  accountId: AccountId;
  status: JobSearchStatus;
  startedAt: Date;
  stoppedAt: Date | null;
  stopReason: JobSearchStopReason | null;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const optionalUrl = z
  .string()
  .trim()
  .url('Enter a valid URL.')
  .max(2048)
  .optional()
  .or(z.literal('').transform(() => undefined));

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));

export const upsertProfileInput = z.object({
  headline: optionalText(200),
  summary: optionalText(5000),
  currentTitle: optionalText(200),
  yearsExperience: z.number().int().min(0).max(60).optional(),
  desiredTitles: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  desiredLocations: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  desiredWorkMode: z.enum(['remote', 'hybrid', 'onsite', 'any']).optional(),
  desiredSalaryMin: z.number().int().min(0).optional(),
  desiredSalaryMax: z.number().int().min(0).optional(),
  desiredSalaryCurrency: z
    .string()
    .trim()
    .length(3, 'Use a 3-letter currency code, e.g. INR.')
    .toUpperCase()
    .optional(),
  linkedinUrl: optionalUrl,
  githubUrl: optionalUrl,
  portfolioUrl: optionalUrl,
});

export type UpsertProfileInput = z.infer<typeof upsertProfileInput>;

export const replaceSkillsInput = z.object({
  skills: z
    .array(z.string().trim().min(1, 'A skill cannot be empty.').max(80))
    .max(100, 'That is a lot of skills - keep it to 100.'),
});

export type ReplaceSkillsInput = z.infer<typeof replaceSkillsInput>;

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

export const experienceInput = z
  .object({
    company: z.string().trim().min(1, 'Enter a company.').max(200),
    title: z.string().trim().min(1, 'Enter a title.').max(200),
    location: optionalText(200),
    startDate: dateOnly,
    endDate: dateOnly.optional(),
    isCurrent: z.boolean().optional().default(false),
    description: optionalText(5000),
  })
  .refine((v) => !(v.isCurrent && v.endDate), {
    message: 'A current role cannot have an end date.',
    path: ['endDate'],
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, {
    message: 'End date cannot be before the start date.',
    path: ['endDate'],
  });

export type ExperienceInput = z.infer<typeof experienceInput>;

export const updateExperienceInput = z
  .object({
    company: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    location: optionalText(200),
    startDate: dateOnly.optional(),
    endDate: dateOnly.optional(),
    isCurrent: z.boolean().optional(),
    description: optionalText(5000),
  })
  .refine((v) => !(v.isCurrent && v.endDate), {
    message: 'A current role cannot have an end date.',
    path: ['endDate'],
  });

export type UpdateExperienceInput = z.infer<typeof updateExperienceInput>;

/**
 * Starting a job search and uploading a resume are one action (ADR D-31) -
 * "upload it in real time when they ask it to start job switch." There is
 * deliberately no way to set only the filename or only the text.
 */
export const startJobSearchInput = z.object({
  filename: z.string().trim().min(1, 'Missing a filename.').max(255),
  rawText: z
    .string()
    .trim()
    .min(50, 'That does not look like a resume - paste the full text.')
    .max(50_000),
});

export type StartJobSearchInput = z.infer<typeof startJobSearchInput>;

/**
 * Queue name services/backend's cmd/worker claims from
 * (internal/worker/embed_profile.go's EmbedProfileQueue) - a cross-language
 * contract enforced only by both sides matching this string and
 * EmbedProfilePayload's shape exactly, the same way
 * packages/ingest/src/run.ts's EMBED_JOB_VERSION_QUEUE already works.
 */
export const EMBED_PROFILE_QUEUE = 'embed.profile';

/**
 * Which of an account's two profile_embedding rows (migration 0010,
 * CHECK (kind IN ('resume', 'desired_role'))) to (re-)compute.
 */
export type ProfileEmbeddingKind = 'resume' | 'desired_role';

export interface EmbedProfilePayload {
  accountId: string;
  kind: ProfileEmbeddingKind;
}
