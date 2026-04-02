import { WorkerMailer } from 'worker-mailer';
import type { Env } from './index';

export interface SendAttachment {
  filename: string;
  content: string;
  mimeType?: string;
}

interface SendOptions {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: SendAttachment[];
}

export async function sendEmail(env: Env, opts: SendOptions): Promise<void> {
  const mailer = await WorkerMailer.connect({
    host: env.OCI_SMTP_HOST,
    port: Number.parseInt(env.OCI_SMTP_PORT, 10),
    secure: false,
    startTls: true,
    credentials: {
      username: env.OCI_SMTP_USER,
      password: env.OCI_SMTP_PASS,
    },
    authType: 'plain',
  } as never);

  await mailer.send({
    from: { name: 'Webmail', email: opts.from },
    to: { email: opts.to },
    subject: opts.subject,
    text: opts.text,
    ...(opts.html ? { html: opts.html } : {}),
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
  });
}
