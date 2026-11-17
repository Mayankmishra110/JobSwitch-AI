import type { Config } from '../config.js';

/**
 * HTTP client for apps/tailor's /v1/reinject and /v1/compile - the human-
 * approval step's own splice+compile, run AFTER a candidate has picked
 * which of Graph A's proposed_changes to keep (routes/artifacts.ts's
 * compile handler). Deliberately synchronous, not routed through
 * services/ai/Graph A again: reinject+compile is "deterministic execution
 * with no decision point" (docs/BUILD_PLAN.md's own framing for why
 * compilation isn't a graph node), so calling apps/tailor directly here is
 * the same boundary Graph A's own apply_splice already uses one layer up.
 */

export class TailorClientError extends Error {}

export interface ReinjectResult {
  tex: string;
  applied: string[];
  skipped: string[];
  integrityOk: boolean;
  integrityViolations?: unknown[];
}

export interface TailorHttpClient {
  reinject(tex: string, accepted: Array<{ field: string; rewritten: string }>): Promise<ReinjectResult>;
  compile(tex: string): Promise<{ pdfBytes: Buffer; pdfSha256: string }>;
}

interface CompileErrorBody {
  error: string;
  message: string;
  log: string;
}

export function createTailorClient(config: Config, fetchImpl: typeof fetch = fetch): TailorHttpClient {
  const headers = {
    'content-type': 'application/json',
    ...(config.INTERNAL_TOKEN ? { 'x-internal-token': config.INTERNAL_TOKEN } : {}),
  };

  return {
    async reinject(tex, accepted) {
      const response = await fetchImpl(`${config.TAILOR_SERVICE_URL}/v1/reinject`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tex, accepted }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable>');
        throw new TailorClientError(`apps/tailor /v1/reinject returned ${response.status}: ${body.slice(0, 500)}`);
      }
      const parsed = (await response.json()) as {
        tex: string;
        applied: string[];
        skipped: string[];
        integrityOk: boolean;
        integrityViolations?: unknown[];
      };
      return parsed;
    },

    async compile(tex) {
      const response = await fetchImpl(`${config.TAILOR_SERVICE_URL}/v1/compile`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tex }),
      });
      if (response.status === 422) {
        const body = (await response.json()) as CompileErrorBody;
        // 422 is a real, expected outcome (a malformed edit slipped past
        // upstream checks) - surfaced with the compiler's own log rather
        // than collapsed into a generic error, same as apps/tailor's own
        // compile route intends for its callers.
        throw new TailorClientError(`compile failed: ${body.message}\n${body.log}`);
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable>');
        throw new TailorClientError(`apps/tailor /v1/compile returned ${response.status}: ${body.slice(0, 500)}`);
      }
      const pdfSha256 = response.headers.get('x-pdf-sha256');
      if (!pdfSha256) throw new TailorClientError('apps/tailor /v1/compile response missing X-Pdf-Sha256');
      const arrayBuffer = await response.arrayBuffer();
      return { pdfBytes: Buffer.from(arrayBuffer), pdfSha256 };
    },
  };
}
