/**
 * Application errors.
 *
 * Every error carries an HTTP status and a stable machine-readable code so
 * the HTTP layer never has to guess, and a `safeMessage` that is explicitly
 * cleared for display to an end user. Anything not in `safeMessage` stays in
 * logs.
 */

export type ErrorCode =
  | 'validation_failed'
  | 'invalid_credentials'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'token_invalid'
  | 'token_expired'
  | 'oauth_disabled'
  | 'oauth_failed'
  | 'internal';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly safeMessage: string;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    status: number,
    safeMessage: string,
    options?: { cause?: unknown; details?: unknown; internalMessage?: string },
  ) {
    super(options?.internalMessage ?? safeMessage, { cause: options?.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.safeMessage = safeMessage;
    this.details = options?.details;
  }
}

export const Errors = {
  validation: (details?: unknown) =>
    new AppError('validation_failed', 400, 'Some fields need attention.', {
      details,
    }),

  /**
   * Deliberately identical for "no such email" and "wrong password".
   * Distinguishing them turns the login form into an account-existence
   * oracle, and for this product the existence of an account is itself
   * sensitive - it reveals that someone is job hunting (PRD §30).
   */
  invalidCredentials: () =>
    new AppError(
      'invalid_credentials',
      401,
      'That email and password combination did not match.',
    ),

  unauthenticated: () =>
    new AppError('unauthenticated', 401, 'Please sign in to continue.'),

  forbidden: () =>
    new AppError('forbidden', 403, 'You do not have access to that.'),

  notFound: (what = 'That') =>
    new AppError('not_found', 404, `${what} could not be found.`),

  conflict: (message: string) => new AppError('conflict', 409, message),

  rateLimited: () =>
    new AppError(
      'rate_limited',
      429,
      'Too many attempts. Please wait a moment and try again.',
    ),

  tokenInvalid: () =>
    new AppError(
      'token_invalid',
      400,
      'That link is not valid. Request a new one.',
    ),

  tokenExpired: () =>
    new AppError(
      'token_expired',
      400,
      'That link has expired. Request a new one.',
    ),

  oauthDisabled: () =>
    new AppError(
      'oauth_disabled',
      404,
      'Google sign-in is not enabled on this deployment.',
    ),

  oauthFailed: (internalMessage: string) =>
    new AppError('oauth_failed', 400, 'Google sign-in could not be completed.', {
      internalMessage,
    }),

  internal: (cause?: unknown) =>
    new AppError('internal', 500, 'Something went wrong on our end.', {
      cause,
    }),
};
