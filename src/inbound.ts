import PostalMime from 'postal-mime';
import type { Env } from './index';

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

  await env.DB.prepare(
    `
      INSERT INTO emails
        (user_id, message_id, from_address, from_name, to_address,
         subject, body_text, body_html, raw_size, folder)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox')
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
    .run();

  if (parsed.attachments.length > 0) {
    console.log(
      `Email ${msgId ?? '(no-message-id)'} has ${parsed.attachments.length} attachment(s) - storage not implemented`
    );
  }
}
