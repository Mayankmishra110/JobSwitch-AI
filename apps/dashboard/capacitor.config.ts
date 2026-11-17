import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor scaffold (Phase 6, build-plan's own sequencing: "PWA built
 * first - Capacitor Android/iOS shells wrap the working PWA as the final
 * packaging step"). Config-only in this repo today - see specs/
 * dashboard.md for exactly what's scaffolded vs. what still needs a real
 * Android/iOS toolchain (this environment has neither Java nor Xcode) to
 * actually build and verify.
 *
 * `server.url` rather than a bundled static `webDir`: this dashboard is
 * server-rendered (Server Components hitting apps/web on every
 * navigation, Server Actions, a live SSE connection) - the "point the
 * WebView at a real server" pattern Capacitor supports for exactly this
 * shape of app, not the "bundle a static export into the app" pattern
 * most Capacitor quickstarts assume. `webDir` is still required by
 * Capacitor's schema even though nothing in it is ever loaded in
 * `server.url` mode - it points at `public/` (an existing, real directory
 * in this app) purely to satisfy that requirement.
 *
 * The URL below is a placeholder for local development against this
 * app's own dev server from a device/emulator on the same network -
 * `10.0.2.2` is the Android emulator's own alias for the host machine's
 * `localhost`. A real deployment replaces this with the actual production
 * origin once one exists (Phase 5.0, not yet deployed).
 */
const config: CapacitorConfig = {
  appId: 'ai.jobswitch.dashboard',
  appName: 'JobSwitch AI',
  webDir: 'public',
  server: {
    url: 'http://10.0.2.2:3001',
    cleartext: true,
  },
};

export default config;
