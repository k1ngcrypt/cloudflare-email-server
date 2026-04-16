import PostalMime from 'postal-mime';
import type { Env } from './index';
import { normalizeMimeType, sanitizeFilename } from './attachment-utils';
import { findUserIdByEmailAddress, normalizeEmailAddress } from './user-addresses';

const MAX_INBOUND_ATTACHMENT_COUNT = 25;
const MAX_INBOUND_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function toAttachmentBytes(content: unknown): Uint8Array | null {
  if (content instanceof Uint8Array) {
    return content;
  }

  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }

  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }

  return null;
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
    const toAddress = normalizeEmailAddress(message.to);

    const userId = await findUserIdByEmailAddress(env, toAddress);

    if (!userId) {
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
    const normalizedAttachments: Array<{
      attachment: (typeof attachments)[number];
      bytes: Uint8Array;
    }> = [];

    if (attachments.length > MAX_INBOUND_ATTACHMENT_COUNT) {
      message.setReject(`Too many attachments (max ${MAX_INBOUND_ATTACHMENT_COUNT})`);
      return;
    }

    let totalAttachmentBytes = 0;
    for (const attachment of attachments) {
      const bytes = toAttachmentBytes(attachment.content);
      if (!bytes) {
        throw new Error('Attachment payload is invalid');
      }

      totalAttachmentBytes += bytes.byteLength;
      if (totalAttachmentBytes > MAX_INBOUND_TOTAL_ATTACHMENT_BYTES) {
        message.setReject(`Total attachment size exceeds ${MAX_INBOUND_TOTAL_ATTACHMENT_BYTES} bytes`);
        return;
      }

      normalizedAttachments.push({ attachment, bytes });
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
        userId,
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

    for (let i = 0; i < normalizedAttachments.length; i += 1) {
      const { attachment, bytes: content } = normalizedAttachments[i];

      const originalFilename =
        typeof attachment.filename === 'string' && attachment.filename.trim().length > 0
          ? attachment.filename
          : `attachment-${i + 1}`;
      const filename = sanitizeFilename(originalFilename);
      const mimeType = normalizeMimeType(attachment.mimeType);
      const storageKey = buildStorageKey(userId, emailId, filename);

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
          userId,
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

    if (normalizedAttachments.length > 0) {
      console.log(
        `Email ${msgId ?? '(no-message-id)'} stored ${normalizedAttachments.length} attachment(s)`
      );
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
