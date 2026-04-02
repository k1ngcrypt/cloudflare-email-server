import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index';

const { connectMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
}));

vi.mock('worker-mailer', () => ({
  WorkerMailer: {
    connect: connectMock,
  },
}));

import { sendEmail } from '../src/send';

function makeEnv(): Env {
  return {
    DB: {} as D1Database,
    ATTACHMENTS: {} as R2Bucket,
    FROM_DOMAIN: 'mail.example.test',
    OCI_SMTP_HOST: 'smtp.email.example.test',
    OCI_SMTP_PORT: '587',
    OCI_SMTP_USER: 'smtp-user',
    OCI_SMTP_PASS: 'smtp-pass',
    AUTH_SECRET: 'test-auth-secret',
  };
}

describe('sendEmail', () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it('connects with STARTTLS, sends the message, and closes the connection', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const closeMock = vi.fn().mockResolvedValue(undefined);
    connectMock.mockResolvedValue({ send: sendMock, close: closeMock });

    await sendEmail(makeEnv(), {
      from: 'sender@mail.example.test',
      to: 'recipient@example.net',
      subject: 'Integration Subject',
      text: 'Plain body',
    });

    expect(connectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.email.example.test',
        port: 587,
        secure: false,
        startTls: true,
        authType: 'plain',
      })
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as Record<string, unknown>;

    expect(payload).toMatchObject({
      from: { name: 'Webmail', email: 'sender@mail.example.test' },
      to: { email: 'recipient@example.net' },
      subject: 'Integration Subject',
      text: 'Plain body',
    });
    expect(payload).not.toHaveProperty('html');
    expect(payload).not.toHaveProperty('attachments');
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('includes optional html and attachments in the outbound payload', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const closeMock = vi.fn().mockResolvedValue(undefined);
    connectMock.mockResolvedValue({ send: sendMock, close: closeMock });

    await sendEmail(makeEnv(), {
      from: 'sender@mail.example.test',
      to: 'recipient@example.net',
      subject: 'Attachment Subject',
      text: 'Plain body',
      html: '<p>HTML body</p>',
      attachments: [
        {
          filename: 'proof.txt',
          content: 'YQ==',
          mimeType: 'text/plain',
        },
      ],
    });

    const payload = sendMock.mock.calls[0][0] as {
      html?: string;
      attachments?: Array<{ filename: string; content: string; mimeType?: string }>;
    };

    expect(payload.html).toBe('<p>HTML body</p>');
    expect(payload.attachments).toEqual([
      {
        filename: 'proof.txt',
        content: 'YQ==',
        mimeType: 'text/plain',
      },
    ]);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('closes the mailer even when sending fails', async () => {
    const sendMock = vi.fn().mockRejectedValue(new Error('SMTP send failed'));
    const closeMock = vi.fn().mockResolvedValue(undefined);
    connectMock.mockResolvedValue({ send: sendMock, close: closeMock });

    await expect(
      sendEmail(makeEnv(), {
        from: 'sender@mail.example.test',
        to: 'recipient@example.net',
        subject: 'Failure Subject',
        text: 'Body',
      })
    ).rejects.toThrow('SMTP send failed');

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('supports mailer implementations that do not expose close()', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    connectMock.mockResolvedValue({ send: sendMock });

    await expect(
      sendEmail(makeEnv(), {
        from: 'sender@mail.example.test',
        to: 'recipient@example.net',
        subject: 'No Close Subject',
        text: 'Body',
      })
    ).resolves.toBeUndefined();

    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});