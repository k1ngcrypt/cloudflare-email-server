import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import type { Env } from './index';
import { getWebmailHtml } from './webmail.ts';
import {
  authenticate,
  clearLoginAttempts,
  createSession,
  getLoginThrottleKey,
  getSessionCookieName,
  isLoginBlocked,
  recordFailedLoginAttempt,
  revokeSession,
  verifyPasswordAndUpgrade,
} from './auth';
import {
  decodeBase64ToBytes,
  escapeQuotedHeaderValue,
  normalizeAttachmentContent,
  sanitizeFilename,
} from './attachment-utils';
import { sendEmail, type SendAttachment } from './send';

const MAX_ATTACHMENT_COUNT = 10;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const CORS_ALLOW_HEADERS = ['Content-Type', 'Authorization', 'Idempotency-Key'];
const CORS_ALLOW_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];

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

type AuthenticatedUser = {
  id: number;
  email: string;
  username: string;
};

type AppBindings = {
  Bindings: Env;
  Variables: {
    user: AuthenticatedUser;
  };
};

const loginBodySchema = z.object({
  username: z.string(),
  password: z.string(),
});

const sendBodySchema = z.object({
  to: z.string(),
  subject: z.string(),
  text: z.string(),
  html: z.string().optional(),
  attachments: z.unknown().optional(),
});

const sendAttachmentSchema = z.object({
  filename: z.string(),
  content: z.string(),
  mimeType: z.string().optional(),
});

function resolveAllowedOrigin(request: Request, env: Env): string | null {
  const requestOrigin = request.headers.get('Origin');
  if (!requestOrigin) return null;

  const ownOrigin = new URL(request.url).origin;
  if (requestOrigin === ownOrigin) {
    return requestOrigin;
  }

  const configuredOrigin = env.APP_ORIGIN?.trim();
  if (configuredOrigin && requestOrigin === configuredOrigin) {
    return requestOrigin;
  }

  return null;
}

function parseNumericId(value: string): number | null {
  const id = Number.parseInt(value, 10);
  return Number.isNaN(id) ? null : id;
}

function buildSentAttachmentStorageKey(userId: number, sentEmailId: number, filename: string): string {
  return `sent/${userId}/${sentEmailId}/${crypto.randomUUID()}-${filename}`;
}

function parsePaginationParams(c: Context<AppBindings>): { safeLimit: number; safeOffset: number } {
  const limit = Number.parseInt(c.req.query('limit') ?? '50', 10);
  const offset = Number.parseInt(c.req.query('offset') ?? '0', 10);

  return {
    safeLimit: Number.isNaN(limit) ? 50 : Math.min(Math.max(limit, 1), 200),
    safeOffset: Number.isNaN(offset) ? 0 : Math.max(offset, 0),
  };
}

function requiredPayloadErrorForPath(path: string): string {
  if (path === '/api/login') {
    return 'username and password are required';
  }

  if (path === '/api/send') {
    return 'to, subject, and text are required';
  }

  return 'Invalid JSON payload';
}

const app = new Hono<AppBindings>();

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.status === 400 && /Malformed JSON/i.test(err.message)) {
      return c.json({ error: requiredPayloadErrorForPath(c.req.path) }, 400);
    }

    return err.getResponse();
  }

  console.error('Unhandled request error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

app.use('*', async (c, next) => {
  const allowedOrigin = resolveAllowedOrigin(c.req.raw, c.env);

  if (allowedOrigin) {
    const trustedCors = cors({
      origin: allowedOrigin,
      allowHeaders: CORS_ALLOW_HEADERS,
      allowMethods: CORS_ALLOW_METHODS,
      credentials: true,
    });
    return trustedCors(c, next);
  }

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
});

app.use(
  '*',
  secureHeaders({
    referrerPolicy: 'no-referrer',
    xContentTypeOptions: 'nosniff',
    xFrameOptions: 'DENY',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload',
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
    },
  })
);

app.get('/', (c) => c.html(getWebmailHtml()));
app.get('/index.html', (c) => c.html(getWebmailHtml()));

const api = new Hono<AppBindings>();

