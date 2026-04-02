import PostalMime from 'postal-mime';
import type { Env } from './index';

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim();
  const safe = trimmed.replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '_').replace(/\s+/g, ' ');
  if (!safe) return 'attachment';
  return safe.slice(0, 180);
}

function buildStorageKey(userId: number, emailId: number, filename: string): string {
  return `incoming/${userId}/${emailId}/${crypto.randomUUID()}-${filename}`;
}

export async function handleIncomingEmail(
  message: ForwardableEmailMessage,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  const parsed = await PostalMime.parse(message.raw);

  const toAddress = message.to.toLowerCase().trim();

  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(toAddress)
    .first<{ id: number }>();

  if (!user) {
    message.setReject(`No mailbox for ${toAddress}`);
    return;
  }

  const bodyText = parsed.text ?? null;
  const bodyHtml = parsed.html ?? null;
  const fromAddr = parsed.from?.address ?? message.from;
  const fromName = parsed.from?.name ?? null;
  const subject = parsed.subject ?? '(no subject)';
  const msgId = parsed.messageId ?? null;
  const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];

  const insertedEmail = await env.DB.prepare(
    `
      INSERT INTO emails
        (user_id, message_id, from_address, from_name, to_address,
         subject, body_text, body_html, raw_size, folder)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox')
      RETURNING id
    `
  )
    .bind(
      user.id,
      msgId,
      fromAddr,
      fromName,
      toAddress,
      subject,
      bodyText,
      bodyHtml,
      message.rawSize
    )
    .first<{ id: number }>();

  if (!insertedEmail) {
    throw new Error('Failed to insert inbound email');
  }

  const emailId = insertedEmail.id;

  for (let i = 0; i < attachments.length; i += 1) {
    const attachment = attachments[i];
    const originalFilename =
      typeof attachment.filename === 'string' && attachment.filename.trim().length > 0
        ? attachment.filename
        : `attachment-${i + 1}`;
    const filename = sanitizeFilename(originalFilename);
    const mimeType =
      typeof attachment.mimeType === 'string' && attachment.mimeType.trim().length > 0
        ? attachment.mimeType
        : 'application/octet-stream';
    const content = attachment.content instanceof Uint8Array ? attachment.content : new Uint8Array(0);
    const storageKey = buildStorageKey(user.id, emailId, filename);

    try {
      await env.ATTACHMENTS.put(storageKey, content, {
        httpMetadata: { contentType: mimeType },
      });

      await env.DB.prepare(
        `
          INSERT INTO attachments
            (user_id, email_id, sent_email_id, storage_key, filename, mime_type, size_bytes, content_id, disposition)
          VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
        `
      )
        .bind(
          user.id,
          emailId,
          storageKey,
          filename,
          mimeType,
          content.byteLength,
          typeof attachment.contentId === 'string' ? attachment.contentId : null,
          typeof attachment.disposition === 'string' ? attachment.disposition : null
        )
        .run();
    } catch (err) {
      console.error(`Failed to persist inbound attachment for email ${emailId}:`, err);
    }
  }

  if (attachments.length > 0) {
    console.log(`Email ${msgId ?? '(no-message-id)'} stored ${attachments.length} attachment(s)`);
  }
}
