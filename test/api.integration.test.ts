import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index';
import {
  addUserEmailAddress,
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

  it('responds to CORS preflight for trusted origins and withholds headers for untrusted origins', async () => {
    const trusted = await apiRequest('/api/me', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://webmail.test',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(trusted.status).toBe(204);
    expect(trusted.headers.get('access-control-allow-origin')).toBe('https://webmail.test');
    expect(trusted.headers.get('access-control-allow-credentials')).toBe('true');
    expect(trusted.headers.get('access-control-allow-methods')).toContain('GET');

    const untrusted = await apiRequest('/api/me', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://attacker.example',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(untrusted.status).toBe(204);
    expect(untrusted.headers.get('access-control-allow-origin')).toBeNull();
    expect(untrusted.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('serves the unified login shell with hardened headers', async () => {
    const response = await apiRequest('/login');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");

    const body = await response.text();
    expect(body).toContain('Unified Login');
  });

  it('applies page route redirects for anonymous, user, and admin sessions', async () => {
    const root = await apiRequest('/', { redirect: 'manual' });
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/login');

    const anonymousMail = await apiRequest('/mail', { redirect: 'manual' });
    expect(anonymousMail.status).toBe(302);
    expect(anonymousMail.headers.get('location')).toBe('/login');

    const anonymousAdmin = await apiRequest('/admin', { redirect: 'manual' });
    expect(anonymousAdmin.status).toBe(302);
    expect(anonymousAdmin.headers.get('location')).toBe('/login');

    const adminSession = await createAuthenticatedSession({
      username: 'admin-route-user',
      email: 'admin-route-user@mail.example.test',
      password: 'Admin-Route-Password-123',
    });

    const loginWhenAuthenticated = await apiRequest('/login', {
      redirect: 'manual',
      headers: {
        Cookie: adminSession.cookie,
      },
    });
    expect(loginWhenAuthenticated.status).toBe(302);
    expect(loginWhenAuthenticated.headers.get('location')).toBe('/mail');

    const adminPage = await apiRequest('/admin', {
      headers: {
        Cookie: adminSession.cookie,
      },
    });
    expect(adminPage.status).toBe(200);
    expect(await adminPage.text()).toContain('User Administration');

    const regularUser = await seedLegacyUser({
      username: 'member-route-user',
      email: 'member-route-user@mail.example.test',
      password: 'Member-Route-Password-123',
    });

    const regularLogin = await login(regularUser.username, regularUser.password);
    expect(regularLogin.response.status).toBe(200);
    expect(regularLogin.cookie).not.toBeNull();

    const adminAsRegularUser = await apiRequest('/admin', {
      redirect: 'manual',
      headers: {
        Cookie: regularLogin.cookie as string,
      },
    });
    expect(adminAsRegularUser.status).toBe(302);
    expect(adminAsRegularUser.headers.get('location')).toBe('/mail');
  });

  it('requires authentication for protected endpoints', async () => {
    const response = await apiRequest('/api/me');

    expect(response.status).toBe(401);

    const body = await readJson<{ error: string }>(response);
    expect(body.error).toBe('Unauthorized');
  });

  it('validates malformed and incomplete login payloads', async () => {
    const malformedJson = await apiRequest('/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: '{',
    });

    expect(malformedJson.status).toBe(400);
    expect((await readJson<{ error: string }>(malformedJson)).error).toContain('required');

    const emptyUsername = await login('   ', 'has-password');
    expect(emptyUsername.response.status).toBe(400);

    const missingPassword = await apiRequest('/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'alice' }),
    });

    expect(missingPassword.status).toBe(400);
    expect((await readJson<{ error: string }>(missingPassword)).error).toContain('required');
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

    const meBody = await readJson<{ username: string; email: string; emails: string[] }>(meResponse);
    expect(meBody.username).toBe(user.username);
    expect(meBody.email).toBe(user.email);
    expect(meBody.emails).toContain(user.email);

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

  it('scopes login throttling by both client IP and username', async () => {
    const blockedUser = await seedLegacyUser({
      username: 'blocked-user',
      email: 'blocked-user@mail.example.test',
      password: 'Blocked-Password-123',
    });

    const unaffectedUser = await seedLegacyUser({
      username: 'unaffected-user',
      email: 'unaffected-user@mail.example.test',
      password: 'Unaffected-Password-123',
    });

    const sharedIpHeaders = {
      'CF-Connecting-IP': '198.51.100.77',
    };

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await login(blockedUser.username, `wrong-${attempt}`, sharedIpHeaders);
    }

    const blockedResponse = await login(blockedUser.username, blockedUser.password, sharedIpHeaders);
    expect(blockedResponse.response.status).toBe(429);

    const differentIpCanLogin = await login(blockedUser.username, blockedUser.password, {
      'CF-Connecting-IP': '198.51.100.88',
    });
    expect(differentIpCanLogin.response.status).toBe(200);

    const differentUsernameCanLogin = await login(
      unaffectedUser.username,
      unaffectedUser.password,
      sharedIpHeaders
    );
    expect(differentUsernameCanLogin.response.status).toBe(200);
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

    const mixedIdResponse = await apiRequest(`/api/emails/${ownerEmail?.id}abc`, {
      headers: authHeader,
    });
    expect(mixedIdResponse.status).toBe(400);

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

    const restoreResponse = await apiRequest(`/api/emails/${ownerEmail?.id}/restore`, {
      method: 'POST',
      headers: authHeader,
    });
    expect(restoreResponse.status).toBe(200);

    const inboxAfterRestore = await apiRequest('/api/emails?folder=inbox', {
      headers: authHeader,
    });
    const inboxAfterRestoreBody = await readJson<Array<{ id: number }>>(inboxAfterRestore);
    expect(inboxAfterRestoreBody).toHaveLength(1);
    expect(inboxAfterRestoreBody[0].id).toBe(ownerEmail?.id);

    const hardDeleteFromInbox = await apiRequest(`/api/emails/${ownerEmail?.id}?hard=1`, {
      method: 'DELETE',
      headers: authHeader,
    });
    expect(hardDeleteFromInbox.status).toBe(400);

    const moveToTrashAgain = await apiRequest(`/api/emails/${ownerEmail?.id}`, {
      method: 'DELETE',
      headers: authHeader,
    });
    expect(moveToTrashAgain.status).toBe(200);

    const hardDeleteFromTrash = await apiRequest(`/api/emails/${ownerEmail?.id}?hard=1`, {
      method: 'DELETE',
      headers: authHeader,
    });
    expect(hardDeleteFromTrash.status).toBe(200);

    const trashAfterHardDelete = await apiRequest('/api/emails?folder=trash', {
      headers: authHeader,
    });
    expect(await readJson<Array<{ id: number }>>(trashAfterHardDelete)).toHaveLength(0);

    const emailAfterHardDelete = await apiRequest(`/api/emails/${ownerEmail?.id}`, {
      headers: authHeader,
    });
    expect(emailAfterHardDelete.status).toBe(404);

    const attachmentMetadataAfterHardDelete = await bindings()
      .DB.prepare('SELECT COUNT(*) AS count FROM attachments WHERE id = ?')
      .bind(ownerAttachment?.id)
      .first<{ count: number }>();
    expect(attachmentMetadataAfterHardDelete?.count ?? 0).toBe(0);

    const attachmentObjectAfterHardDelete = await bindings().ATTACHMENTS.get(ownerAttachmentKey);
    expect(attachmentObjectAfterHardDelete).toBeNull();
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

    const mixedSentIdResponse = await apiRequest(`/api/sent/${sentRow?.id}abc`, {
      headers: authHeader,
    });
    expect(mixedSentIdResponse.status).toBe(400);

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

    const deleteSentResponse = await apiRequest(`/api/sent/${sentRow?.id}`, {
      method: 'DELETE',
      headers: authHeader,
    });
    expect(deleteSentResponse.status).toBe(200);

    const sentAfterDelete = await apiRequest('/api/sent', {
      headers: authHeader,
    });
    expect(await readJson<Array<{ id: number }>>(sentAfterDelete)).toHaveLength(0);

    const sentDetailAfterDelete = await apiRequest(`/api/sent/${sentRow?.id}`, {
      headers: authHeader,
    });
    expect(sentDetailAfterDelete.status).toBe(404);

    const sentAttachmentMetadataAfterDelete = await bindings()
      .DB.prepare('SELECT COUNT(*) AS count FROM attachments WHERE sent_email_id = ?')
      .bind(sentRow?.id)
      .first<{ count: number }>();
    expect(sentAttachmentMetadataAfterDelete?.count ?? 0).toBe(0);

    const sentAttachmentObjectAfterDelete = await bindings().ATTACHMENTS.get(storageKey);
    expect(sentAttachmentObjectAfterDelete).toBeNull();
  });

  it('returns attachment download errors for missing metadata or missing R2 objects', async () => {
    const session = await createAuthenticatedSession({
      username: 'download-user',
      email: 'download-user@mail.example.test',
      password: 'Download-Pass-123',
    });

    const authHeader = { Authorization: `Bearer ${session.token}` };

    const missingMetadata = await apiRequest('/api/attachments/999999/download', {
      headers: authHeader,
    });
    expect(missingMetadata.status).toBe(404);
    expect((await readJson<{ error: string }>(missingMetadata)).error).toContain('Attachment not found');

    const orphanAttachment = await bindings()
      .DB.prepare(
        `
          INSERT INTO attachments
            (user_id, email_id, sent_email_id, storage_key, filename, mime_type, size_bytes, content_id, disposition)
          VALUES (?, NULL, NULL, ?, ?, ?, ?, NULL, 'attachment')
          RETURNING id
        `
      )
      .bind(session.id, 'missing/object/key', 'missing.txt', 'text/plain', 5)
      .first<{ id: number }>();

    const missingObject = await apiRequest(`/api/attachments/${orphanAttachment?.id}/download`, {
      headers: authHeader,
    });

    expect(missingObject.status).toBe(404);
    expect((await readJson<{ error: string }>(missingObject)).error).toContain(
      'Attachment content not found'
    );
  });

  it('escapes unsafe attachment filenames in content-disposition headers', async () => {
    const session = await createAuthenticatedSession({
      username: 'filename-user',
      email: 'filename-user@mail.example.test',
      password: 'Filename-Pass-123',
    });

    const storageKey = `incoming/${session.id}/unsafe-name`;
    await bindings().ATTACHMENTS.put(storageKey, 'unsafe');

    const attachment = await bindings()
      .DB.prepare(
        `
          INSERT INTO attachments
            (user_id, email_id, sent_email_id, storage_key, filename, mime_type, size_bytes, content_id, disposition)
          VALUES (?, NULL, NULL, ?, ?, ?, ?, NULL, 'attachment')
          RETURNING id
        `
      )
      .bind(session.id, storageKey, 'bad"name\\\r\n.txt', 'text/plain', 6)
      .first<{ id: number }>();

    const response = await apiRequest(`/api/attachments/${attachment?.id}/download`, {
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });

    expect(response.status).toBe(200);
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment; filename="');
    expect(disposition).toContain('bad_name');
    expect(disposition).not.toContain('bad"name');
    expect(disposition).not.toContain('\\');
    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('\n');
  });

  it('validates send payload attachments before attempting HTTPS delivery', async () => {
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

    const missingFields = await apiRequest('/api/send', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        to: 'recipient@example.net',
        subject: 'Missing text',
      }),
    });

    expect(missingFields.status).toBe(400);
    expect((await readJson<{ error: string }>(missingFields)).error).toContain('required');

    const invalidAttachmentShape = await apiRequest('/api/send', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        to: 'recipient@example.net',
        subject: 'Test',
        text: 'Hello',
        attachments: [null],
      }),
    });

    expect(invalidAttachmentShape.status).toBe(400);
    expect((await readJson<{ error: string }>(invalidAttachmentShape)).error).toContain(
      'Invalid attachment at index 0'
    );

    const dataUrlWithoutPayload = await apiRequest('/api/send', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        to: 'recipient@example.net',
        subject: 'Test',
        text: 'Hello',
        attachments: [
          {
            filename: 'empty.txt',
            content: 'data:text/plain;base64',
          },
        ],
      }),
    });

    expect(dataUrlWithoutPayload.status).toBe(400);
    expect((await readJson<{ error: string }>(dataUrlWithoutPayload)).error).toContain('has no content');
  });

  it('returns account address aliases from /api/me and validates selected from address ownership', async () => {
    const session = await createAuthenticatedSession({
      username: 'multi-address-composer',
      email: 'primary-compose@mail.example.test',
      password: 'Compose-Multi-Pass-123',
    });

    await addUserEmailAddress(session.id, 'alias-compose@mail.example.test');

    const meResponse = await apiRequest('/api/me', {
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });

    expect(meResponse.status).toBe(200);
    const meBody = await readJson<{ email: string; emails: string[] }>(meResponse);
    expect(meBody.email).toBe('primary-compose@mail.example.test');
    expect(meBody.emails).toEqual([
      'primary-compose@mail.example.test',
      'alias-compose@mail.example.test',
    ]);

    const unauthorizedFromResponse = await apiRequest('/api/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'attacker@example.net',
        to: 'recipient@example.net',
        subject: 'Unauthorized From',
        text: 'Body',
      }),
    });

    expect(unauthorizedFromResponse.status).toBe(403);
    expect((await readJson<{ error: string }>(unauthorizedFromResponse)).error).toContain(
      'not assigned to this account'
    );

    const malformedFromResponse = await apiRequest('/api/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'not-an-email',
        to: 'recipient@example.net',
        subject: 'Malformed From',
        text: 'Body',
      }),
    });

    expect(malformedFromResponse.status).toBe(400);
    expect((await readJson<{ error: string }>(malformedFromResponse)).error).toContain(
      'from must be a valid email address'
    );

    const authorizedAliasResponse = await apiRequest('/api/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'alias-compose@mail.example.test',
        to: 'recipient@example.net',
        subject: 'Authorized From',
        text: 'Body',
        attachments: [null],
      }),
    });

    expect(authorizedAliasResponse.status).toBe(400);
    expect((await readJson<{ error: string }>(authorizedAliasResponse)).error).toContain(
      'Invalid attachment at index 0'
    );
  });

  it('returns not found for unknown authenticated routes', async () => {
    const session = await createAuthenticatedSession({
      username: 'unknown-route-user',
      email: 'unknown-route-user@mail.example.test',
      password: 'Unknown-Route-Pass-123',
    });

    const response = await apiRequest('/api/no-such-route', {
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });

    expect(response.status).toBe(404);
    expect((await readJson<{ error: string }>(response)).error).toBe('Not found');
  });
});
