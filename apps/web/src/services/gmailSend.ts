import { randomUUID } from 'node:crypto';

/**
 * Sending mail through a linked Gmail account - the one capability
 * repositories/emailCredential.ts's decrypted refresh token exists for.
 * Two callers: outreach's POST .../send (Phase 7, this file) and the
 * event-triggered notification mailer (Phase 8, services/notifyMailer.ts),
 * which both need "exchange a refresh token for an access token, build a
 * MIME message, POST it to Gmail" and nothing more - no googleapis SDK,
 * same one-HTTP-client-class minimalism services/ai already holds for LLM
 * providers.
 *
 * NOTE ON VERIFICATION: same disclosure as services/gmail.ts - no real
 * Google credentials exist for this build yet, so a real send is
 * unverified. MIME construction and the request shape are unit-tested
 * (test/gmailSend.test.ts) against a fake token/send endpoint.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export class GmailSendError extends Error {}

export interface GmailClientCredentials {
  clientId: string;
  clientSecret: string;
}

export async function exchangeRefreshToken(
  creds: GmailClientCredentials,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable>');
    throw new GmailSendError(`refreshing Gmail access token failed: ${response.status} ${body.slice(0, 300)}`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new GmailSendError('token refresh returned no access_token');
  return payload.access_token;
}

export interface OutgoingMessage {
  from: string;
  to: string;
  toName?: string | null;
  subject: string;
  bodyText: string;
  attachment?: { filename: string; contentType: string; bytes: Buffer };
}

function encodeHeaderWord(value: string): string {
  // RFC 2047 - only needed for a display name with non-ASCII bytes; a plain
  // ASCII name (the common case) passes through unchanged.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Builds a raw RFC 2822 message, multipart/mixed with one optional attachment - base64url-encoded, the exact shape Gmail's `raw` field requires. */
export function buildMimeMessage(message: OutgoingMessage): string {
  const boundary = `jobswitch_${randomUUID().replace(/-/g, '')}`;
  const to = message.toName
    ? `${encodeHeaderWord(message.toName)} <${message.to}>`
    : message.to;

  const headers = [
    `From: ${message.from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderWord(message.subject)}`,
    'MIME-Version: 1.0',
  ];

  const lines: string[] = [];
  if (message.attachment) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push(...headers, '');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 7bit', '');
    lines.push(message.bodyText, '');
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${message.attachment.contentType}; name="${message.attachment.filename}"`);
    lines.push(`Content-Disposition: attachment; filename="${message.attachment.filename}"`);
    lines.push('Content-Transfer-Encoding: base64', '');
    lines.push(message.attachment.bytes.toString('base64'));
    lines.push(`--${boundary}--`);
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push(...headers, '');
    lines.push(message.bodyText);
  }

  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

export async function sendGmailMessage(
  creds: GmailClientCredentials,
  refreshToken: string,
  message: OutgoingMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string }> {
  const accessToken = await exchangeRefreshToken(creds, refreshToken, fetchImpl);
  const raw = buildMimeMessage(message);

  const response = await fetchImpl(SEND_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable>');
    throw new GmailSendError(`Gmail send failed: ${response.status} ${body.slice(0, 500)}`);
  }

  const payload = (await response.json()) as { id?: string };
  if (!payload.id) throw new GmailSendError('Gmail send returned no message id');
  return { id: payload.id };
}
