import { beforeEach, describe, expect, it } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.ts';
import { handleIncomingEmail } from '../src/inbound.ts';
import type { Env } from '../src/index';
import { addUserEmailAddress, getBindings, resetState, seedLegacyUser } from './helpers';

function buildPlainTextMime(toAddress: string): string {
  return [
    'From: "Sender" <sender@example.net>',
    `To: ${toAddress}`,
    'Subject: Plain inbound',
    'Message-ID: <plain-inbound@example.net>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello from inbound plain text.',
  ].join('\r\n');
}

function buildMultipartMime(toAddress: string): string {
  return [
    'From: "Sender" <sender@example.net>',
    `To: ${toAddress}`,
    'Subject: Inbound with attachment',
    'Message-ID: <multipart-inbound@example.net>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="cf-boundary"',
    '',
    '--cf-boundary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Body line with attachment.',
    '--cf-boundary',
    'Content-Type: application/octet-stream; name="proof.txt"',
    'Content-Disposition: attachment; filename="proof.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    'aGVsbG8gYXR0YWNobWVudA==',
    '--cf-boundary--',
  ].join('\r\n');
}

function buildMimeWithoutFromOrSubject(toAddress: string): string {
  return [
    `To: ${toAddress}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Fallback metadata body.',
  ].join('\r\n');
}

function buildMultipartMimeWithAttachmentCount(toAddress: string, count: number): string {
  const lines = [
    'From: "Sender" <sender@example.net>',
    `To: ${toAddress}`,
    `Subject: Too many attachments (${count})`,
    'Message-ID: <too-many-attachments@example.net>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="many-boundary"',
    '',
    '--many-boundary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'This message intentionally has many attachments.',
  ];

  for (let i = 0; i < count; i += 1) {
    lines.push('--many-boundary');
    lines.push(`Content-Type: text/plain; name="file-${i + 1}.txt"`);
    lines.push(`Content-Disposition: attachment; filename="file-${i + 1}.txt"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push('YQ==');
  }

  lines.push('--many-boundary--');
  return lines.join('\r\n');
}

function createForwardableEmailMessage(
  rawEmail: string,
  toAddress: string,
  envelopeFrom = 'sender@example.net'
): {
  message: any;
  rejections: string[];
} {
  const stream = new Response(rawEmail).body;
  if (!stream) {
    throw new Error('Failed to create raw email stream');
  }

  const rejections: string[] = [];

  const message = {
    from: envelopeFrom,
    to: toAddress,
    raw: stream,
    rawSize: new TextEncoder().encode(rawEmail).byteLength,
    setReject(reason: string): void {
      rejections.push(reason);
    },
    forward: async (): Promise<void> => {
      throw new Error('forward() should not be called in inbound tests');
    },
  } as any;

  return { message, rejections };
}

