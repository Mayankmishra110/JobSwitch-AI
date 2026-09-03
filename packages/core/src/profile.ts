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

export interface CandidateProfile {
  accountId: AccountId;
  headline: string | null;
  summary: string | null;
  currentTitle: string | null;
  yearsExperience: number | null;
  desiredTitles: string[];
  desiredLocations: string[];
  desiredWorkMode: WorkModePreference | null;
  desiredSalaryMin: number | null;
  desiredSalaryMax: number | null;
  desiredSalaryCurrency: string | null;
  resumeFilename: string | null;
  resumeText: string | null;
  resumeUploadedAt: Date | null;
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
  createdAt: Date;
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
  createdAt: Date;
  updatedAt: Date;
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
