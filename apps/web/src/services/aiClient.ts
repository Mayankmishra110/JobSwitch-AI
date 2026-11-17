import type { CandidateFact, ProposedEdit, TailorFlag } from '@jobswitch/core';
import type { Config } from '../config.js';

/**
 * HTTP client for services/ai's /v1/tailor/resume (Graph A) - the one call
 * this process makes to that service. Mirrors
 * services/backend/internal/clients/ai.go's own shape and error handling
 * (plain error, no distinguishing 503-vs-502 here either - the caller,
 * routes/applications.ts, treats any failure the same way: record the
 * artifact as 'failed' and let the candidate retry).
 */

export class AIClientError extends Error {}

export interface JobContext {
  title: string;
  company?: string | null;
  description: string;
}

export type TailorStatus = 'proposed' | 'unchanged';

export interface TailorResult {
  status: TailorStatus;
  tex: string;
  proposedChanges: ProposedEdit[];
  flags: TailorFlag[];
  model: string;
  promptVersion: number;
}

interface TailorResponseBody {
  status: TailorStatus;
  tex: string;
  proposed_changes: Array<{ field: string; rewritten: string; source_fact_refs: string[] }>;
  flags: Array<{ field: string; token: string; reason: 'new-entity' | 'new-metric'; rewritten: string }>;
  model: string;
  prompt_version: number;
}

export interface AIClient {
  tailorResume(input: { tex: string; job: JobContext; facts: CandidateFact[] }): Promise<TailorResult>;
}

export function createAIClient(config: Config, fetchImpl: typeof fetch = fetch): AIClient {
  return {
    async tailorResume({ tex, job, facts }) {
      const response = await fetchImpl(`${config.AI_SERVICE_URL}/v1/tailor/resume`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.INTERNAL_TOKEN ? { 'x-internal-token': config.INTERNAL_TOKEN } : {}),
        },
        body: JSON.stringify({ tex, job, facts }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable>');
        throw new AIClientError(`services/ai /v1/tailor/resume returned ${response.status}: ${body.slice(0, 500)}`);
      }

      const parsed = (await response.json()) as TailorResponseBody;
      return {
        status: parsed.status,
        tex: parsed.tex,
        proposedChanges: parsed.proposed_changes.map((c) => ({
          field: c.field,
          rewritten: c.rewritten,
          sourceFactRefs: c.source_fact_refs,
        })),
        flags: parsed.flags.map((f) => ({ field: f.field, token: f.token, reason: f.reason, rewritten: f.rewritten })),
        model: parsed.model,
        promptVersion: parsed.prompt_version,
      };
    },
  };
}
