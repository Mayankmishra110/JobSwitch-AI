import { z } from 'zod';
import type { AccountId, UserId } from './ids.js';

/**
 * Identity and tenancy domain types.
 *
 * The account/user split is ADR D-17: tenant scoping is always on AccountId,
 * never UserId, so that organizations can be introduced later without any
 * user-owned table changing shape. At MVP every user has exactly one personal
 * account and one membership row with role `owner`.
 */

export type AccountType = 'personal' | 'organization';
export type MemberRole = 'owner' | 'admin' | 'member';

export interface Account {
  id: AccountId;
  type: AccountType;
  displayName: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface User {
  id: UserId;
  email: string;
  emailNormalized: string;
  emailVerifiedAt: Date | null;
  fullName: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface AccountMembership {
  accountId: AccountId;
  userId: UserId;
  role: MemberRole;
  createdAt: Date;
}

/** The authenticated principal attached to a request. */
export interface Principal {
  userId: UserId;
  accountId: AccountId;
  role: MemberRole;
  sessionId: string;
}

/**
 * Email normalization used for uniqueness and lookup.
 *
 * Lowercase and trim only. We deliberately do NOT strip dots or +suffixes:
 * those are provider-specific conventions, and treating a+b@gmail.com as
 * a@gmail.com would let one person's signup collide with another's on
 * providers that treat them as distinct addresses.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const emailSchema = z
  .string()
  .trim()
  .min(3, 'Enter an email address.')
  .max(254, 'That email address is too long.')
  .email('Enter a valid email address.');

/**
 * Password policy: length over composition rules.
 *
 * Composition requirements (one uppercase, one symbol...) measurably push
 * people toward predictable patterns. Length plus a breach check is the
 * modern guidance; the breach check is a V1 addition.
 */
const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(512, 'That password is too long.');

export const signupInput = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(1).max(120).optional(),
});

export const loginInput = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.').max(512),
});

export const requestPasswordResetInput = z.object({ email: emailSchema });

export const confirmPasswordResetInput = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export type SignupInput = z.infer<typeof signupInput>;
export type LoginInput = z.infer<typeof loginInput>;
export type RequestPasswordResetInput = z.infer<
  typeof requestPasswordResetInput
>;
export type ConfirmPasswordResetInput = z.infer<
  typeof confirmPasswordResetInput
>;
