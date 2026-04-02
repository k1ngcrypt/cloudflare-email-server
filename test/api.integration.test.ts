import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index';
import {
  apiRequest,
  createAuthenticatedSession,
  login,
  resetState,
  seedLegacyUser,
} from './helpers';

function bindings(): Env {
  return env as unknown as Env;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe('worker HTTP API integration', () => {
  beforeEach(async () => {
    await resetState();
  });

  it('serves the webmail shell with hardened headers', async () => {
    const response = await apiRequest('/');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");

    const body = await response.text();
    expect(body).toContain('Webmail Login');
  });

  it('requires authentication for protected endpoints', async () => {
    const response = await apiRequest('/api/me');

    expect(response.status).toBe(401);

    const body = await readJson<{ error: string }>(response);
    expect(body.error).toBe('Unauthorized');
  });

  it('issues cookie-backed sessions and revokes them on logout', async () => {
    const user = await seedLegacyUser({
      username: 'alice',
      email: 'alice@mail.example.test',
      password: 'S3cur3!Passphrase',
    });

    const loginResult = await login(user.username, user.password, {
      'CF-Connecting-IP': '203.0.113.7',
    });

    expect(loginResult.response.status).toBe(200);
    expect(typeof loginResult.body.token).toBe('string');

    const setCookie = loginResult.response.headers.get('set-cookie');
    expect(setCookie).toContain('session_token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Secure');

    const sessionCookie = loginResult.cookie;
    expect(sessionCookie).not.toBeNull();

    const meResponse = await apiRequest('/api/me', {
      headers: {
        Cookie: sessionCookie as string,
        Origin: 'https://webmail.test',
      },
    });

    expect(meResponse.status).toBe(200);
    expect(meResponse.headers.get('access-control-allow-origin')).toBe('https://webmail.test');

    const meBody = await readJson<{ username: string; email: string }>(meResponse);
    expect(meBody.username).toBe(user.username);
    expect(meBody.email).toBe(user.email);

    const logoutResponse = await apiRequest('/api/logout', {
      method: 'POST',
      headers: {
        Cookie: sessionCookie as string,
      },
    });

    expect(logoutResponse.status).toBe(200);
    expect(logoutResponse.headers.get('set-cookie')).toContain('Max-Age=0');

    const afterLogout = await apiRequest('/api/me', {
      headers: {
        Cookie: sessionCookie as string,
      },
    });

    expect(afterLogout.status).toBe(401);
  });

  it('throttles repeated failed logins per client IP and username', async () => {
    const user = await seedLegacyUser({
      username: 'throttle-user',
      email: 'throttle-user@mail.example.test',
      password: 'Correct-Password-123',
    });

    const throttleHeaders = {
      'CF-Connecting-IP': '198.51.100.23',
    };

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const failed = await login(user.username, `wrong-${attempt}`, throttleHeaders);
      expect(failed.response.status).toBe(401);
    }

    const blocked = await login(user.username, 'wrong-final', throttleHeaders);
    expect(blocked.response.status).toBe(429);

    const retryAfter = Number.parseInt(blocked.response.headers.get('retry-after') ?? '0', 10);
    expect(retryAfter).toBeGreaterThan(0);

    const blockedEvenWithCorrectPassword = await login(user.username, user.password, throttleHeaders);
    expect(blockedEvenWithCorrectPassword.response.status).toBe(429);
  });

  it('returns only mailbox owner emails, marks opens as read, and moves deletes to trash', async () => {
    const session = await createAuthenticatedSession({
      username: 'owner',
      email: 'owner@mail.example.test',
      password: 'Inbox-Pass-123',
    });

    const otherUser = await seedLegacyUser({
      username: 'other',
      email: 'other@mail.example.test',
      password: 'Other-Pass-123',
    });

    const ownerEmail = await bindings()
      .DB.prepare(
        `
          INSERT INTO emails (user_id, message_id, from_address, from_name, to_address, subject, body_text, raw_size, folder, read)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'inbox', 0)
          RETURNING id
        `
      )
      .bind(
        session.id,
        '<owner-message-1@mail.example.test>',
        'sender@example.net',
        'Sender One',
        session.email,
        'Owner Inbox Message',
        'Body for owner email',
        128
      )
      .first<{ id: number }>();

    const otherEmail = await bindings()
      .DB.prepare(
        `
          INSERT INTO emails (user_id, message_id, from_address, from_name, to_address, subject, body_text, raw_size, folder)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'inbox')
          RETURNING id
        `
      )
      .bind(
        otherUser.id,
        '<other-message-1@mail.example.test>',
        'sender@example.net',
        'Sender Two',
        otherUser.email,
        'Other User Message',
        'Body for other email',
        64
      )
      .first<{ id: number }>();

    expect(ownerEmail?.id).toBeTruthy();
    expect(otherEmail?.id).toBeTruthy();

    const ownerAttachmentKey = `incoming/${session.id}/${ownerEmail?.id}/owner-note.txt`;
    await bindings().ATTACHMENTS.put(ownerAttachmentKey, 'owner attachment', {
      httpMetadata: { contentType: 'text/plain' },
    });

    const ownerAttachment = await bindings()
      .DB.prepare(
        `
          INSERT INTO attachments
            (user_id, email_id, sent_email_id, storage_key, filename, mime_type, size_bytes, content_id, disposition)
          VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, 'attachment')
          RETURNING id
        `
      )
      .bind(session.id, ownerEmail?.id, ownerAttachmentKey, 'owner-note.txt', 'text/plain', 16)
      .first<{ id: number }>();

    const authHeader = { Authorization: `Bearer ${session.token}` };

    const listResponse = await apiRequest('/api/emails?folder=inbox&limit=500&offset=-10', {
      headers: authHeader,
    });
    expect(listResponse.status).toBe(200);

    const listBody = await readJson<Array<{ id: number }>>(listResponse);
    expect(listBody).toHaveLength(1);
    expect(listBody[0].id).toBe(ownerEmail?.id);

    const detailResponse = await apiRequest(`/api/emails/${ownerEmail?.id}`, {
      headers: authHeader,
    });
    expect(detailResponse.status).toBe(200);

    const detailBody = await readJson<{
      id: number;
      attachments: Array<{ id: number }>;
    }>(detailResponse);

    expect(detailBody.id).toBe(ownerEmail?.id);
    expect(detailBody.attachments).toHaveLength(1);
    expect(detailBody.attachments[0].id).toBe(ownerAttachment?.id);

    const readState = await bindings()
      .DB.prepare('SELECT read FROM emails WHERE id = ?')
      .bind(ownerEmail?.id)
      .first<{ read: number }>();
    expect(readState?.read).toBe(1);

    const invalidIdResponse = await apiRequest('/api/emails/not-a-number', {
      headers: authHeader,
    });
    expect(invalidIdResponse.status).toBe(400);

    const deleteResponse = await apiRequest(`/api/emails/${ownerEmail?.id}`, {
      method: 'DELETE',
      headers: authHeader,
    });
    expect(deleteResponse.status).toBe(200);

    const inboxAfterDelete = await apiRequest('/api/emails?folder=inbox', {
      headers: authHeader,
    });
    expect(inboxAfterDelete.status).toBe(200);
    expect(await readJson<Array<{ id: number }>>(inboxAfterDelete)).toHaveLength(0);

    const trashAfterDelete = await apiRequest('/api/emails?folder=trash', {
      headers: authHeader,
    });
    const trashBody = await readJson<Array<{ id: number }>>(trashAfterDelete);
    expect(trashBody).toHaveLength(1);
    expect(trashBody[0].id).toBe(ownerEmail?.id);
  });

  it('returns sent mailbox details and supports authenticated attachment download', async () => {
    const session = await createAuthenticatedSession({
      username: 'sender',
      email: 'sender@mail.example.test',
      password: 'Sender-Pass-123',
    });

    const sentRow = await bindings()
      .DB.prepare(
        `
          INSERT INTO sent_emails (user_id, to_address, subject, body_text, body_html)
          VALUES (?, ?, ?, ?, ?)
          RETURNING id
        `
      )
      .bind(session.id, 'recipient@example.net', 'Outbound subject', 'Sent body', null)
      .first<{ id: number }>();

    expect(sentRow?.id).toBeTruthy();

    const storageKey = `sent/${session.id}/${sentRow?.id}/invoice.txt`;
    await bindings().ATTACHMENTS.put(storageKey, 'invoice-content', {
      httpMetadata: { contentType: 'text/plain' },
    });

    const attachmentRow = await bindings()
      .DB.prepare(
        `
          INSERT INTO attachments
            (user_id, email_id, sent_email_id, storage_key, filename, mime_type, size_bytes, content_id, disposition)
          VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, 'attachment')
          RETURNING id
        `
      )
      .bind(session.id, sentRow?.id, storageKey, 'invoice.txt', 'text/plain', 15)
      .first<{ id: number }>();

    const authHeader = { Authorization: `Bearer ${session.token}` };

    const sentListResponse = await apiRequest('/api/sent', {
      headers: authHeader,
    });
    expect(sentListResponse.status).toBe(200);

    const sentListBody = await readJson<Array<{ id: number }>>(sentListResponse);
    expect(sentListBody).toHaveLength(1);
    expect(sentListBody[0].id).toBe(sentRow?.id);

    const sentDetailResponse = await apiRequest(`/api/sent/${sentRow?.id}`, {
      headers: authHeader,
    });
    expect(sentDetailResponse.status).toBe(200);

    const sentDetail = await readJson<{
      id: number;
      attachments: Array<{ id: number; filename: string }>;
    }>(sentDetailResponse);
    expect(sentDetail.id).toBe(sentRow?.id);
    expect(sentDetail.attachments).toHaveLength(1);
    expect(sentDetail.attachments[0].filename).toBe('invoice.txt');

    const downloadResponse = await apiRequest(`/api/attachments/${attachmentRow?.id}/download`, {
      headers: authHeader,
    });
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get('content-type')).toContain('text/plain');
    expect(downloadResponse.headers.get('content-disposition')).toContain('invoice.txt');
    expect(await downloadResponse.text()).toBe('invoice-content');
  });

  it('validates send payload attachments before attempting SMTP delivery', async () => {
    const session = await createAuthenticatedSession({
      username: 'composer',
      email: 'composer@mail.example.test',
      password: 'Compose-Pass-123',
    });

    const authHeaders = {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
    };

    const attachmentsNotArray = await apiRequest('/api/send', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        to: 'recipient@example.net',
        subject: 'Test',
        text: 'Hello',
        attachments: { bad: 'shape' },
      }),
    });

    expect(attachmentsNotArray.status).toBe(400);
    expect((await readJson<{ error: string }>(attachmentsNotArray)).error).toContain('attachments must be an array');

    const invalidBase64 = await apiRequest('/api/send', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        to: 'recipient@example.net',
        subject: 'Test',
        text: 'Hello',
        attachments: [
          {
            filename: 'bad.txt',
            content: '%%%not-base64%%%',
          },
        ],
      }),
    });

    expect(invalidBase64.status).toBe(400);
    expect((await readJson<{ error: string }>(invalidBase64)).error).toContain('invalid base64');

    const tooManyAttachments = await apiRequest('/api/send', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        to: 'recipient@example.net',
        subject: 'Test',
        text: 'Hello',
        attachments: Array.from({ length: 11 }, (_, index) => ({
          filename: `file-${index}.txt`,
          content: 'YQ==',
        })),
      }),
    });

    expect(tooManyAttachments.status).toBe(400);
    expect((await readJson<{ error: string }>(tooManyAttachments)).error).toContain('Too many attachments');
  });
});
