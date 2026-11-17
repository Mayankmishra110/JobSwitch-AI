import { describe, expect, it } from 'vitest';
import { buildMimeMessage, exchangeRefreshToken, sendGmailMessage, GmailSendError } from '../src/services/gmailSend.js';

/**
 * Gmail message sending - pure MIME construction plus the token-refresh/
 * send request shape, against a fake fetch (no real Google credentials
 * exist for this build, per services/gmailSend.ts's own disclosure).
 */

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

describe('buildMimeMessage', () => {
  it('builds a plain text/plain message when there is no attachment', () => {
    const raw = buildMimeMessage({
      from: 'me',
      to: 'recruiter@example.com',
      subject: 'Interested in the role',
      bodyText: 'Hello there.',
    });
    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain('To: recruiter@example.com');
    expect(decoded).toContain('Subject: Interested in the role');
    expect(decoded).toContain('Content-Type: text/plain');
    expect(decoded).toContain('Hello there.');
    expect(decoded).not.toContain('multipart/mixed');
  });

  it('builds a multipart/mixed message with a base64 attachment', () => {
    const raw = buildMimeMessage({
      from: 'me',
      to: 'recruiter@example.com',
      toName: 'Jane Recruiter',
      subject: 'Resume attached',
      bodyText: 'Please see attached.',
      attachment: { filename: 'resume.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 fake') },
    });
    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain('multipart/mixed');
    expect(decoded).toContain('To: Jane Recruiter <recruiter@example.com>');
    expect(decoded).toContain('Content-Disposition: attachment; filename="resume.pdf"');
    expect(decoded).toContain(Buffer.from('%PDF-1.4 fake').toString('base64'));
  });

  it('RFC 2047-encodes a non-ASCII display name', () => {
    const raw = buildMimeMessage({
      from: 'me',
      to: 'r@example.com',
      toName: 'José',
      subject: 'Hi',
      bodyText: 'Hi',
    });
    const decoded = decodeBase64Url(raw);
    expect(decoded).toMatch(/To: =\?UTF-8\?B\?/);
  });
});

describe('exchangeRefreshToken', () => {
  it('posts the refresh grant and returns the access token', async () => {
    let capturedBody: string | undefined;
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ access_token: 'access-123' }), { status: 200 });
    }) as typeof fetch;

    const token = await exchangeRefreshToken(
      { clientId: 'id', clientSecret: 'secret' },
      'refresh-abc',
      fakeFetch,
    );
    expect(token).toBe('access-123');
    expect(capturedBody).toContain('grant_type=refresh_token');
    expect(capturedBody).toContain('refresh-abc');
  });

  it('throws GmailSendError when the token endpoint fails', async () => {
    const fakeFetch = (async () => new Response('invalid_grant', { status: 400 })) as typeof fetch;
    await expect(
      exchangeRefreshToken({ clientId: 'id', clientSecret: 'secret' }, 'revoked', fakeFetch),
    ).rejects.toThrow(GmailSendError);
  });
});

describe('sendGmailMessage', () => {
  it('refreshes the token, then POSTs the raw message and returns the message id', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: unknown) => {
      const urlStr = String(url);
      calls.push(urlStr);
      if (urlStr.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'access-123' }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'gmail-message-1' }), { status: 200 });
    }) as typeof fetch;

    const result = await sendGmailMessage(
      { clientId: 'id', clientSecret: 'secret' },
      'refresh-abc',
      { from: 'me', to: 'recruiter@example.com', subject: 'Hi', bodyText: 'Hello.' },
      fakeFetch,
    );
    expect(result).toEqual({ id: 'gmail-message-1' });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('gmail.googleapis.com');
  });

  it('throws GmailSendError when Gmail rejects the send', async () => {
    const fakeFetch = (async (url: unknown) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'access-123' }), { status: 200 });
      }
      return new Response('quota exceeded', { status: 429 });
    }) as typeof fetch;

    await expect(
      sendGmailMessage(
        { clientId: 'id', clientSecret: 'secret' },
        'refresh-abc',
        { from: 'me', to: 'r@example.com', subject: 'Hi', bodyText: 'Hi' },
        fakeFetch,
      ),
    ).rejects.toThrow(GmailSendError);
  });
});
