import { z } from 'zod';

/**
 * Environment configuration, validated at boot.
 *
 * The process refuses to start on invalid config rather than failing on the
 * first request that happens to need it. A missing SESSION_SECRET discovered
 * at 3am under load is a much worse outcome than a container that will not
 * start.
 */

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: booleanish.default('false'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  /**
   * The user-facing origin - apps/dashboard's own origin, not this
   * process's. Used to build the password-reset link emailed to a
   * candidate (services/auth.ts) and the Gmail-link callback's final
   * redirect (routes/outreach.ts), both of which land on real dashboard
   * pages (/reset-password, /profile) that only exist in apps/dashboard.
   * In the eventual Traefik-routed shape (D-29, not yet deployed) this
   * and apps/web's own origin become the same value; until then, point
   * it at wherever apps/dashboard is actually reachable.
   */
  APP_ORIGIN: z.string().url().default('http://localhost:3001'),

  /**
   * At least 32 chars. Used to sign cookies. Rotating it logs everyone out,
   * which is the intended behaviour after a suspected compromise.
   */
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .default(60 * 60 * 24 * 14),
  SESSION_COOKIE_NAME: z.string().default('js_session'),

  PASSWORD_RESET_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .default(60 * 60),

  /**
   * Google OAuth is optional. All three must be present or sign-in with Google
   * is disabled and the routes return 404 - a half-configured OAuth flow that
   * fails at the callback is worse than one that is visibly off.
   */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  /**
   * Gmail send (Phase 7 outreach, Phase 8 notification email) reuses
   * GOOGLE_CLIENT_ID/SECRET above (one Google Cloud OAuth client can
   * authorize more than one redirect URI) but needs its own redirect URI
   * (a different consent screen: gmail.send scope, not sign-in) and its own
   * encryption key for the refresh token at rest (email_credential,
   * migration 0017). Same "half-configured is worse than visibly off"
   * rule: /api/v1/outreach/gmail/authorize 404s (oauth_disabled) unless all
   * three of GOOGLE_CLIENT_ID/SECRET and this redirect URI, plus the
   * encryption key, are present. No real Google credentials exist for this
   * build yet (see docs/BUILD_PLAN.md Phase 8) - this code path is
   * deliberately unverified end to end for that reason, same disclosure as
   * google-oauth.ts's own NOTE ON VERIFICATION.
   */
  GOOGLE_GMAIL_REDIRECT_URI: z.string().url().optional(),
  EMAIL_CREDENTIAL_ENCRYPTION_KEY: z.string().min(32).optional(),

  /**
   * Internal-service auth (mirrors services/ai's/apps/tailor's own
   * require_internal_token / INTERNAL_TOKEN check exactly): unset skips the
   * header entirely (local dev, and every test in this suite, which run
   * both of those services with no token configured either); set, every
   * call this process makes to either service carries X-Internal-Token.
   */
  INTERNAL_TOKEN: z.string().optional(),
  AI_SERVICE_URL: z.string().url().default('http://127.0.0.1:8100'),
  TAILOR_SERVICE_URL: z.string().url().default('http://127.0.0.1:8200'),

  /**
   * Phase 8's event-triggered notification email
   * (services/notifications.ts) is new standing background behavior - a
   * process-wide, cross-account NATS subscription running for the life of
   * the server - not a per-request code path, so it needs its own
   * explicit opt-in rather than silently starting whenever a NATS server
   * happens to be reachable. Off by default, same reasoning MAIL_TRANSPORT
   * and GOOGLE_* already follow.
   */
  NOTIFICATIONS_ENABLED: booleanish.default('false'),

  /**
   * `log` writes emails to stdout - correct for Phase 1, where a real provider
   * is not wired up until Phase 8. Being explicit stops "password reset does
   * nothing" from looking like a bug.
   */
  MAIL_TRANSPORT: z.enum(['log', 'noop']).default('log'),

  TRUST_PROXY: booleanish.default('false'),

  /**
   * D-26's event bus. Connected lazily (see services/events.ts) - a
   * process that never publishes or subscribes (most routes; most tests)
   * never opens this connection at all, so NATS being down doesn't break
   * anything that doesn't actually touch the event bus.
   */
  NATS_URL: z.string().default('nats://127.0.0.1:4222'),

  /**
   * Rate limiting is on everywhere except where a test needs to exercise a
   * route more often than a human would. Tests that care about the limits set
   * this true explicitly and assert on them (see test/rate-limit.test.ts) -
   * so switching it off for the rest does not leave the behaviour unverified.
   */
  RATE_LIMIT_ENABLED: booleanish.default('true'),
});

export type Config = Omit<z.infer<typeof schema>, 'GOOGLE_CLIENT_ID'> & {
  google:
    | { enabled: true; clientId: string; clientSecret: string; redirectUri: string }
    | { enabled: false };
  gmail:
    | {
        enabled: true;
        clientId: string;
        clientSecret: string;
        redirectUri: string;
        encryptionKey: string;
      }
    | { enabled: false };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const c = parsed.data;
  const googleConfigured =
    Boolean(c.GOOGLE_CLIENT_ID) &&
    Boolean(c.GOOGLE_CLIENT_SECRET) &&
    Boolean(c.GOOGLE_REDIRECT_URI);

  const gmailConfigured =
    Boolean(c.GOOGLE_CLIENT_ID) &&
    Boolean(c.GOOGLE_CLIENT_SECRET) &&
    Boolean(c.GOOGLE_GMAIL_REDIRECT_URI) &&
    Boolean(c.EMAIL_CREDENTIAL_ENCRYPTION_KEY);

  return {
    ...c,
    google: googleConfigured
      ? {
          enabled: true,
          clientId: c.GOOGLE_CLIENT_ID as string,
          clientSecret: c.GOOGLE_CLIENT_SECRET as string,
          redirectUri: c.GOOGLE_REDIRECT_URI as string,
        }
      : { enabled: false },
    gmail: gmailConfigured
      ? {
          enabled: true,
          clientId: c.GOOGLE_CLIENT_ID as string,
          clientSecret: c.GOOGLE_CLIENT_SECRET as string,
          redirectUri: c.GOOGLE_GMAIL_REDIRECT_URI as string,
          encryptionKey: c.EMAIL_CREDENTIAL_ENCRYPTION_KEY as string,
        }
      : { enabled: false },
  };
}

export function isProduction(config: Config): boolean {
  return config.NODE_ENV === 'production';
}

/**
 * Build a route-level rate-limit config.
 *
 * Returns an empty config when limiting is disabled, so the route registers
 * without a limit rather than with a fake enormous one.
 */
export function rateLimitFor(
  config: Config,
  limits: { max: number; timeWindow: string },
): { rateLimit?: { max: number; timeWindow: string } } {
  return config.RATE_LIMIT_ENABLED ? { rateLimit: limits } : {};
}
