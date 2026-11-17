import type { NextConfig } from 'next';

/**
 * No rewrites/CORS needed anywhere in this app - see src/lib/apiServer.ts's
 * own doc comment for why: every read is a Server Component fetch, every
 * write is a Server Action, and the one long-lived connection (SSE) is
 * proxied through a Route Handler. The browser only ever talks to this
 * app's own origin; apps/web is called exclusively server-to-server.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
