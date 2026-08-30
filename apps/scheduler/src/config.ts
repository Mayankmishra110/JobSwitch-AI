import { z } from 'zod';

/**
 * Scheduler configuration.
 *
 * Separate from the worker's rather than imported across app boundaries: the
 * two processes deploy independently, and a shared config file would couple
 * their env contracts for no benefit. What they genuinely share lives in
 * packages/.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL_INGEST: z.string().min(1, 'DATABASE_URL_INGEST is required'),
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(1000).default(60_000),
});

export type SchedulerConfig = z.infer<typeof schema>;

export function loadSchedulerConfig(
  env: NodeJS.ProcessEnv = process.env,
): SchedulerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid scheduler configuration:\n${issues}`);
  }
  return parsed.data;
}
