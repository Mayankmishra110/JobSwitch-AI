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

  /** Public origin of the app, used to build links in emails. */
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),

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
   * `log` writes emails to stdout - correct for Phase 1, where a real provider
   * is not wired up until Phase 8. Being explicit stops "password reset does
   * nothing" from looking like a bug.
   */
  MAIL_TRANSPORT: z.enum(['log', 'noop']).default('log'),

  TRUST_PROXY: booleanish.default('false'),

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
