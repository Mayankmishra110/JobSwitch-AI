import { Errors } from '@jobswitch/core';
import type { Config } from '../config.js';
import { generatePkce, type PkcePair } from './pkce.js';

/**
 * Linking a Gmail mailbox for outreach send (Phase 7) and event-triggered
 * notification email (Phase 8) - a SEPARATE OAuth flow from
 * google-oauth.ts's sign-in, even though both go through the same Google
 * client id/secret (one Google Cloud OAuth client authorizes more than one
 * redirect URI) and the same PKCE mechanics (services/pkce.ts).
 *
 * Different on purpose: sign-in only ever needs to prove identity (`openid
 * email profile`, id_token trusted, discarded); linking needs a durable
 * grant to act later (`gmail.send`, `access_type=offline` +
 * `prompt=consent` so a refresh_token is actually issued, persisted
 * encrypted in email_credential - see repositories/emailCredential.ts).
 * Reusing beginGoogleSignIn's narrower scope here would silently break
 * sending the first time a stored access token expired.
 *
 * NOTE ON VERIFICATION: same disclosure as google-oauth.ts - this build has
 * no real Google credentials (docs/BUILD_PLAN.md's Phase 8 explicitly
 * defers them), so the live round trip is unverified. The shape, PKCE/state
 * handling, and encrypted storage are implemented and unit-tested with a
 * fake token endpoint (test/gmail.test.ts); the first run against real
 * credentials is the actual verification, exactly as google-oauth.ts's own
 * note already says for sign-in.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send openid email';

export interface GmailAuthStart extends PkcePair {
  authorizeUrl: string;
}

export function beginGmailAuthorization(config: Config): GmailAuthStart {
  if (!config.gmail.enabled) throw Errors.oauthDisabled();

  const pkce = generatePkce();

  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', config.gmail.clientId);
  url.searchParams.set('redirect_uri', config.gmail.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_SCOPE);
  url.searchParams.set('state', pkce.state);
  url.searchParams.set('code_challenge', pkce.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Both required to guarantee a refresh_token comes back: Google only
  // issues one on the FIRST consent for a given client+scope+account
  // unless the consent screen is forced every time.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');

  return { authorizeUrl: url.toString(), ...pkce };
}

export interface GmailLinkResult {
  email: string;
  refreshToken: string;
  scope: string;
}

function decodeIdTokenEmail(idToken: string): string {
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw Errors.oauthFailed('id_token is not a well-formed JWT');
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (error) {
    throw Errors.oauthFailed(`id_token payload is not JSON: ${String(error)}`);
  }
  const email = typeof claims.email === 'string' ? claims.email : null;
  if (!email) throw Errors.oauthFailed('id_token missing email');
  return email;
}

export async function completeGmailAuthorization(
  config: Config,
  params: { code: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GmailLinkResult> {
  if (!config.gmail.enabled) throw Errors.oauthDisabled();

  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: config.gmail.clientId,
      client_secret: config.gmail.clientSecret,
      redirect_uri: config.gmail.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: params.codeVerifier,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable>');
    throw Errors.oauthFailed(`token exchange failed: ${response.status} ${body.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    id_token?: string;
    refresh_token?: string;
    scope?: string;
  };
  if (!payload.id_token) throw Errors.oauthFailed('token response contained no id_token');
  if (!payload.refresh_token) {
    // Reachable if a returning user's consent screen was somehow skipped
    // despite prompt=consent (a Google-side edge case, not this code's
    // bug) - surfaced as a clear, actionable failure rather than silently
    // storing nothing and failing later at send time with no context.
    throw Errors.oauthFailed(
      'Google did not return a refresh token - try disconnecting and reconnecting Gmail',
    );
  }

  return {
    email: decodeIdTokenEmail(payload.id_token),
    refreshToken: payload.refresh_token,
    scope: payload.scope ?? GMAIL_SCOPE,
  };
}
