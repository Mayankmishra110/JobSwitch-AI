import type { FastifyInstance } from 'fastify';
import {
  createOutreachInput,
  Errors,
  Events,
  isUuid,
  patchOutreachInput,
  type OutreachDraftCreatedPayload,
} from '@jobswitch/core';
import {
  applicationsRepo,
  artifactsRepo,
  emailCredentialRepo,
  outreachRepo,
  profileRepo,
  withAccount,
} from '@jobswitch/db';
import { isProduction } from '../config.js';
import { beginGmailAuthorization, completeGmailAuthorization } from '../services/gmail.js';
import { draftOutreachContent } from '../services/outreachTemplate.js';
import { sendGmailMessage } from '../services/gmailSend.js';

const GMAIL_STATE_COOKIE = 'js_gmail_oauth_state';
const GMAIL_VERIFIER_COOKIE = 'js_gmail_oauth_verifier';

/**
 * Outreach (Phase 7): drafting, approval, and send - plus the Gmail-link
 * flow send depends on. Never auto-sent: draft -> approved -> sent only
 * ever advances through an explicit action at each step (D-3/PRD §30),
 * enforced at the repository layer (outreachRepo's own compare-and-set),
 * not just here.
 */
export async function registerOutreachRoutes(app: FastifyInstance): Promise<void> {
  const { pool, config, events } = app.authDeps;
  const secure = isProduction(config);

  // ---- Gmail linking ------------------------------------------------------

  app.get('/api/v1/outreach/gmail/status', { preHandler: app.requireAuth }, async (request) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    const status = await withAccount(pool, principal.accountId, (tx) =>
      emailCredentialRepo.getCredentialStatus(tx, principal.accountId),
    );
    return status;
  });

  app.get('/api/v1/outreach/gmail/authorize', { preHandler: app.requireAuth }, async (_request, reply) => {
    if (!config.gmail.enabled) throw Errors.oauthDisabled();

    const start = beginGmailAuthorization(config);
    const cookieOptions = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/', maxAge: 600 };
    reply.setCookie(GMAIL_STATE_COOKIE, start.state, cookieOptions);
    reply.setCookie(GMAIL_VERIFIER_COOKIE, start.codeVerifier, cookieOptions);
    return { authorizeUrl: start.authorizeUrl };
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/v1/outreach/gmail/callback',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();
      if (!config.gmail.enabled) throw Errors.oauthDisabled();

      const { code, state, error } = request.query;
      const expectedState = request.cookies[GMAIL_STATE_COOKIE];
      const verifier = request.cookies[GMAIL_VERIFIER_COOKIE];

      reply.clearCookie(GMAIL_STATE_COOKIE, { path: '/' });
      reply.clearCookie(GMAIL_VERIFIER_COOKIE, { path: '/' });

      if (error) throw Errors.oauthFailed(`provider returned error=${error}`);
      if (!code || !state) throw Errors.oauthFailed('missing code or state');
      if (!expectedState || state !== expectedState) throw Errors.oauthFailed('state mismatch');
      if (!verifier) throw Errors.oauthFailed('missing PKCE verifier');

      const linked = await completeGmailAuthorization(config, { code, codeVerifier: verifier });

      await withAccount(pool, principal.accountId, (tx) =>
        emailCredentialRepo.upsertCredential(
          tx,
          principal.accountId,
          { email: linked.email, refreshToken: linked.refreshToken, scope: linked.scope },
          config.gmail.enabled ? config.gmail.encryptionKey : '',
        ),
      );

      // Redirects to the dashboard (apps/dashboard), not a page in this
      // process - APP_ORIGIN is this deployment's real user-facing origin
      // (in the eventual Traefik-routed shape, the same origin this
      // process itself answers on; in dev, apps/dashboard's own port).
      return reply.redirect(`${config.APP_ORIGIN}/profile?gmail=connected`);
    },
  );

  app.delete('/api/v1/outreach/gmail', { preHandler: app.requireAuth }, async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    await withAccount(pool, principal.accountId, (tx) =>
      emailCredentialRepo.deleteCredential(tx, principal.accountId),
    );
    return reply.status(204).send();
  });

  // ---- Drafts ---------------------------------------------------------

  app.get('/api/v1/outreach', { preHandler: app.requireAuth }, async (request) => {
    const principal = request.principal;
    if (!principal) throw Errors.unauthenticated();

    const outreach = await withAccount(pool, principal.accountId, (tx) =>
      outreachRepo.listOutreachForAccount(tx, principal.accountId),
    );
    return { outreach };
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/applications/:id/outreach',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That application');

      const parsed = createOutreachInput.safeParse(request.body);
      if (!parsed.success) throw Errors.validation(parsed.error.flatten());

      const draft = await withAccount(pool, principal.accountId, async (tx) => {
        const application = await applicationsRepo.getApplicationById(tx, principal.accountId, id);
        if (!application) throw Errors.notFound('That application');

        const jobContext = applicationsRepo.jobContextFor(application);
        const profile = await profileRepo.getProfile(tx, principal.accountId);

        const content = draftOutreachContent({
          title: jobContext?.title ?? application.manualTitle ?? 'this role',
          company: jobContext?.company ?? application.manualCompany,
          candidateHeadline: profile?.headline ?? null,
        });

        return outreachRepo.createOutreachDraft(tx, principal.accountId, id, parsed.data, content);
      });

      void events
        .publish(principal.accountId, Events.OUTREACH_DRAFT_CREATED, {
          accountId: principal.accountId,
          applicationId: id,
          outreachId: draft.id,
        } satisfies OutreachDraftCreatedPayload)
        .catch((err) => request.log.error({ err }, 'publishing outreach.draft.created failed'));

      return reply.status(201).send({ outreach: draft });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/outreach/:id',
    { preHandler: app.requireAuth },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That outreach draft');

      const outreach = await withAccount(pool, principal.accountId, (tx) =>
        outreachRepo.getOutreachById(tx, principal.accountId, id),
      );
      if (!outreach) throw Errors.notFound('That outreach draft');
      return { outreach };
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/v1/outreach/:id',
    { preHandler: app.requireAuth },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That outreach draft');

      const parsed = patchOutreachInput.safeParse(request.body);
      if (!parsed.success) throw Errors.validation(parsed.error.flatten());

      const outreach = await withAccount(pool, principal.accountId, (tx) =>
        outreachRepo.patchOutreachDraft(tx, principal.accountId, id, parsed.data),
      );
      if (!outreach) {
        throw Errors.conflict('That draft no longer exists or is not editable (already approved or sent).');
      }
      return { outreach };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/outreach/:id/approve',
    { preHandler: app.requireAuth },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That outreach draft');

      const outreach = await withAccount(pool, principal.accountId, (tx) =>
        outreachRepo.approveOutreachDraft(tx, principal.accountId, id),
      );
      if (!outreach) throw Errors.conflict('That draft is not awaiting approval.');
      return { outreach };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/outreach/:id/send',
    { preHandler: app.requireAuth },
    async (request) => {
      const principal = request.principal;
      if (!principal) throw Errors.unauthenticated();
      if (!config.gmail.enabled) throw Errors.oauthDisabled();

      const { id } = request.params;
      if (!isUuid(id)) throw Errors.notFound('That outreach draft');

      const prepared = await withAccount(pool, principal.accountId, async (tx) => {
        const outreach = await outreachRepo.getOutreachById(tx, principal.accountId, id);
        if (!outreach) throw Errors.notFound('That outreach draft');
        if (outreach.status !== 'approved') {
          return { conflict: true as const };
        }

        const refreshToken = await emailCredentialRepo.getDecryptedRefreshToken(
          tx,
          principal.accountId,
          config.gmail.enabled ? config.gmail.encryptionKey : '',
        );
        if (!refreshToken) {
          throw Errors.validation('Connect a Gmail account before sending outreach.');
        }

        const artifacts = await artifactsRepo.listArtifactsForApplication(
          tx,
          principal.accountId,
          outreach.applicationId,
        );
        const compiled = artifacts.find((a) => a.status === 'compiled' && a.hasPdf);
        const attachment = compiled
          ? await artifactsRepo.getArtifactPdf(tx, principal.accountId, compiled.id)
          : null;

        return { conflict: false as const, outreach, refreshToken, attachment, variantId: compiled?.variantId };
      });

      if (prepared.conflict) throw Errors.conflict('That draft is not approved.');
      const { outreach, refreshToken, attachment, variantId } = prepared;

      const sent = await sendGmailMessage(
        { clientId: config.gmail.enabled ? config.gmail.clientId : '', clientSecret: config.gmail.enabled ? config.gmail.clientSecret : '' },
        refreshToken,
        {
          from: 'me',
          to: outreach.toEmail,
          toName: outreach.toName,
          subject: outreach.subject,
          bodyText: outreach.body,
          attachment: attachment
            ? { filename: `${variantId ?? 'resume'}.pdf`, contentType: 'application/pdf', bytes: attachment.pdfBytes }
            : undefined,
        },
      );

      const updated = await withAccount(pool, principal.accountId, (tx) =>
        outreachRepo.markOutreachSent(tx, principal.accountId, id, sent.id),
      );
      if (!updated) {
        // Sent by Gmail's own account but lost the compare-and-set race
        // against a concurrent second click - the send already happened
        // and cannot be undone, so this is reported plainly rather than
        // as a generic error.
        throw Errors.conflict('Message was sent, but this draft was already marked sent by another request.');
      }

      return { outreach: updated };
    },
  );
}
