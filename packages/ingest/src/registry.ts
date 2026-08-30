import type { AtsAdapter } from './adapter.js';
import { greenhouseAdapter } from './adapters/greenhouse.js';

/**
 * The adapter registry.
 *
 * Adding an ATS is one file plus one line here (ADR D-01). Lever and Ashby
 * land in Phase 3; SmartRecruiters, Workable and Workday in V1.
 */
const ADAPTERS: AtsAdapter[] = [greenhouseAdapter];

const BY_TYPE = new Map(ADAPTERS.map((a) => [a.atsType, a]));

export function getAdapter(atsType: string): AtsAdapter | null {
  return BY_TYPE.get(atsType) ?? null;
}

export function requireAdapter(atsType: string): AtsAdapter {
  const adapter = getAdapter(atsType);
  if (!adapter) {
    throw new Error(
      `No adapter registered for ATS type "${atsType}". ` +
        `Registered: ${[...BY_TYPE.keys()].join(', ') || '(none)'}`,
    );
  }
  return adapter;
}

/**
 * Identify the platform behind a careers URL.
 *
 * Phase 2 uses this only for seeding. In V2 it becomes the core of the company
 * discovery subsystem (ADR §6).
 */
export function detectAdapter(careerUrl: string) {
  for (const adapter of ADAPTERS) {
    const result = adapter.detect(careerUrl);
    if (result) return result;
  }
  return null;
}

export function registeredAdapters(): AtsAdapter[] {
  return [...ADAPTERS];
}
