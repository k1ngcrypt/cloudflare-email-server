import type { Env } from './index';
import { getWebmailHtml } from './webmail.ts';
import { authenticate, createSession, hashPassword } from './auth';
import { sendEmail, type SendAttachment } from './send';

const MAX_ATTACHMENT_COUNT = 10;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

interface AttachmentSummary {
  id: number;
  filename: string;
  mime_type: string | null;
  size_bytes: number;
  content_id: string | null;
  disposition: string | null;
  created_at: string;
}

interface PreparedSendAttachment extends SendAttachment {
  bytes: Uint8Array;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

function withCors(headers: HeadersInit = {}): Headers {
  const out = new Headers(headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    out.set(key, value);
  }
  return out;
}

function json(data: unknown, init?: ResponseInit): Response {
  const headers = withCors(init?.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

async function parseJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function parseIdFromPath(path: string): number | null {
  const id = Number.parseInt(path.split('/').pop() ?? '', 10);
  return Number.isNaN(id) ? null : id;
}

function parseAttachmentDownloadId(path: string): number | null {
  const match = /^\/api\/attachments\/(\d+)\/download$/.exec(path);
  if (!match) return null;
  const id = Number.parseInt(match[1], 10);
  return Number.isNaN(id) ? null : id;
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim();
  const safe = trimmed.replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '_').replace(/\s+/g, ' ');
  if (!safe) return 'attachment';
  return safe.slice(0, 180);
}

function normalizeAttachmentContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('data:')) {
    return trimmed;
  }