describe('inbound email handler integration', () => {
  beforeEach(async () => {
    await resetState();
  });

  it('rejects unknown recipients and does not persist mail', async () => {
    const toAddress = 'missing-user@mail.example.test';
    const { message, rejections } = createForwardableEmailMessage(
      buildPlainTextMime(toAddress),
      toAddress
    );

    const ctx = createExecutionContext();
    await worker.email(message, getBindings(), ctx);
    await waitOnExecutionContext(ctx);

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain('No mailbox');

    const emailCount = await getBindings()
      .DB.prepare('SELECT COUNT(*) AS count FROM emails')
      .first<{ count: number }>();
    expect(emailCount?.count ?? 0).toBe(0);
  });

  it('routes inbound mail addressed to a user alias', async () => {
    const user = await seedLegacyUser({
      username: 'alias-recipient-user',
      email: 'primary-alias@mail.example.test',
      password: 'Alias-Inbound-Pass-123',
    });

    await addUserEmailAddress(user.id, 'support-alias@mail.example.test');

    const envelopeTo = 'SUPPORT-ALIAS@MAIL.EXAMPLE.TEST';
    const { message, rejections } = createForwardableEmailMessage(
      buildPlainTextMime(envelopeTo),
      envelopeTo
    );

    const ctx = createExecutionContext();
    await worker.email(message, getBindings(), ctx);
    await waitOnExecutionContext(ctx);

    expect(rejections).toHaveLength(0);

    const emailRow = await getBindings()
      .DB.prepare('SELECT user_id, to_address FROM emails WHERE user_id = ? LIMIT 1')
      .bind(user.id)
      .first<{ user_id: number; to_address: string }>();

    expect(emailRow?.user_id).toBe(user.id);
    expect(emailRow?.to_address).toBe('support-alias@mail.example.test');
  });

  it('stores parsed inbound email and attachment metadata in D1 and R2', async () => {
    const user = await seedLegacyUser({
      username: 'inbound-user',
      email: 'inbound-user@mail.example.test',
      password: 'Inbound-Pass-123',
    });

    const raw = buildMultipartMime(user.email);
    const { message, rejections } = createForwardableEmailMessage(raw, user.email);

    const ctx = createExecutionContext();
    await worker.email(message, getBindings(), ctx);
    await waitOnExecutionContext(ctx);

    expect(rejections).toHaveLength(0);

    const emailRow = await getBindings()
      .DB.prepare(
        `
          SELECT id, from_address, from_name, to_address, subject, body_text, body_html, folder, raw_size
          FROM emails
          WHERE user_id = ?
        `
      )
      .bind(user.id)
      .first<{
        id: number;
        from_address: string;
        from_name: string | null;
        to_address: string;
        subject: string;
        body_text: string | null;
        body_html: string | null;
        folder: string;
        raw_size: number;
      }>();

    expect(emailRow).toBeTruthy();
    expect(emailRow?.from_address).toBe('sender@example.net');
    expect(emailRow?.from_name).toBe('Sender');
    expect(emailRow?.to_address).toBe(user.email);
    expect(emailRow?.subject).toBe('Inbound with attachment');
    expect(emailRow?.folder).toBe('inbox');
    expect(emailRow?.body_text).toContain('Body line with attachment.');

    const attachmentRow = await getBindings()
      .DB.prepare(
        `
          SELECT id, storage_key, filename, mime_type, size_bytes
          FROM attachments
          WHERE email_id = ?
        `
      )
      .bind(emailRow?.id)
      .first<{
        id: number;
        storage_key: string;
        filename: string;
        mime_type: string;
        size_bytes: number;
      }>();

    expect(attachmentRow).toBeTruthy();
    expect(attachmentRow?.filename).toBe('proof.txt');
    expect(attachmentRow?.mime_type).toBe('application/octet-stream');
    expect(attachmentRow?.size_bytes).toBeGreaterThan(0);

    const object = await getBindings().ATTACHMENTS.get(attachmentRow?.storage_key as string);
    expect(object).toBeTruthy();
    expect(await object?.text()).toBe('hello attachment');
  });

  it('normalizes recipient casing and falls back to envelope metadata defaults', async () => {
    const user = await seedLegacyUser({
      username: 'normalized-user',
      email: 'normalized-user@mail.example.test',
      password: 'Normalize-Pass-123',
    });

    const envelopeTo = `   ${user.email.toUpperCase()}   `;
    const envelopeFrom = 'envelope-sender@example.net';
    const raw = buildMimeWithoutFromOrSubject(user.email.toUpperCase());

    const { message, rejections } = createForwardableEmailMessage(raw, envelopeTo, envelopeFrom);

    const ctx = createExecutionContext();
    await worker.email(message, getBindings(), ctx);
    await waitOnExecutionContext(ctx);

    expect(rejections).toHaveLength(0);

    const emailRow = await getBindings()
      .DB.prepare(
        `
          SELECT to_address, from_address, from_name, subject, body_text
          FROM emails
          WHERE user_id = ?
        `
      )
      .bind(user.id)
      .first<{
        to_address: string;
        from_address: string;
        from_name: string | null;
        subject: string;
        body_text: string | null;
      }>();

    expect(emailRow).toBeTruthy();
    expect(emailRow?.to_address).toBe(user.email);
    expect(emailRow?.from_address).toBe(envelopeFrom);
    expect(emailRow?.from_name).toBeNull();
    expect(emailRow?.subject).toBe('(no subject)');
    expect(emailRow?.body_text).toContain('Fallback metadata body.');
  });

  it('rejects inbound messages that exceed attachment count limits', async () => {
    const user = await seedLegacyUser({
      username: 'too-many-inbound',
      email: 'too-many-inbound@mail.example.test',
      password: 'Too-Many-Pass-123',
    });

    const raw = buildMultipartMimeWithAttachmentCount(user.email, 26);
    const { message, rejections } = createForwardableEmailMessage(raw, user.email);

    const ctx = createExecutionContext();
    await worker.email(message, getBindings(), ctx);
    await waitOnExecutionContext(ctx);

    expect(rejections).toContain('Too many attachments (max 25)');

    const counts = await Promise.all([
      getBindings().DB.prepare('SELECT COUNT(*) AS count FROM emails').first<{ count: number }>(),
      getBindings().DB.prepare('SELECT COUNT(*) AS count FROM attachments').first<{ count: number }>(),
    ]);

    expect(counts[0]?.count ?? 0).toBe(0);
    expect(counts[1]?.count ?? 0).toBe(0);
  });

  it('rejects with temporary failure and rolls back DB state when storage write fails', async () => {
    const user = await seedLegacyUser({
      username: 'rollback-user',
      email: 'rollback-user@mail.example.test',
      password: 'Rollback-Pass-123',
    });

    const raw = buildMultipartMime(user.email);
    const { message, rejections } = createForwardableEmailMessage(raw, user.email);

    const baseEnv = getBindings();
    const failingEnv: Env = {
      ...baseEnv,
      ATTACHMENTS: {
        put: async (): Promise<void> => {
          throw new Error('simulated r2 write outage');
        },
        delete: async (): Promise<void> => {
          // No-op for this failure mode; put never succeeds.
        },
      } as unknown as Env['ATTACHMENTS'],
    };

    const ctx = createExecutionContext();
    await handleIncomingEmail(message, failingEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(rejections).toContain('Temporary processing failure');

    const emailCount = await baseEnv.DB.prepare('SELECT COUNT(*) AS count FROM emails').first<{ count: number }>();
    const attachmentCount = await baseEnv.DB.prepare('SELECT COUNT(*) AS count FROM attachments').first<{ count: number }>();

    expect(emailCount?.count ?? 0).toBe(0);
    expect(attachmentCount?.count ?? 0).toBe(0);
  });
});
