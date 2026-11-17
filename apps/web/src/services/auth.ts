import {
  type AccountId,
  Errors,
  type Principal,
  type User,
  type UserId,
  normalizeEmail,
} from '@jobswitch/core';
import {
  auditRepo,
  identityRepo,
  sessionRepo,
  withAccount,
  withoutTenantContext,
  type Pool,
} from '@jobswitch/db';
import type { Config } from '../config.js';
import type { AIClient } from './aiClient.js';
import type { EventBus } from './events.js';
import type { Mailer } from './mailer.js';
import type { TailorHttpClient } from './tailorClient.js';
import {
  equalizeTiming,
  hashPassword,
  verifyPassword,
} from './password.js';

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuthDeps {
  pool: Pool;
  config: Config;
  mailer: Mailer;
  events: EventBus;
  aiClient: AIClient;
  tailorClient: TailorHttpClient;
}

export interface SignedInSession {
  token: string;
  expiresAt: Date;
  principal: Principal;
}

/**
 * Write an audit entry inside the tenant context.
 *
 * Deliberately best-effort: an audit write must never be the reason a user
 * cannot sign in. The failure is logged by the caller, not raised.
 */
async function audit(
  deps: AuthDeps,
  accountId: AccountId,
  entry: Parameters<typeof auditRepo.writeAuditEntry>[1],
): Promise<void> {
  await withAccount(deps.pool, accountId, (tx) =>
    auditRepo.writeAuditEntry(tx, entry),
  );
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

export async function signup(
  deps: AuthDeps,
  input: { email: string; password: string; fullName?: string | undefined },
  meta: RequestMeta,
): Promise<SignedInSession> {
  const passwordHash = await hashPassword(input.password);

  const created = await withoutTenantContext(deps.pool, async (tx) => {
    const existing = await identityRepo.findUserByEmail(tx, input.email);
    if (existing) {
      // Signup does reveal that an address is taken - it has to, or the user
      // cannot be told why their signup failed. Login and password reset,
      // where the attacker chooses the address, stay non-revealing.
      throw Errors.conflict('An account with that email already exists.');
    }

    const { user, accountId } = await identityRepo.createUserWithAccount(tx, {
      email: input.email,
      fullName: input.fullName ?? null,
    });
    await identityRepo.setPasswordHash(tx, user.id, passwordHash);

    const session = await sessionRepo.createSession(tx, {
      userId: user.id,
      accountId,
      ttlSeconds: deps.config.SESSION_TTL_SECONDS,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return { user, accountId, session };
  });

  await audit(deps, created.accountId, {
    accountId: created.accountId,
    actorUserId: created.user.id,
    action: 'user.signed_up',
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent ?? null,
  });

  return {
    token: created.session.token,
    expiresAt: created.session.expiresAt,
    principal: {
      userId: created.user.id,
      accountId: created.accountId,
      role: 'owner',
      sessionId: created.session.sessionId,
    },
  };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function login(
  deps: AuthDeps,
  input: { email: string; password: string },
  meta: RequestMeta,
): Promise<SignedInSession> {
  const result = await withoutTenantContext(deps.pool, async (tx) => {
    const user = await identityRepo.findUserByEmail(tx, input.email);

    if (!user) {
      // Spend the same time as a real verification before failing, so response
      // latency does not disclose whether the account exists.
      await equalizeTiming();
      throw Errors.invalidCredentials();
    }

    const storedHash = await identityRepo.getPasswordHash(tx, user.id);
    if (!storedHash) {
      // An OAuth-only user has no password. Same generic failure, same timing.
      await equalizeTiming();
      throw Errors.invalidCredentials();
    }

    const ok = await verifyPassword(storedHash, input.password);
    if (!ok) {
      return { failed: true as const, user };
    }

    const membership = await identityRepo.findPrimaryMembership(tx, user.id);
    if (!membership) {
      // A user with no account is a broken invariant, not a credential
      // problem. Surface it as an internal error so it gets investigated
      // rather than silently read as a wrong password.
      throw Errors.internal(
        new Error(`user ${user.id} has no account membership`),
      );
    }

    const session = await sessionRepo.createSession(tx, {
      userId: user.id,
      accountId: membership.accountId,
      ttlSeconds: deps.config.SESSION_TTL_SECONDS,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return { failed: false as const, user, membership, session };
  });

  if (result.failed) {
    const membership = await withoutTenantContext(deps.pool, (tx) =>
      identityRepo.findPrimaryMembership(tx, result.user.id),
    );
    if (membership) {
      await audit(deps, membership.accountId, {
        accountId: membership.accountId,
        actorUserId: result.user.id,
        action: 'user.sign_in_failed',
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
    }
    throw Errors.invalidCredentials();
  }

  await audit(deps, result.membership.accountId, {
    accountId: result.membership.accountId,
    actorUserId: result.user.id,
    action: 'user.signed_in',
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent ?? null,
  });

  return {
    token: result.session.token,
    expiresAt: result.session.expiresAt,
    principal: {
      userId: result.user.id,
      accountId: result.membership.accountId,
      role: result.membership.role,
      sessionId: result.session.sessionId,
    },
  };
}

// ---------------------------------------------------------------------------
// Session resolution and logout
// ---------------------------------------------------------------------------

export async function resolveSession(
  deps: AuthDeps,
  rawToken: string,
): Promise<Principal | null> {
  const record = await withoutTenantContext(deps.pool, async (tx) => {
    const found = await sessionRepo.findSessionByToken(tx, rawToken);
    if (found) await sessionRepo.touchSession(tx, found.id);
    return found;
  });

  if (!record) return null;

  return {
    userId: record.userId,
    accountId: record.accountId,
    role: record.role,
    sessionId: record.id,
  };
}

export async function logout(
  deps: AuthDeps,
  principal: Principal,
  meta: RequestMeta,
): Promise<void> {
  await withoutTenantContext(deps.pool, (tx) =>
    sessionRepo.revokeSession(tx, principal.sessionId),
  );
  await audit(deps, principal.accountId, {
    accountId: principal.accountId,
    actorUserId: principal.userId,
    action: 'user.signed_out',
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent ?? null,
  });
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/**
 * Request a reset link.
 *
 * Always resolves, whether or not the address has an account. Returning "no
 * such user" here would turn this unauthenticated endpoint into an
 * account-existence oracle for any address an attacker cares to try.
 */
export async function requestPasswordReset(
  deps: AuthDeps,
  input: { email: string },
  meta: RequestMeta,
): Promise<void> {
  const issued = await withoutTenantContext(deps.pool, async (tx) => {
    const user = await identityRepo.findUserByEmail(tx, input.email);
    if (!user) return null;

    const token = await sessionRepo.createPasswordResetToken(tx, {
      userId: user.id,
      ttlSeconds: deps.config.PASSWORD_RESET_TTL_SECONDS,
      ipAddress: meta.ipAddress ?? null,
    });
    const membership = await identityRepo.findPrimaryMembership(tx, user.id);
    return { user, token, membership };
  });

  if (!issued) return;

  const url = new URL('/reset-password', deps.config.APP_ORIGIN);
  url.searchParams.set('token', issued.token.token);

  await deps.mailer.send({
    to: issued.user.email,
    // Neutral subject on purpose. Most users are job hunting while employed,
    // and a subject line naming the product could expose that on a lock screen
    // or a shared machine (PRD §30).
    subject: 'Your password reset link',
    text:
      `Use this link to set a new password:\n\n${url.toString()}\n\n` +
      `The link expires in ${Math.round(
        deps.config.PASSWORD_RESET_TTL_SECONDS / 60,
      )} minutes. ` +
      `If you did not request it, you can ignore this message.`,
  });

  if (issued.membership) {
    await audit(deps, issued.membership.accountId, {
      accountId: issued.membership.accountId,
      actorUserId: issued.user.id,
      action: 'password.reset_requested',
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }
}

export async function confirmPasswordReset(
  deps: AuthDeps,
  input: { token: string; password: string },
  meta: RequestMeta,
): Promise<{ userId: UserId; accountId: AccountId | null }> {
  const passwordHash = await hashPassword(input.password);

  const result = await withoutTenantContext(deps.pool, async (tx) => {
    const lookup = await sessionRepo.findPasswordResetToken(tx, input.token);
    if (lookup.status === 'expired') throw Errors.tokenExpired();
    if (lookup.status === 'invalid') throw Errors.tokenInvalid();

    const consumed = await sessionRepo.consumePasswordResetToken(
      tx,
      lookup.tokenId,
    );
    // Lost a race with a concurrent request using the same token.
    if (!consumed) throw Errors.tokenInvalid();

    await identityRepo.setPasswordHash(tx, lookup.userId, passwordHash);

    // Every existing session dies. If the reset was prompted by a suspected
    // compromise, leaving the attacker's session alive would defeat the point.
    await sessionRepo.revokeAllSessionsForUser(tx, lookup.userId);

    const membership = await identityRepo.findPrimaryMembership(
      tx,
      lookup.userId,
    );
    return { userId: lookup.userId, accountId: membership?.accountId ?? null };
  });

  if (result.accountId) {
    await audit(deps, result.accountId, {
      accountId: result.accountId,
      actorUserId: result.userId,
      action: 'password.reset_completed',
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// OAuth account resolution
// ---------------------------------------------------------------------------

/**
 * Find or create the user behind a verified Google identity.
 *
 * Linking by email is only safe because Google asserts `email_verified`; the
 * caller checks it. Linking an unverified third-party email to an existing
 * local account would be an account-takeover primitive - anyone able to create
 * a Google account claiming an address could seize the matching account here.
 */
export async function upsertOauthUser(
  deps: AuthDeps,
  profile: {
    provider: 'google';
    providerUserId: string;
    email: string;
    fullName: string | null;
  },
  meta: RequestMeta,
): Promise<SignedInSession> {
  const outcome = await withoutTenantContext(deps.pool, async (tx) => {
    let user: User | null = await identityRepo.findUserByOauthIdentity(
      tx,
      profile.provider,
      profile.providerUserId,
    );

    if (!user) {
      const byEmail = await identityRepo.findUserByEmail(tx, profile.email);
      if (byEmail) {
        user = byEmail;
        await identityRepo.linkOauthIdentity(tx, {
          userId: user.id,
          provider: profile.provider,
          providerUserId: profile.providerUserId,
          emailAtLink: normalizeEmail(profile.email),
        });
      } else {
        const created = await identityRepo.createUserWithAccount(tx, {
          email: profile.email,
          fullName: profile.fullName,
          emailVerified: true,
        });
        user = created.user;
        await identityRepo.linkOauthIdentity(tx, {
          userId: user.id,
          provider: profile.provider,
          providerUserId: profile.providerUserId,
          emailAtLink: normalizeEmail(profile.email),
        });
      }
    }

    const membership = await identityRepo.findPrimaryMembership(tx, user.id);
    if (!membership) {
      throw Errors.internal(
        new Error(`oauth user ${user.id} has no account membership`),
      );
    }

    const session = await sessionRepo.createSession(tx, {
      userId: user.id,
      accountId: membership.accountId,
      ttlSeconds: deps.config.SESSION_TTL_SECONDS,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return { user, membership, session };
  });

  await audit(deps, outcome.membership.accountId, {
    accountId: outcome.membership.accountId,
    actorUserId: outcome.user.id,
    action: 'user.signed_in_oauth',
    metadata: { provider: profile.provider },
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent ?? null,
  });

  return {
    token: outcome.session.token,
    expiresAt: outcome.session.expiresAt,
    principal: {
      userId: outcome.user.id,
      accountId: outcome.membership.accountId,
      role: outcome.membership.role,
      sessionId: outcome.session.sessionId,
    },
  };
}
