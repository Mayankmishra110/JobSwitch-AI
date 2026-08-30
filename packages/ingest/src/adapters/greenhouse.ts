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
 * Greenhouse job board adapter.
 *
 * Uses the public job board API, which Greenhouse publishes for exactly this
 * purpose: no authentication, no bot protection, no terms-of-service grey
 * area. That is why it is the first adapter (ADR §7 tier A).
 *
 *   GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 *
 * ─────────────────────────────────────────────────────────────────────────
 * VERIFICATION STATUS: the field mapping below is written from Greenhouse's
 * documented response shape and has NOT been checked against a live board -
 * the build environment blocks all outbound hosts. The fixture in
 * test/fixtures is therefore hand-constructed, not captured.
 *
 * Before trusting this in production, run:
 *
 *     pnpm --filter @jobswitch/ingest capture -- greenhouse <board-token>
 *
 * which writes a real response into test/fixtures and lets the golden test
 * compare against it. Treat the first real run as the actual verification.
 * ─────────────────────────────────────────────────────────────────────────
 */

const BASE_URL = 'https://boards-api.greenhouse.io/v1/boards';

/**
 * Strict on the fields we depend on, permissive elsewhere.
 *
 * `passthrough` means Greenhouse adding a field never breaks ingestion, while
 * removing or renaming `id`, `title` or `absolute_url` fails loudly. That
 * asymmetry is the point: additions are routine, removals are breakage.
 */
const greenhouseJob = z
  .object({
    id: z.union([z.number(), z.string()]),
    title: z.string().min(1),
    absolute_url: z.string().url(),
    updated_at: z.string().optional().nullable(),
    requisition_id: z.string().optional().nullable(),
    content: z.string().optional().nullable(),
    location: z.object({ name: z.string() }).partial().optional().nullable(),
    offices: z
      .array(
        z
          .object({ name: z.string().optional(), location: z.string().optional() })
          .passthrough(),
      )
      .optional()
      .nullable(),
    departments: z
      .array(z.object({ name: z.string().optional() }).passthrough())
      .optional()
      .nullable(),
    metadata: z.array(z.unknown()).optional().nullable(),
  })
  .passthrough();

const greenhouseResponse = z
  .object({
    jobs: z.array(z.unknown()),
    meta: z.object({ total: z.number().optional() }).partial().optional(),
  })
  .passthrough();

export type GreenhouseJob = z.infer<typeof greenhouseJob>;

const BOARD_URL_PATTERNS = [
  /boards\.greenhouse\.io\/([a-z0-9_-]+)/i,
  /job-boards\.greenhouse\.io\/([a-z0-9_-]+)/i,
  /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i,
];

export const greenhouseAdapter: AtsAdapter = {
  atsType: 'greenhouse',

  capabilities: {
    structuredLocation: true,
    // The board API exposes no salary field. Compensation, when present, is
    // prose inside the description - parsing it is a Phase 5 concern, and
    // claiming otherwise here would make the matcher trust a value that is
    // always null.
    structuredSalary: false,
    department: true,
    directApplyUrl: true,
    autofillable: true,
  },

  detect(careerUrl: string): DetectResult | null {
    for (const re of BOARD_URL_PATTERNS) {
      const match = re.exec(careerUrl);
      if (match?.[1]) {
        return { atsType: 'greenhouse', boardIdentifier: match[1].toLowerCase() };
      }
    }
    return null;
  },

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    // The board API returns every posting in one response - no pagination.
    // Adapters for platforms that do paginate loop here instead.
    const url = `${BASE_URL}/${encodeURIComponent(ctx.boardIdentifier)}/jobs?content=true`;

    const response = await ctx.fetchImpl(url, {
      headers: {
        accept: 'application/json',
        // Identify honestly with a contact route. Costs nothing and is the
        // difference between a good-faith consumer and an anonymous scraper
        // if anyone ever looks at their logs.
        'user-agent': ctx.userAgent,
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    if (!response.ok) {
      throw new AdapterHttpError(
        'greenhouse',
        response.status,
        response.status === 404
          ? `board "${ctx.boardIdentifier}" not found - the token is wrong or the board was removed`
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
      throw new AdapterShapeError('greenhouse', 'response was not JSON', error);
    }

    const parsed = greenhouseResponse.safeParse(body);
    if (!parsed.success) {
      throw new AdapterShapeError(
        'greenhouse',
        'response did not contain a jobs array',
        parsed.error.flatten(),
      );
    }

    return { raw: parsed.data.jobs, httpStatus: response.status };
  },

  normalize(raw: unknown): NormalizedPostingInput {
    const parsed = greenhouseJob.safeParse(raw);
    if (!parsed.success) {
      throw new AdapterShapeError(
        'greenhouse',
        'job record missing required fields',
        parsed.error.flatten(),
      );
    }
    const job = parsed.data;

    // The description is entity-escaped HTML. Decoding happens inside
    // htmlToText; skipping it leaves literal &lt;p&gt; in the text the matcher
    // reads.
    const descriptionHtml = job.content ?? null;
    const descriptionText = descriptionHtml ? htmlToText(descriptionHtml) : null;

    // Prefer offices, which can list several; fall back to the single location.
    const officeNames = (job.offices ?? [])
      .map((o) => o.location ?? o.name)
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

    const rawLocations =
      officeNames.length > 0
        ? officeNames
        : job.location?.name
          ? [job.location.name]
          : [];

    const locations = parseLocations(rawLocations);

    const department = (job.departments ?? [])
      .map((d) => d.name)
      .filter((v): v is string => typeof v === 'string')[0];

    const sourceUpdatedAt = job.updated_at ? new Date(job.updated_at) : null;

    return {
      // Greenhouse's numeric id, as text. requisition_id is deliberately NOT
      // used as identity: it is optional, customer-supplied, and not unique.
      sourceJobId: String(job.id),
      canonicalTitle: job.title.trim(),
      normalizedTitle: normalizeTitle(job.title),
      seniority: detectSeniority(job.title),
      employmentType: null,
      department: department ?? null,
      applyUrl: job.absolute_url,
      contentFingerprint: contentFingerprint({
        title: job.title,
        descriptionText,
        locations: rawLocations,
      }),
      descriptionText,
      descriptionHtml,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      sourceUpdatedAt:
        sourceUpdatedAt && !Number.isNaN(sourceUpdatedAt.getTime())
          ? sourceUpdatedAt
          : null,
      locations,
    };
  },
};
