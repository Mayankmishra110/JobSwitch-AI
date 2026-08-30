import type { NormalizedPostingInput } from '@jobswitch/db';

/**
 * The ATS adapter contract (ADR D-01, §7).
 *
 * Adding an ATS is one file implementing this plus one registry line. The
 * pipeline never changes, which is the property that lets the index grow from
 * 300 companies to 5,000 without a redesign.
 */

export interface SourceCapabilities {
  structuredLocation: boolean;
  structuredSalary: boolean;
  department: boolean;
  directApplyUrl: boolean;
  /** Drives the §17 degradation rung the UI offers for this company. */
  autofillable: boolean;
}

export interface FetchContext {
  boardIdentifier: string;
  /** Injected so tests can drive an adapter from a fixture with no network. */
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  userAgent: string;
}

export interface FetchResult {
  /** Whatever the platform returned, still in its own shape. */
  raw: unknown[];
  httpStatus: number;
}

export interface DetectResult {
  atsType: string;
  boardIdentifier: string;
}

export interface AtsAdapter {
  readonly atsType: string;
  readonly capabilities: SourceCapabilities;

  /** Given a careers URL, is this the right adapter, and what is the board id? */
  detect(careerUrl: string): DetectResult | null;

  /** Fetch every posting, handling this platform's pagination. */
  fetch(ctx: FetchContext): Promise<FetchResult>;

  /**
   * Convert one raw record into the canonical shape.
   *
   * Pure - no I/O, no clock beyond what the record carries. That is what makes
   * a stored payload plus a golden output a complete test (ADR D-20).
   */
  normalize(raw: unknown): NormalizedPostingInput;
}

/**
 * Raised when a platform's response does not match what the adapter expects.
 *
 * Thrown rather than skipped on purpose. A shape change that silently yielded
 * zero postings would look identical to a company with no open roles, and the
 * index would quietly empty out. Failing marks the run failed, the source
 * degraded after three, and raises the alarm.
 */
export class AdapterShapeError extends Error {
  constructor(
    readonly atsType: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(`[${atsType}] ${message}`);
    this.name = 'AdapterShapeError';
  }
}

export class AdapterHttpError extends Error {
  constructor(
    readonly atsType: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super(`[${atsType}] HTTP ${httpStatus}: ${message}`);
    this.name = 'AdapterHttpError';
  }
}