api.post(
  '/login',
  zValidator('json', loginBodySchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: 'username and password are required' }, 400);
    }
  }),
  async (c) => {
  const body = c.req.valid('json');
  if (
    body.password.length === 0
  ) {
    return c.json({ error: 'username and password are required' }, 400);
  }

  const username = body.username.trim();
  if (!username) {
    return c.json({ error: 'username and password are required' }, 400);
  }

  const throttleKey = getLoginThrottleKey(c.req.raw, username);
  const throttleState = await isLoginBlocked(c.env, throttleKey);
  if (throttleState.blocked) {
    c.header('Retry-After', String(throttleState.retryAfterSeconds));
    return c.json({ error: 'Too many login attempts. Try again later.' }, 429);
  }

  const user = await c.env.DB.prepare('SELECT id, email, password_hash FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: number; email: string; password_hash: string }>();

  if (!user) {
    const loginState = await recordFailedLoginAttempt(c.env, throttleKey);
    if (loginState.blocked) {
      c.header('Retry-After', String(loginState.retryAfterSeconds));
      return c.json({ error: 'Too many login attempts. Try again later.' }, 429);
    }

    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const passwordOk = await verifyPasswordAndUpgrade(c.env, user.id, body.password, user.password_hash);
  if (!passwordOk) {
    const loginState = await recordFailedLoginAttempt(c.env, throttleKey);
    if (loginState.blocked) {
      c.header('Retry-After', String(loginState.retryAfterSeconds));
      return c.json({ error: 'Too many login attempts. Try again later.' }, 429);
    }

    return c.json({ error: 'Invalid credentials' }, 401);
  }

  await clearLoginAttempts(c.env, throttleKey);

  const session = await createSession(c.env, user.id);
  setCookie(c, getSessionCookieName(), session.token, {
    maxAge: session.maxAgeSeconds,
    httpOnly: true,
    path: '/',
    sameSite: 'Strict',
    secure: true,
  });

  return c.json({ token: session.token, email: user.email, expiresAt: session.expiresAt });
});

api.post('/logout', async (c) => {
  await revokeSession(c.req.raw, c.env);
  setCookie(c, getSessionCookieName(), '', {
    maxAge: 0,
    httpOnly: true,
    path: '/',
    sameSite: 'Strict',
    secure: true,
  });
  return c.json({ ok: true });
});

const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const user = await authenticate(c.req.raw, c.env);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('user', user);
  await next();
};

api.use('*', requireAuth);

api.get('/me', (c) => {
  const user = c.get('user');
  return c.json({ id: user.id, email: user.email, username: user.username });
});

api.get('/attachments/:id/download', async (c) => {
  const user = c.get('user');
  const attachmentDownloadId = parseNumericId(c.req.param('id'));
  if (attachmentDownloadId === null) {
    return c.json({ error: 'Not found' }, 404);
  }

  const attachment = await c.env.DB.prepare(
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
    return c.json({ error: 'Attachment not found' }, 404);
  }

  const object = await c.env.ATTACHMENTS.get(attachment.storage_key);
  if (!object?.body) {
    return c.json({ error: 'Attachment content not found' }, 404);
  }

  const headers = new Headers();
  headers.set(
    'Content-Type',
    attachment.mime_type ?? object.httpMetadata?.contentType ?? 'application/octet-stream'
  );
  headers.set('Content-Disposition', `attachment; filename="${escapeQuotedHeaderValue(attachment.filename)}"`);

  if (attachment.size_bytes > 0) {
    headers.set('Content-Length', String(attachment.size_bytes));
  }

  return new Response(object.body, { status: 200, headers });
});

