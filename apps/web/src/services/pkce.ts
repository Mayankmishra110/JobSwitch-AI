import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE (RFC 7636) helper shared by every OAuth flow this app runs -
 * google-oauth.ts (sign-in) and gmail.ts (linking an outbound mailbox).
 * Two independent flows, same mechanics: a fresh state/verifier per
 * attempt, S256-challenged, both single-use and short-lived via the
 * caller's own state/verifier cookies.
 */
export interface PkcePair {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

export function generatePkce(): PkcePair {
  const state = randomBytes(24).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { state, codeVerifier, codeChallenge };
}