  const comma = trimmed.indexOf(',');
  return comma === -1 ? '' : trimmed.slice(comma + 1).trim();
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function buildSentAttachmentStorageKey(userId: number, sentEmailId: number, filename: string): string {
  return `sent/${userId}/${sentEmailId}/${crypto.randomUUID()}-${filename}`;
}

function escapeQuotedHeaderValue(value: string): string {
  return value.replace(/["\\\r\n]/g, '_');
}

export async function handleRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: withCors() });
  }

  if (path === '/' || path === '/index.html') {
    return new Response(getWebmailHtml(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  if (path === '/api/login' && method === 'POST') {
    const body = await parseJson<{ username: string; password: string }>(request);
    if (!body?.username || !body?.password) {
      return json({ error: 'username and password are required' }, { status: 400 });
    }

    const hash = await hashPassword(body.password);

    const user = await env.DB.prepare(
      'SELECT id, email FROM users WHERE username = ? AND password_hash = ?'
    )
      .bind(body.username, hash)
      .first<{ id: number; email: string }>();

    if (!user) {
      return json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const token = await createSession(env, user.id);
    return json({ token, email: user.email });
  }

  const user = await authenticate(request, env);
  if (!user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (path === '/api/me' && method === 'GET') {
    return json({ id: user.id, email: user.email, username: user.username });
  }

  const attachmentDownloadId = parseAttachmentDownloadId(path);
  if (attachmentDownloadId !== null && method === 'GET') {
    const attachment = await env.DB.prepare(
      `
        SELECT id, storage_key, filename, mime_type, size_bytes
        FROM attachments
        WHERE id = ? AND user_id = ?
      `
    )
      .bind(attachmentDownloadId, user.id)
      .first<{
        id: number;
        storage_key: string;
        filename: string;
        mime_type: string | null;
        size_bytes: number;
      }>();

    if (!attachment) {
      return json({ error: 'Attachment not found' }, { status: 404 });
    }

    const object = await env.ATTACHMENTS.get(attachment.storage_key);
    if (!object?.body) {
      return json({ error: 'Attachment content not found' }, { status: 404 });
    }

    const headers = withCors();
    headers.set(
      'Content-Type',
      attachment.mime_type ?? object.httpMetadata?.contentType ?? 'application/octet-stream'
    );
    headers.set(
      'Content-Disposition',
      `attachment; filename="${escapeQuotedHeaderValue(attachment.filename)}"`
    );

    if (attachment.size_bytes > 0) {
      headers.set('Content-Length', String(attachment.size_bytes));
    }

    return new Response(object.body, { status: 200, headers });
  }

  if (path === '/api/emails' && method === 'GET') {
    const folder = url.searchParams.get('folder') ?? 'inbox';
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
    const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);

    const safeLimit = Number.isNaN(limit) ? 50 : Math.min(Math.max(limit, 1), 200);
    const safeOffset = Number.isNaN(offset) ? 0 : Math.max(offset, 0);

    const rows = await env.DB.prepare(
      `
        SELECT id, from_address, from_name, subject, received_at, read, starred, raw_size
        FROM emails
        WHERE user_id = ? AND folder = ?
        ORDER BY received_at DESC
        LIMIT ? OFFSET ?
      `
    )
      .bind(user.id, folder, safeLimit, safeOffset)
      .all();

    return json(rows.results ?? []);
  }

  if (path === '/api/sent' && method === 'GET') {
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
    const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);

    const safeLimit = Number.isNaN(limit) ? 50 : Math.min(Math.max(limit, 1), 200);
    const safeOffset = Number.isNaN(offset) ? 0 : Math.max(offset, 0);

    const rows = await env.DB.prepare(
      `
        SELECT id, to_address, subject, sent_at
        FROM sent_emails
        WHERE user_id = ?
        ORDER BY sent_at DESC
        LIMIT ? OFFSET ?
      `
    )
      .bind(user.id, safeLimit, safeOffset)
      .all();

    return json(rows.results ?? []);
  }

  if (path.startsWith('/api/sent/') && method === 'GET') {
    const sentId = parseIdFromPath(path);
    if (sentId === null) {
      return json({ error: 'Invalid sent email id' }, { status: 400 });
    }

    const sent = await env.DB.prepare('SELECT * FROM sent_emails WHERE id = ? AND user_id = ?')
      .bind(sentId, user.id)
      .first();

    if (!sent) {
      return json({ error: 'Not found' }, { status: 404 });
    }

    const attachmentRows = await env.DB.prepare(
      `
        SELECT id, filename, mime_type, size_bytes, content_id, disposition, created_at
        FROM attachments
        WHERE user_id = ? AND sent_email_id = ?
        ORDER BY id ASC
      `
    )
      .bind(user.id, sentId)
      .all();

    const attachments = (attachmentRows.results ?? []) as unknown as AttachmentSummary[];

    return json({
      ...(sent as Record<string, unknown>),
      attachments,
    });
  }

  if (path.startsWith('/api/emails/') && method === 'GET') {
    const emailId = parseIdFromPath(path);
    if (emailId === null) {
      return json({ error: 'Invalid email id' }, { status: 400 });
    }

    const email = await env.DB.prepare('SELECT * FROM emails WHERE id = ? AND user_id = ?')
      .bind(emailId, user.id)
      .first();

    if (!email) {
      return json({ error: 'Not found' }, { status: 404 });
    }

    await env.DB.prepare('UPDATE emails SET read = 1 WHERE id = ?')
      .bind(emailId)
      .run();

    const attachmentRows = await env.DB.prepare(
      `
        SELECT id, filename, mime_type, size_bytes, content_id, disposition, created_at
        FROM attachments
        WHERE user_id = ? AND email_id = ?
        ORDER BY id ASC
      `
    )
      .bind(user.id, emailId)
      .all();

    const attachments = (attachmentRows.results ?? []) as unknown as AttachmentSummary[];

    return json({
      ...(email as Record<string, unknown>),
      attachments,
    });
  }

  if (path.startsWith('/api/emails/') && method === 'DELETE') {
    const emailId = parseIdFromPath(path);
    if (emailId === null) {
      return json({ error: 'Invalid email id' }, { status: 400 });
    }

    await env.DB.prepare("UPDATE emails SET folder = 'trash' WHERE id = ? AND user_id = ?")
      .bind(emailId, user.id)
      .run();

    return json({ ok: true });
  }

  if (path === '/api/send' && method === 'POST') {
    const body = await parseJson<{
      to: string;
      subject: string;
      text: string;
      html?: string;
      attachments?: SendAttachment[];
    }>(request);

    if (!body?.to || !body?.subject || !body?.text) {
      return json({ error: 'to, subject, and text are required' }, { status: 400 });
    }

    if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
      return json({ error: 'attachments must be an array' }, { status: 400 });
    }

    const incomingAttachments = body.attachments ?? [];
    if (incomingAttachments.length > MAX_ATTACHMENT_COUNT) {
      return json(
        { error: `Too many attachments (max ${MAX_ATTACHMENT_COUNT})` },
        { status: 400 }
      );
    }

    const preparedAttachments: PreparedSendAttachment[] = [];
    let totalAttachmentBytes = 0;

    for (let i = 0; i < incomingAttachments.length; i += 1) {
      const attachment = incomingAttachments[i];
      if (!attachment || typeof attachment.filename !== 'string' || typeof attachment.content !== 'string') {
        return json({ error: `Invalid attachment at index ${i}` }, { status: 400 });
      }

      const filename = sanitizeFilename(attachment.filename);
      const normalizedContent = normalizeAttachmentContent(attachment.content);
      if (!normalizedContent) {
        return json({ error: `Attachment ${filename} has no content` }, { status: 400 });
      }

      let bytes: Uint8Array;
      try {
        bytes = decodeBase64ToBytes(normalizedContent);
      } catch {
        return json({ error: `Attachment ${filename} has invalid base64 content` }, { status: 400 });
      }

      totalAttachmentBytes += bytes.byteLength;
      if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        return json(
          { error: `Total attachment size exceeds ${MAX_TOTAL_ATTACHMENT_BYTES} bytes` },
          { status: 400 }
        );
      }

      preparedAttachments.push({
        filename,
        content: normalizedContent,
        mimeType:
          typeof attachment.mimeType === 'string' && attachment.mimeType.trim().length > 0
            ? attachment.mimeType
            : 'application/octet-stream',
        bytes,
      });
    }

    try {
      await sendEmail(env, {
        from: user.email,
        to: body.to,
        subject: body.subject,
        text: body.text,
        html: body.html,
        attachments: preparedAttachments.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          mimeType: attachment.mimeType,
        })),
      });

      const sentRow = await env.DB.prepare(
        `
          INSERT INTO sent_emails (user_id, to_address, subject, body_text, body_html)
          VALUES (?, ?, ?, ?, ?)
          RETURNING id
        `
      )
        .bind(user.id, body.to, body.subject, body.text, body.html ?? null)
        .first<{ id: number }>();

      if (!sentRow) {
        throw new Error('Failed to save sent email');
      }

      for (const attachment of preparedAttachments) {
        const storageKey = buildSentAttachmentStorageKey(user.id, sentRow.id, attachment.filename);
        try {
          await env.ATTACHMENTS.put(storageKey, attachment.bytes, {
            httpMetadata: { contentType: attachment.mimeType ?? 'application/octet-stream' },
          });

          await env.DB.prepare(
            `
              INSERT INTO attachments
                (user_id, email_id, sent_email_id, storage_key, filename, mime_type, size_bytes, content_id, disposition)
              VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, 'attachment')
            `
          )
            .bind(
              user.id,
              sentRow.id,
              storageKey,
              attachment.filename,
              attachment.mimeType ?? null,
              attachment.bytes.byteLength
            )
            .run();
        } catch (err) {
          console.error(`Failed to persist sent attachment ${attachment.filename}:`, err);
        }
      }

      return json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('Send failed:', err);
      return json({ error: message }, { status: 500 });
    }
  }

  return json({ error: 'Not found' }, { status: 404 });
}
