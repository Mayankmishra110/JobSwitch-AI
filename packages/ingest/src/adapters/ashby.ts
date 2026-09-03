import { z } from 'zod';
import type { NormalizedPostingInput } from '@jobswitch/db';
import {
  AdapterHttpError,
  AdapterShapeError,
  type AtsAdapter,
  type DetectResult,
  type FetchContext,
  type FetchResult,
} from '../adapter.js';
import {
  contentFingerprint,
  detectSeniority,
  htmlToText,
  normalizeTitle,
  parseLocations,
} from '../normalize.js';

/**
 * Ashby job board adapter.
 *
 * Uses Ashby's public job board API, published for exactly this purpose: no
 * authentication, no pagination.
 *
 *   GET https://api.ashbyhq.com/posting-api/job-board/{boardName}?includeCompensation=true
 *
 * ─────────────────────────────────────────────────────────────────────────
 * VERIFICATION STATUS: the field mapping below is written from Ashby's
 * documented response shape and has NOT been checked against a live board -
 * this environment blocks all outbound hosts. The fixture in test/fixtures
 * is hand-constructed, not captured.
 *
 * Before trusting this in production, run:
 *
 *     pnpm --filter @jobswitch/ingest capture -- ashby <board-name>
 *
 * which writes a real response into test/fixtures and lets the golden test
 * compare against it. Treat the first real run as the actual verification.
 * ─────────────────────────────────────────────────────────────────────────
 */

const BASE_URL = 'https://api.ashbyhq.com/posting-api/job-board';

/**
 * Strict on the fields we depend on, permissive elsewhere - same asymmetry as
 * the other adapters: a field Ashby adds never breaks ingestion, one it
 * renames does.
 */
const ashbyCompensationTier = z
  .object({
    minValue: z.number().optional().nullable(),
    maxValue: z.number().optional().nullable(),
    currencyCode: z.string().optional().nullable(),
  })
  .passthrough();

const ashbyJob = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    jobUrl: z.string().url(),
    applyUrl: z.string().url().optional().nullable(),
    department: z.string().optional().nullable(),
    team: z.string().optional().nullable(),
    employmentType: z.string().optional().nullable(),
    location: z.string().optional().nullable(),
    secondaryLocations: z
      .array(z.object({ location: z.string().optional() }).passthrough())
      .optional()
      .nullable(),
    isRemote: z.boolean().optional().nullable(),
    descriptionHtml: z.string().optional().nullable(),
    descriptionPlain: z.string().optional().nullable(),
    publishedAt: z.string().optional().nullable(),
    updatedAt: z.string().optional().nullable(),
    compensation: z
      .object({
        summaryComponents: z.array(ashbyCompensationTier).optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
  })
  .passthrough();

export type AshbyJob = z.infer<typeof ashbyJob>;

const ashbyResponse = z
  .object({
    jobs: z.array(z.unknown()),
  })
  .passthrough();

const BOARD_URL_PATTERNS = [
  /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i,
  /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9_-]+)/i,
];

export const ashbyAdapter: AtsAdapter = {
  atsType: 'ashby',

  capabilities: {
    structuredLocation: true,
    // Ashby is the first adapter that can expose real compensation ranges,
    // which is why the seeded ats_platform capabilities mark it true where
    // Greenhouse and Lever are false.
    structuredSalary: true,
    department: true,
    directApplyUrl: true,
    autofillable: true,
  },

  detect(careerUrl: string): DetectResult | null {
    for (const re of BOARD_URL_PATTERNS) {
      const match = re.exec(careerUrl);
      if (match?.[1]) {
        return { atsType: 'ashby', boardIdentifier: match[1].toLowerCase() };
      }
    }
    return null;
  },

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const url = `${BASE_URL}/${encodeURIComponent(ctx.boardIdentifier)}?includeCompensation=true`;

    const response = await ctx.fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'user-agent': ctx.userAgent,
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    if (!response.ok) {
      throw new AdapterHttpError(
        'ashby',
        response.status,
        response.status === 404
          ? `board "${ctx.boardIdentifier}" not found - the name is wrong or the board was removed`
          : await response.text().then(
              (t) => t.slice(0, 200),
              () => 'unreadable body',
            ),
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new AdapterShapeError('ashby', 'response was not JSON', error);
    }

    const parsed = ashbyResponse.safeParse(body);
    if (!parsed.success) {
      throw new AdapterShapeError(
        'ashby',
        'response did not contain a jobs array',
        parsed.error.flatten(),
      );
    }

    return { raw: parsed.data.jobs, httpStatus: response.status };
  },

  normalize(raw: unknown): NormalizedPostingInput {
    const parsed = ashbyJob.safeParse(raw);
    if (!parsed.success) {
      throw new AdapterShapeError('ashby', 'job record missing required fields', parsed.error.flatten());
    }
    const job = parsed.data;

    const descriptionHtml = job.descriptionHtml ?? null;
    // Ashby ships pre-rendered plain text alongside the HTML - prefer it and
    // fall back to stripping tags only when it is absent.
    const descriptionText = job.descriptionPlain ?? (descriptionHtml ? htmlToText(descriptionHtml) : null);

    const secondaryLocationNames = (job.secondaryLocations ?? [])
      .map((l) => l.location)
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

    const rawLocations = [
      ...(job.location ? [job.location] : []),
      ...secondaryLocationNames,
      ...(job.isRemote && !job.location ? ['Remote'] : []),
    ];

    const locations = parseLocations(rawLocations);

    const department = job.department ?? job.team ?? null;

    // includeCompensation=true returns a tier summary; the first component is
    // the primary range. Absent entirely on a board that has not configured
    // compensation transparency - null, not a guess, in that case.
    const tier = job.compensation?.summaryComponents?.[0];

    const updatedAt = job.updatedAt ?? job.publishedAt ?? null;
    const sourceUpdatedAt = updatedAt ? new Date(updatedAt) : null;

    return {
      sourceJobId: job.id,
      canonicalTitle: job.title.trim(),
      normalizedTitle: normalizeTitle(job.title),
      seniority: detectSeniority(job.title),
      employmentType: job.employmentType ?? null,
      department,
      applyUrl: job.applyUrl ?? job.jobUrl,
      contentFingerprint: contentFingerprint({
        title: job.title,
        descriptionText,
        locations: rawLocations,
      }),
      descriptionText,
      descriptionHtml,
      salaryMin: tier?.minValue ?? null,
      salaryMax: tier?.maxValue ?? null,
      salaryCurrency: tier?.currencyCode ?? null,
      sourceUpdatedAt: sourceUpdatedAt && !Number.isNaN(sourceUpdatedAt.getTime()) ? sourceUpdatedAt : null,
      locations,
    };
  },
};
