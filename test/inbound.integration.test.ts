import { beforeEach, describe, expect, it } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.ts';
import { handleIncomingEmail } from '../src/inbound.ts';
import type { Env } from '../src/index';
import { getBindings, resetState, seedLegacyUser } from './helpers';

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

function createForwardableEmailMessage(rawEmail: string, toAddress: string): {
  message: any;
  rejections: string[];
} {
  const stream = new Response(rawEmail).body;
  if (!stream) {
    throw new Error('Failed to create raw email stream');
  }

  const rejections: string[] = [];

  const message = {
    from: 'sender@example.net',
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
