import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests share one Postgres database, so parallel files would race on the
    // truncate/seed in beforeAll. Serial is correct here, not a workaround.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
