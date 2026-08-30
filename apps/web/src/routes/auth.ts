import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AppError,
  Errors,
  confirmPasswordResetInput,
  loginInput,
  requestPasswordResetInput,
  signupInput,
} from '@jobswitch/core';
import { isProduction, rateLimitFor } from '../config.js';
import {
  confirmPasswordReset,
  login,
  logout,
  requestPasswordReset,
  signup,
  upsertOauthUser,
  type SignedInSession,
} from '../services/auth.js';
import {
  beginGoogleSignIn,
  completeGoogleSignIn,
} from '../services/google-oauth.js';
import {
  forgotPasswordPage,
  loginPage,
  resetPasswordPage,
  signupPage,
} from '../views/pages.js';

const OAUTH_STATE_COOKIE = 'js_oauth_state';
const OAUTH_VERIFIER_COOKIE = 'js_oauth_verifier';

function requestMeta(request: FastifyRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

function wantsHtml(request: FastifyRequest): boolean {
  return Boolean(request.headers.accept?.includes('text/html'));
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { config } = app.authDeps;
  const secure = isProduction(config);

  function setSessionCookie(reply: FastifyReply, session: SignedInSession) {
    reply.setCookie(config.SESSION_COOKIE_NAME, session.token, {
      httpOnly: true,
      secure,
      // Lax rather than Strict: Strict would drop the cookie when a user
      // arrives from a link in their own reset email, which reads as a broken
      // login. Lax still blocks cross-site POSTs, which is the CSRF concern.
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
      signed: false,
    });
  }

  function clearSessionCookie(reply: FastifyReply) {
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
  }

  // ---- pages -------------------------------------------------------------

  app.get('/login', async (request, reply) => {
    if (request.principal) return reply.redirect('/app');
    return reply
      .type('text/html')
      .send(loginPage({ googleEnabled: config.google.enabled }));
  });

  app.get('/signup', async (request, reply) => {
    if (request.principal) return reply.redirect('/app');
    return reply
      .type('text/html')
      .send(signupPage({ googleEnabled: config.google.enabled }));
  });

  app.get('/forgot-password', async (_request, reply) =>
    reply.type('text/html').send(forgotPasswordPage({})),
  );

  app.get<{ Querystring: { token?: string } }>(
    '/reset-password',
    async (request, reply) => {
      const token = request.query.token;
      if (!token) {
        return reply
          .type('text/html')
          .send(forgotPasswordPage({ error: 'That link is missing its token.' }));
      }
      return reply.type('text/html').send(resetPasswordPage({ token }));
    },
  );

  // ---- signup ------------------------------------------------------------

  app.post(
    '/auth/signup',
    { config: rateLimitFor(config, { max: 10, timeWindow: '1 hour' }) },
    async (request, reply) => {
      const parsed = signupInput.safeParse(request.body);
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? 'Check your details.';
        if (wantsHtml(request)) {
          return reply
            .status(400)
            .type('text/html')
            .send(
              signupPage({
                error: message,
                googleEnabled: config.google.enabled,
              }),
            );
        }
        throw Errors.validation(parsed.error.flatten());
      }

      try {
        const session = await signup(
          app.authDeps,
          parsed.data,
          requestMeta(request),
        );
        setSessionCookie(reply, session);
        return wantsHtml(request)
          ? reply.redirect('/app')
          : reply.status(201).send({ ok: true });
      } catch (error) {
        if (error instanceof AppError && wantsHtml(request)) {
          return reply
            .status(error.status)
            .type('text/html')
            .send(
              signupPage({
                error: error.safeMessage,
                googleEnabled: config.google.enabled,
              }),
            );
        }
        throw error;
      }
    },
  );

  // ---- login -------------------------------------------------------------

  app.post(
    '/auth/login',
    // Tighter than signup: this endpoint is what a credential-stuffing run
    // targets.
    { config: rateLimitFor(config, { max: 10, timeWindow: '15 minutes' }) },
    async (request, reply) => {
      const parsed = loginInput.safeParse(request.body);
      if (!parsed.success) {
        if (wantsHtml(request)) {
          return reply
            .status(400)
            .type('text/html')
            .send(
              loginPage({
                error: 'Enter your email and password.',
                googleEnabled: config.google.enabled,
              }),
            );
        }
        throw Errors.validation(parsed.error.flatten());
      }

      try {
        const session = await login(
          app.authDeps,
          parsed.data,
          requestMeta(request),
        );
        setSessionCookie(reply, session);
        return wantsHtml(request)
          ? reply.redirect('/app')
          : reply.send({ ok: true });
      } catch (error) {
        if (error instanceof AppError && wantsHtml(request)) {
          return reply
            .status(error.status)
            .type('text/html')
            .send(
              loginPage({
                error: error.safeMessage,
                googleEnabled: config.google.enabled,
              }),
            );
        }
        throw error;
      }
    },
  );

  // ---- logout ------------------------------------------------------------

  app.post('/auth/logout', async (request, reply) => {
    if (request.principal) {
      await logout(app.authDeps, request.principal, requestMeta(request));
    }
    clearSessionCookie(reply);
    return wantsHtml(request)
      ? reply.redirect('/login')
      : reply.send({ ok: true });
  });

  // ---- password reset ----------------------------------------------------

  app.post(
    '/auth/forgot-password',
    { config: rateLimitFor(config, { max: 5, timeWindow: '1 hour' }) },
    async (request, reply) => {
      const parsed = requestPasswordResetInput.safeParse(request.body);

      // The same confirmation regardless of outcome - including a malformed
      // address - so this endpoint cannot be used to test which addresses have
      // accounts.
      const notice =
        'If an account exists for that address, a reset link is on its way.';

      if (parsed.success) {
        await requestPasswordReset(
          app.authDeps,
          parsed.data,
          requestMeta(request),
        );
      }

      return wantsHtml(request)
        ? reply.type('text/html').send(forgotPasswordPage({ notice }))
        : reply.send({ ok: true, message: notice });
    },
  );

  app.post(
    '/auth/reset-password',
    { config: rateLimitFor(config, { max: 10, timeWindow: '1 hour' }) },
    async (request, reply) => {
      const parsed = confirmPasswordResetInput.safeParse(request.body);
      if (!parsed.success) {
        const token =
          typeof (request.body as { token?: unknown })?.token === 'string'
            ? ((request.body as { token: string }).token)
            : '';
        const message =
          parsed.error.issues[0]?.message ?? 'Check the submitted fields.';
        if (wantsHtml(request)) {
          return reply
            .status(400)
            .type('text/html')
            .send(resetPasswordPage({ token, error: message }));
        }
        throw Errors.validation(parsed.error.flatten());
      }

      try {
        await confirmPasswordReset(
          app.authDeps,
          parsed.data,
          requestMeta(request),
        );
        // Not auto-signed-in: every session was just revoked, and asking the
        // user to sign in with the new password confirms it works.
        clearSessionCookie(reply);
        return wantsHtml(request)
          ? reply.type('text/html').send(
              loginPage({
                notice: 'Password updated. Sign in with your new password.',
                googleEnabled: config.google.enabled,
              }),
            )
          : reply.send({ ok: true });
      } catch (error) {
        if (error instanceof AppError && wantsHtml(request)) {
          return reply
            .status(error.status)
            .type('text/html')
            .send(
              resetPasswordPage({
                token: parsed.data.token,
                error: error.safeMessage,
              }),
            );
        }
        throw error;
      }
    },
  );

  // ---- Google OAuth (config-gated) ---------------------------------------

  app.get('/auth/google', async (_request, reply) => {
    if (!config.google.enabled) throw Errors.oauthDisabled();

    const start = beginGoogleSignIn(config);
    const cookieOptions = {
      httpOnly: true,
      secure,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 600,
    };
    reply.setCookie(OAUTH_STATE_COOKIE, start.state, cookieOptions);
    reply.setCookie(OAUTH_VERIFIER_COOKIE, start.codeVerifier, cookieOptions);
    return reply.redirect(start.authorizeUrl);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/google/callback',
    async (request, reply) => {
      if (!config.google.enabled) throw Errors.oauthDisabled();

      const { code, state, error } = request.query;
      const expectedState = request.cookies[OAUTH_STATE_COOKIE];
      const verifier = request.cookies[OAUTH_VERIFIER_COOKIE];

      reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
      reply.clearCookie(OAUTH_VERIFIER_COOKIE, { path: '/' });

      if (error) throw Errors.oauthFailed(`provider returned error=${error}`);
      if (!code || !state) throw Errors.oauthFailed('missing code or state');
      // The CSRF check: without it, an attacker can complete a sign-in flow in
      // the victim's browser and land them in the attacker's account.
      if (!expectedState || state !== expectedState) {
        throw Errors.oauthFailed('state mismatch');
      }
      if (!verifier) throw Errors.oauthFailed('missing PKCE verifier');

      const profile = await completeGoogleSignIn(config, {
        code,
        codeVerifier: verifier,
      });

      const session = await upsertOauthUser(
        app.authDeps,
        {
          provider: 'google',
          providerUserId: profile.providerUserId,
          email: profile.email,
          fullName: profile.fullName,
        },
        requestMeta(request),
      );

      setSessionCookie(reply, session);
      return reply.redirect('/app');
    },
  );
}
