/**
 * Branded id types.
 *
 * These exist so that an AccountId can never be passed where a UserId is
 * expected. That distinction matters more here than in most codebases:
 * tenant scoping is on AccountId (ADR D-17), and the single most damaging
 * bug this system could have is scoping a query by the wrong identifier.
 */

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type AccountId = Brand<string, 'AccountId'>;
export type UserId = Brand<string, 'UserId'>;
export type SessionId = Brand<string, 'SessionId'>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function toId<T extends string>(value: string, label: string): T {
  if (!isUuid(value)) {
    throw new TypeError(`Invalid ${label}: not a UUID`);
  }
  return value as T;
}

export const AccountId = (value: string): AccountId =>
  toId<AccountId>(value, 'AccountId');
export const UserId = (value: string): UserId => toId<UserId>(value, 'UserId');
export const SessionId = (value: string): SessionId =>
  toId<SessionId>(value, 'SessionId');
