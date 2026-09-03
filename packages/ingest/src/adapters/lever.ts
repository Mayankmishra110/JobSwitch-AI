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
 * Lever job board adapter.
 *
 * Uses Lever's public postings API, published for exactly this purpose: no
 * authentication, no pagination - one request returns every open posting.
 *
 *   GET https://api.lever.co/v0/postings/{site}?mode=json
 *
 * ─────────────────────────────────────────────────────────────────────────
 * VERIFICATION STATUS: the field mapping below is written from Lever's
 * documented response shape and has NOT been checked against a live board -
 * this environment blocks all outbound hosts. The fixture in test/fixtures
 * is hand-constructed, not captured.
 *
 * Before trusting this in production, run:
 *
 *     pnpm --filter @jobswitch/ingest capture -- lever <site-token>
 *
 * which writes a real response into test/fixtures and lets the golden test
 * compare against it. Treat the first real run as the actual verification.
 * ─────────────────────────────────────────────────────────────────────────
 */

const BASE_URL = 'https://api.lever.co/v0/postings';

/**
 * Strict on the fields we depend on, permissive elsewhere - same asymmetry as
 * Greenhouse: a field Lever adds never breaks ingestion, one it renames does.
 */
const leverPosting = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    hostedUrl: z.string().url(),
    applyUrl: z.string().url().optional().nullable(),
    createdAt: z.union([z.number(), z.string()]).optional().nullable(),
    workplaceType: z.string().optional().nullable(),
    country: z.string().optional().nullable(),
    categories: z
      .object({
        team: z.string().optional().nullable(),
        department: z.string().optional().nullable(),
        location: z.string().optional().nullable(),
        allLocations: z.array(z.string()).optional().nullable(),
        commitment: z.string().optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
    content: z
      .object({
        description: z.string().optional().nullable(),
        descriptionHtml: z.string().optional().nullable(),
        lists: z
          .array(z.object({ text: z.string().optional(), content: z.string().optional() }).passthrough())
          .optional()
          .nullable(),
        closing: z.string().optional().nullable(),
        closingHtml: z.string().optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
  })
  .passthrough();

export type LeverPosting = z.infer<typeof leverPosting>;

// Lever's wire response is a bare array - no envelope, unlike Greenhouse.
const leverResponse = z.array(z.unknown());

const BOARD_URL_PATTERNS = [
  /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i,
  /api\.lever\.co\/v0\/postings\/([a-z0-9_-]+)/i,
];

export const leverAdapter: AtsAdapter = {
  atsType: 'lever',

  capabilities: {
    structuredLocation: true,
    // No salary field on the public postings API. Phase 5 territory, same as
    // Greenhouse - claiming otherwise here would make the matcher trust a
    // value that is always null.
    structuredSalary: false,
    department: true,
    directApplyUrl: true,
    autofillable: true,
  },

  detect(careerUrl: string): DetectResult | null {
    for (const re of BOARD_URL_PATTERNS) {
      const match = re.exec(careerUrl);
      if (match?.[1]) {
        return { atsType: 'lever', boardIdentifier: match[1].toLowerCase() };
      }
    }
    return null;
  },

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    // mode=json is required - without it Lever serves an HTML career page.
    const url = `${BASE_URL}/${encodeURIComponent(ctx.boardIdentifier)}?mode=json`;

    const response = await ctx.fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'user-agent': ctx.userAgent,
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    if (!response.ok) {
      throw new AdapterHttpError(
        'lever',
        response.status,
        response.status === 404
          ? `site "${ctx.boardIdentifier}" not found - the token is wrong or the board was removed`
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
      throw new AdapterShapeError('lever', 'response was not JSON', error);
    }

    const parsed = leverResponse.safeParse(body);
    if (!parsed.success) {
      throw new AdapterShapeError(
        'lever',
        'response was not the expected array of postings',
        parsed.error.flatten(),
      );
    }

    return { raw: parsed.data, httpStatus: response.status };
  },

  normalize(raw: unknown): NormalizedPostingInput {
    const parsed = leverPosting.safeParse(raw);
    if (!parsed.success) {
      throw new AdapterShapeError(
        'lever',
        'posting record missing required fields',
        parsed.error.flatten(),
      );
    }
    const posting = parsed.data;

    // Lever's HTML is not double-escaped like Greenhouse's - it is ordinary
    // HTML. htmlToText's second decode pass is a no-op here, which is fine.
    const sections = [
      posting.content?.descriptionHtml ?? posting.content?.description ?? null,
      ...(posting.content?.lists ?? []).map((l) => l.content ?? null),
      posting.content?.closingHtml ?? posting.content?.closing ?? null,
    ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0);

    const descriptionHtml = sections.length > 0 ? sections.join('\n') : null;
    const descriptionText = descriptionHtml ? htmlToText(descriptionHtml) : null;

    const rawLocations =
      posting.categories?.allLocations && posting.categories.allLocations.length > 0
        ? posting.categories.allLocations
        : posting.categories?.location
          ? [posting.categories.location]
          : posting.workplaceType?.toLowerCase() === 'remote'
            ? ['Remote']
            : [];

    const locations = parseLocations(rawLocations);

    const department = posting.categories?.department ?? posting.categories?.team ?? null;

    const createdAt =
      posting.createdAt === undefined || posting.createdAt === null
        ? null
        : new Date(
            typeof posting.createdAt === 'number' ? posting.createdAt : Number(posting.createdAt),
          );

    return {
      sourceJobId: posting.id,
      canonicalTitle: posting.text.trim(),
      normalizedTitle: normalizeTitle(posting.text),
      seniority: detectSeniority(posting.text),
      employmentType: posting.categories?.commitment ?? null,
      department,
      applyUrl: posting.applyUrl ?? posting.hostedUrl,
      contentFingerprint: contentFingerprint({
        title: posting.text,
        descriptionText,
        locations: rawLocations,
      }),
      descriptionText,
      descriptionHtml,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      sourceUpdatedAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
      locations,
    };
  },
};
