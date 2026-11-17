import { z } from 'zod';

/**
 * Environment configuration, validated at boot - same rule as apps/web's
 * own config.ts: fail on an invalid environment at startup, not on the
 * first request that needed the missing value.
 */

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8200),
  HOST: z.string().default('0.0.0.0'),

  /** See src/auth.ts - unset means the internal-token check is skipped. */
  INTERNAL_TOKEN: z.string().optional(),

  /** pdflatex/xelatex only for now - see .env.example's own caveat on tectonic. */
  LATEX_ENGINE: z.enum(['pdflatex', 'xelatex']).default('pdflatex'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
