import type { FastifyBaseLogger } from 'fastify';

/**
 * Mail transport.
 *
 * Phase 1 needs to send exactly one kind of message - a password reset link -
 * and a real provider is not wired up until Phase 8. Rather than pretend, the
 * default transport writes to the log and says so.
 *
 * The interface is here now because the Phase 8 notification work (ADR §11)
 * registers channels against a shape like this one, and having callers depend
 * on the interface from the start means adding a provider changes one factory.
 */

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(email: OutboundEmail): Promise<void>;
}

/**
 * Writes the message to the application log.
 *
 * The reset link is logged in full, which is exactly what you want in local
 * development and exactly what you must not do in production - hence the
 * warning, and hence MAIL_TRANSPORT being explicit config rather than a
 * silent default that follows NODE_ENV.
 */
export function createLogMailer(logger: FastifyBaseLogger): Mailer {
  return {
    async send(email) {
      logger.warn(
        { to: email.to, subject: email.subject, body: email.text },
        'MAIL_TRANSPORT=log - email written to the log instead of being sent. ' +
          'Configure a real provider before production (Phase 8).',
      );
    },
  };
}

export function createNoopMailer(): Mailer {
  return {
    async send() {
      // Used by tests, which assert on the repository state rather than on
      // delivery.
    },
  };
}