api.get('/emails', async (c) => {
  const user = c.get('user');
  const folder = c.req.query('folder') ?? 'inbox';
  const { safeLimit, safeOffset } = parsePaginationParams(c);

  const rows = await c.env.DB.prepare(
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

  return c.json(rows.results ?? []);
});

api.get('/sent', async (c) => {
  const user = c.get('user');
  const { safeLimit, safeOffset } = parsePaginationParams(c);

  const rows = await c.env.DB.prepare(
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

  return c.json(rows.results ?? []);
});

api.get('/sent/:id', async (c) => {
  const user = c.get('user');
  const sentId = parseNumericId(c.req.param('id'));
  if (sentId === null) {
    return c.json({ error: 'Invalid sent email id' }, 400);
  }

  const sent = await c.env.DB.prepare('SELECT * FROM sent_emails WHERE id = ? AND user_id = ?')
    .bind(sentId, user.id)
    .first();

  if (!sent) {
    return c.json({ error: 'Not found' }, 404);
  }

  const attachmentRows = await c.env.DB.prepare(
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

  return c.json({
    ...(sent as Record<string, unknown>),
    attachments,
  });
});

api.get('/emails/:id', async (c) => {
  const user = c.get('user');
  const emailId = parseNumericId(c.req.param('id'));
  if (emailId === null) {
    return c.json({ error: 'Invalid email id' }, 400);
  }

  const email = await c.env.DB.prepare('SELECT * FROM emails WHERE id = ? AND user_id = ?')
    .bind(emailId, user.id)
    .first();

  if (!email) {
    return c.json({ error: 'Not found' }, 404);
  }

  await c.env.DB.prepare('UPDATE emails SET read = 1 WHERE id = ? AND user_id = ?')
    .bind(emailId, user.id)
    .run();

  const attachmentRows = await c.env.DB.prepare(
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

  return c.json({
    ...(email as Record<string, unknown>),
    attachments,
  });
});

api.delete('/emails/:id', async (c) => {
  const user = c.get('user');
  const emailId = parseNumericId(c.req.param('id'));
  if (emailId === null) {
    return c.json({ error: 'Invalid email id' }, 400);
  }

  await c.env.DB.prepare("UPDATE emails SET folder = 'trash' WHERE id = ? AND user_id = ?")
    .bind(emailId, user.id)
    .run();

  return c.json({ ok: true });
});

api.post(
  '/send',
  zValidator('json', sendBodySchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: 'to, subject, and text are required' }, 400);
    }
  }),
  async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  if (!body.to || !body.subject || !body.text) {
    return c.json({ error: 'to, subject, and text are required' }, 400);
  }

  if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
    return c.json({ error: 'attachments must be an array' }, 400);
  }

  const incomingAttachments = body.attachments ?? [];
  if (incomingAttachments.length > MAX_ATTACHMENT_COUNT) {
    return c.json({ error: `Too many attachments (max ${MAX_ATTACHMENT_COUNT})` }, 400);
  }

  const preparedAttachments: PreparedSendAttachment[] = [];
  let totalAttachmentBytes = 0;

  for (let i = 0; i < incomingAttachments.length; i += 1) {
    const parsedAttachment = sendAttachmentSchema.safeParse(incomingAttachments[i]);
    if (!parsedAttachment.success) {
      return c.json({ error: `Invalid attachment at index ${i}` }, 400);
    }

    const attachment = parsedAttachment.data;

    const filename = sanitizeFilename(attachment.filename);
    const normalizedContent = normalizeAttachmentContent(attachment.content);
    if (!normalizedContent) {
      return c.json({ error: `Attachment ${filename} has no content` }, 400);
    }

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64ToBytes(normalizedContent);
    } catch {
      return c.json({ error: `Attachment ${filename} has invalid base64 content` }, 400);
    }

    totalAttachmentBytes += bytes.byteLength;
    if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return c.json({ error: `Total attachment size exceeds ${MAX_TOTAL_ATTACHMENT_BYTES} bytes` }, 400);
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

  let sentEmailId: number | null = null;
  const uploadedAttachmentKeys: string[] = [];

  try {
    const sentRow = await c.env.DB.prepare(
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

    sentEmailId = sentRow.id;

    for (const attachment of preparedAttachments) {
      const storageKey = buildSentAttachmentStorageKey(user.id, sentEmailId, attachment.filename);

      await c.env.ATTACHMENTS.put(storageKey, attachment.bytes, {
        httpMetadata: { contentType: attachment.mimeType ?? 'application/octet-stream' },
      });

      uploadedAttachmentKeys.push(storageKey);

      await c.env.DB.prepare(
        `
          INSERT INTO attachments
            (user_id, email_id, sent_email_id, storage_key, filename, mime_type, size_bytes, content_id, disposition)
          VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, 'attachment')
        `
      )
        .bind(
          user.id,
          sentEmailId,
          storageKey,
          attachment.filename,
          attachment.mimeType ?? null,
          attachment.bytes.byteLength
        )
        .run();
    }

    await sendEmail(c.env, {
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

    return c.json({ ok: true, sentEmailId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Send failed:', err);

    for (const key of uploadedAttachmentKeys) {
      try {
        await c.env.ATTACHMENTS.delete(key);
      } catch (cleanupErr) {
        console.error(`Failed to cleanup attachment object ${key}:`, cleanupErr);
      }
    }

    if (sentEmailId !== null) {
      try {
        await c.env.DB.prepare('DELETE FROM attachments WHERE sent_email_id = ? AND user_id = ?')
          .bind(sentEmailId, user.id)
          .run();
        await c.env.DB.prepare('DELETE FROM sent_emails WHERE id = ? AND user_id = ?')
          .bind(sentEmailId, user.id)
          .run();
      } catch (cleanupErr) {
        console.error(`Failed to cleanup sent email ${sentEmailId}:`, cleanupErr);
      }
    }

    return c.json({ error: message }, 500);
  }
});

api.notFound((c) => c.json({ error: 'Not found' }, 404));

app.route('/api', api);

app.notFound(async (c) => {
  const user = await authenticate(c.req.raw, c.env);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return c.json({ error: 'Not found' }, 404);
});

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  return app.fetch(request, env, ctx);
}
