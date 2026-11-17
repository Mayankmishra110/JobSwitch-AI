/**
 * apps/web's real origin, called server-to-server only (see apiServer.ts).
 * Not NEXT_PUBLIC_* - this must never reach the browser bundle, since the
 * browser is never the one making this call.
 */
// `localhost`, not `127.0.0.1` - the Gmail-link flow's cookie relay
// (app/api/gmail/authorize/route.ts) depends on both apps sharing the
// exact same hostname string in dev; mixing the two would silently break
// it (cookie matching ignores port, but not hostname).
export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000';
