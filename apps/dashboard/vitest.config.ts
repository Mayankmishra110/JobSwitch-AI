import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Next's bundler resolves the tsconfig `@/*` path alias itself; plain
    // Vite (what vitest runs on) needs it spelled out explicitly.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // Every test seeds its own uniquely-emailed account against the real,
    // separately-running apps/web (see test/helpers.ts) - no shared,
    // truncate-between-tests state the way apps/web's own suite has, so
    // parallel files are safe here.
    hookTimeout: 20_000,
    testTimeout: 20_000,
  },
});
