import { z } from 'zod';
import type { AccountId } from './ids.js';

/**
 * The application workspace (Phase 7) - the tracker (`job_application`),
 * its append-only history (`application_event`), tailoring output
 * (`resume_artifact`), and outreach (`outreach_draft`). Schema for the
 * first three already existed from Phase 5
 * (`packages/db/migrations/0008_tailoring_and_pipeline.sql`) with no
 * application-layer code yet; `outreach_draft`/`email_credential` are new
 * in 0017. See specs/application-workspace.md.
 */

// ---------------------------------------------------------------------------
// job_application / application_event
// ---------------------------------------------------------------------------

export type ApplicationStatus =
  | 'found'
  | 'tailoring'
  | 'tailored'
  | 'applied'
  | 'responded'
  | 'interview'
  | 'offer'
  | 'rejected'
  | 'withdrawn';

export type ApplicationSource = 'match' | 'manual';

export interface JobApplication {
  id: string;
  accountId: AccountId;
  jobPostingId: string | null;
  source: ApplicationSource;
  manualCompany: string | null;
  manualTitle: string | null;
  manualUrl: string | null;
  manualJdText: string | null;
  status: ApplicationStatus;
  appliedAt: Date | null;
  nextActionAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Denormalized from job_posting/job_posting_version for a matched (non-manual) row - null for a manual entry, which has no posting to join against. */
  postingTitle: string | null;
  postingCompany: string | null;
  postingDescription: string | null;
}

export interface ApplicationEvent {
  id: string;
  accountId: AccountId;
  applicationId: string;
  fromStatus: ApplicationStatus | null;
  toStatus: ApplicationStatus;
  note: string | null;
  occurredAt: Date;
}

export const createApplicationInput = z
  .object({
    manualCompany: z.string().trim().min(1).max(200),
    manualTitle: z.string().trim().min(1).max(200),
    manualUrl: z
      .string()
      .trim()
      .url('Enter a valid URL.')
      .max(2048)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    manualJdText: z.string().trim().min(1, 'Paste the job description.').max(50_000),
  })
  .strict();

export type CreateApplicationInput = z.infer<typeof createApplicationInput>;

const APPLICATION_STATUSES = [
  'found',
  'tailoring',
  'tailored',
  'applied',
  'responded',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
] as const;

export const patchApplicationInput = z
  .object({
    status: z.enum(APPLICATION_STATUSES).optional(),
    notes: z.string().trim().max(5000).optional().or(z.literal('').transform(() => undefined)),
    nextActionAt: z.string().datetime().optional(),
    appliedAt: z.string().datetime().optional(),
  })
  .strict();

export type PatchApplicationInput = z.infer<typeof patchApplicationInput>;

// ---------------------------------------------------------------------------
// resume_artifact
// ---------------------------------------------------------------------------

export type ResumeArtifactStatus = 'proposed' | 'compiled' | 'failed';

/** Mirrors services/ai's ProposedEdit (app/models.py) - one field-level rewrite, cited back to the facts that justified it. */
export interface ProposedEdit {
  field: string;
  rewritten: string;
  sourceFactRefs: string[];
}

/** Mirrors services/ai's ProperNounFlagOut - fabrication_check's own output shape. */
export interface TailorFlag {
  field: string;
  token: string;
  reason: 'new-entity' | 'new-metric';
  rewritten: string;
}

export interface ResumeArtifact {
  id: string;
  accountId: AccountId;
  applicationId: string;
  variantId: string;
  sourceSha256: string;
  status: ResumeArtifactStatus;
  proposedChanges: ProposedEdit[];
  flags: TailorFlag[];
  accepted: string[];
  tex: string | null;
  pdfSha256: string | null;
  compileError: string | null;
  createdAt: Date;
  compiledAt: Date | null;
  /** Whether pdf_bytes is set - the bytes themselves are never included in a list/get response, only via GET .../pdf. */
  hasPdf: boolean;
}

export interface ResumeSourceSummary {
  variantId: string;
  label: string;
  pdfBaseName: string;
  sha256: string;
}

export const upsertResumeSourceInput = z
  .object({
    label: z.string().trim().min(1, 'Give this resume a label.').max(200),
    pdfBaseName: z.string().trim().min(1).max(200),
    tex: z.string().trim().min(1, 'Paste the LaTeX source.').max(200_000),
  })
  .strict();

export type UpsertResumeSourceInput = z.infer<typeof upsertResumeSourceInput>;

const VARIANT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
export const resumeVariantIdInput = z
  .string()
  .trim()
  .regex(VARIANT_ID_RE, 'Use lowercase letters, digits, and hyphens only.');

export const tailorApplicationInput = z
  .object({
    variantId: z.string().trim().min(1, 'Choose which resume to tailor.').max(100),
  })
  .strict();

export type TailorApplicationInput = z.infer<typeof tailorApplicationInput>;

export const compileArtifactInput = z
  .object({
    accepted: z.array(z.string().trim().min(1)).max(200),
  })
  .strict();

export type CompileArtifactInput = z.infer<typeof compileArtifactInput>;

// ---------------------------------------------------------------------------
// outreach_draft
// ---------------------------------------------------------------------------

export type OutreachStatus = 'draft' | 'approved' | 'sent';

export interface OutreachDraft {
  id: string;
  accountId: AccountId;
  applicationId: string;
  toEmail: string;
  toName: string | null;
  subject: string;
  body: string;
  status: OutreachStatus;
  gmailMessageId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const createOutreachInput = z
  .object({
    toEmail: z.string().trim().email('Enter a valid email address.').max(320),
    toName: z.string().trim().max(200).optional().or(z.literal('').transform(() => undefined)),
  })
  .strict();

export type CreateOutreachInput = z.infer<typeof createOutreachInput>;

export const patchOutreachInput = z
  .object({
    toEmail: z.string().trim().email('Enter a valid email address.').max(320).optional(),
    toName: z.string().trim().max(200).optional().or(z.literal('').transform(() => undefined)),
    subject: z.string().trim().min(1).max(300).optional(),
    body: z.string().trim().min(1).max(20_000).optional(),
  })
  .strict();

export type PatchOutreachInput = z.infer<typeof patchOutreachInput>;

// ---------------------------------------------------------------------------
// email_credential - public-safe view only. The encrypted refresh token
// never has a TS type at all outside the one repository function that
// writes/reads it - see packages/db/src/repositories/emailCredential.ts.
// ---------------------------------------------------------------------------

export interface EmailCredentialStatus {
  connected: boolean;
  email: string | null;
}

// ---------------------------------------------------------------------------
// job_match - dismiss/track (the matches feed's two actions on an existing
// row; job_match is otherwise written only by services/backend).
// ---------------------------------------------------------------------------

export interface JobMatchSummary {
  id: string;
  accountId: AccountId;
  jobPostingId: string;
  jobPostingVersionId: string;
  title: string;
  company: string | null;
  score: number;
  vectorScore: number;
  keywordScore: number;
  skillScore: number;
  seniorityScore: number;
  locationScore: number;
  compScore: number | null;
  freshnessScore: number;
  rankedAt: Date;
  explanation: {
    summary: string;
    evidence: Array<{ claim: string; factRef: string; provenance: string }>;
  } | null;
}
