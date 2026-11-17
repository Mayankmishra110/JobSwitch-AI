import { Errors } from '@jobswitch/core';
import type { Config } from '../config.js';
import { generatePkce } from './pkce.js';

/**
 * Google OAuth 2.0 with PKCE.
 *
 * Config-gated (see config.ts): with no credentials the routes return 404
 * rather than failing at the callback.
 *
 * NOTE ON VERIFICATION: this flow cannot be exercised end to end without real
 * Google credentials, which this Phase 1 build does not have. The shape,
 * state/PKCE handling and id_token claim checks are implemented, and the local
 * pieces are unit-tested, but the live round trip is untested. Treat the first
 * run against real credentials as the actual verification.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface OauthStart {
  authorizeUrl: string;
  state: string;
  codeVerifier: string;
}

export interface GoogleProfile {
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  fullName: string | null;
}

export function beginGoogleSignIn(config: Config): OauthStart {
  if (!config.google.enabled) throw Errors.oauthDisabled();

  const { state, codeVerifier, codeChallenge } = generatePkce();

  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', config.google.clientId);
  url.searchParams.set('redirect_uri', config.google.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Without this, a returning user who has already granted consent comes back
  // with no usable account selection prompt on shared machines.
  url.searchParams.set('prompt', 'select_account');

  return { authorizeUrl: url.toString(), state, codeVerifier };
}

/**
 * Decode the id_token payload.
 *
 * The signature is NOT verified here, and that is safe only because the token
 * is received directly from Google's token endpoint over TLS in a
 * server-to-server request - the channel is the assurance. An id_token
 * arriving by any other route (a redirect fragment, a client POST) MUST have
 * its signature checked against Google's JWKS before being trusted.
 */
function decodeIdTokenPayload(idToken: string): Record<string, unknown> {
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw Errors.oauthFailed('id_token is not a well-formed JWT');
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (error) {
    throw Errors.oauthFailed(`id_token payload is not JSON: ${String(error)}`);
  }
}

export async function completeGoogleSignIn(
  config: Config,
  params: { code: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleProfile> {
  if (!config.google.enabled) throw Errors.oauthDisabled();

  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: params.codeVerifier,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable>');
    throw Errors.oauthFailed(
      `token exchange failed: ${response.status} ${body.slice(0, 300)}`,
    );
  }

  const payload = (await response.json()) as { id_token?: string };
  if (!payload.id_token) {
    throw Errors.oauthFailed('token response contained no id_token');
  }

  const claims = decodeIdTokenPayload(payload.id_token);

  const sub = typeof claims.sub === 'string' ? claims.sub : null;
  const email = typeof claims.email === 'string' ? claims.email : null;
  // Google sends this as a boolean or as the string "true" depending on path.
  const emailVerified =
    claims.email_verified === true || claims.email_verified === 'true';
  const name = typeof claims.name === 'string' ? claims.name : null;

  if (!sub || !email) {
    throw Errors.oauthFailed('id_token missing sub or email');
  }

  // Refusing unverified emails is what stops OAuth from becoming an
  // account-takeover path against existing local accounts (see
  // upsertOauthUser).
  if (!emailVerified) {
    throw Errors.oauthFailed('Google reported the email as unverified');
  }

  return {
    providerUserId: sub,
    email,
    emailVerified,
    fullName: name,
  };
}
