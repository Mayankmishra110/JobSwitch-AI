import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // The ingest role, not the web role: workers must not hold grants on tenant
  // tables (ADR D-14).
  DATABASE_URL_INGEST: z.string().min(1, 'DATABASE_URL_INGEST is required'),
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  WORKER_IDLE_DELAY_MS: z.coerce.number().int().min(100).default(2000),
  INGEST_USER_AGENT: z
    .string()
    .default('JobSwitchAI/0.1 (+https://jobswitch.ai/bot; jobs indexer)'),
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid worker configuration:\n${issues}`);
  }
  return parsed.data;
}
