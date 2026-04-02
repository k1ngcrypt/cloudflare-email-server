import PostalMime from 'postal-mime';
import type { Env } from './index';

const MAX_INBOUND_ATTACHMENT_COUNT = 25;
const MAX_INBOUND_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

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
  let emailId: number | null = null;
  const uploadedAttachmentKeys: string[] = [];

  try {
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

    if (attachments.length > MAX_INBOUND_ATTACHMENT_COUNT) {
      message.setReject(`Too many attachments (max ${MAX_INBOUND_ATTACHMENT_COUNT})`);
      return;
    }

    let totalAttachmentBytes = 0;
    for (const attachment of attachments) {
      if (!(attachment.content instanceof Uint8Array)) {
        throw new Error('Attachment payload is invalid');
      }

      totalAttachmentBytes += attachment.content.byteLength;
      if (totalAttachmentBytes > MAX_INBOUND_TOTAL_ATTACHMENT_BYTES) {
        message.setReject(`Total attachment size exceeds ${MAX_INBOUND_TOTAL_ATTACHMENT_BYTES} bytes`);
        return;
      }
    }

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

    emailId = insertedEmail.id;

    for (let i = 0; i < attachments.length; i += 1) {
      const attachment = attachments[i];

      if (!(attachment.content instanceof Uint8Array)) {
        throw new Error(`Attachment ${i + 1} has invalid content`);
      }

      const originalFilename =
        typeof attachment.filename === 'string' && attachment.filename.trim().length > 0
          ? attachment.filename
          : `attachment-${i + 1}`;
      const filename = sanitizeFilename(originalFilename);
      const mimeType =
        typeof attachment.mimeType === 'string' && attachment.mimeType.trim().length > 0
          ? attachment.mimeType
          : 'application/octet-stream';
      const content = attachment.content;
      const storageKey = buildStorageKey(user.id, emailId, filename);

      await env.ATTACHMENTS.put(storageKey, content, {
        httpMetadata: { contentType: mimeType },
      });

      uploadedAttachmentKeys.push(storageKey);

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
    }

    if (attachments.length > 0) {
      console.log(`Email ${msgId ?? '(no-message-id)'} stored ${attachments.length} attachment(s)`);
    }
  } catch (err) {
    console.error('Inbound email processing failed:', err);

    for (const storageKey of uploadedAttachmentKeys) {
      try {
        await env.ATTACHMENTS.delete(storageKey);
      } catch (cleanupErr) {
        console.error(`Failed to cleanup inbound attachment ${storageKey}:`, cleanupErr);
      }
    }

    if (emailId !== null) {
      try {
        await env.DB.prepare('DELETE FROM attachments WHERE email_id = ?')
          .bind(emailId)
          .run();
        await env.DB.prepare('DELETE FROM emails WHERE id = ?')
          .bind(emailId)
          .run();
      } catch (cleanupErr) {
        console.error(`Failed to cleanup inbound email ${emailId}:`, cleanupErr);
      }
    }

    message.setReject('Temporary processing failure');
  }
}
