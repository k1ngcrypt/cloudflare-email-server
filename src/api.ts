import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import type { Env } from './index';
import { getAdminConsoleHtml } from './admin-console.ts';
import { getLoginHtml } from './login';
import { getWebmailHtml } from './webmail.ts';
import {
  authenticate,
  clearLoginAttempts,
  createSession,
  getLoginThrottleKey,
  getSessionCookieName,
  hashPassword,
  isLoginBlocked,
  recordFailedLoginAttempt,
  revokeSession,
  verifyPassword,
} from './auth';
import {
  decodeBase64ToBytes,
  escapeQuotedHeaderValue,
  normalizeAttachmentContent,
  sanitizeFilename,
} from './attachment-utils';
import { sendEmail, type SendAttachment } from './send';
import {
  isValidEmailAddress,
  listUserEmailAddresses,
  normalizeEmailAddress,
} from './user-addresses';
import {
  ApprovedSenderSyncError,
  ensureApprovedSenders,
  removeApprovedSenders,
} from './oracle-approved-senders';

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

interface AttachmentStorageRow {
  storage_key: string;
}

interface PreparedSendAttachment extends SendAttachment {
  bytes: Uint8Array;
}

type AttachmentOwnerColumn = 'email_id' | 'sent_email_id';
type UserRole = 'admin' | 'user';

type AuthenticatedUser = {
  id: number;
  username: string;
  role: UserRole;
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
  from: z.string().optional(),
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

const adminRoleSchema = z.enum(['admin', 'user']);
const adminUserCreateSchema = z.object({
  username: z.string().trim().min(1).max(120),
  password: z.string().min(8),
  role: adminRoleSchema,
  primaryEmail: z.string().trim().min(3),
  emails: z.array(z.string()).optional().default([]),
});

const adminUserUpdateSchema = z.object({
  username: z.string().trim().min(1).max(120),
  password: z.string().min(8).optional(),
  role: adminRoleSchema,
  primaryEmail: z.string().trim().min(3),
  emails: z.array(z.string()).optional().default([]),
});

const selfPasswordUpdateSchema = z.object({
  newPassword: z.string().min(8),
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

function parseInteger(value: string | null | undefined): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }

  return parsed;
}

function parseNumericId(value: string): number | null {
  const parsed = parseInteger(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }

  return parsed;
}

function buildSentAttachmentStorageKey(userId: number, sentEmailId: number, filename: string): string {
  return `sent/${userId}/${sentEmailId}/${crypto.randomUUID()}-${filename}`;
}

function parsePaginationParams(c: Context<AppBindings>): { safeLimit: number; safeOffset: number } {
  const limit = parseInteger(c.req.query('limit'));
  const offset = parseInteger(c.req.query('offset'));

  return {
    safeLimit: limit === null ? 50 : Math.min(Math.max(limit, 1), 200),
    safeOffset: offset === null ? 0 : Math.max(offset, 0),
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

async function failedLoginResponse(c: Context<AppBindings>, throttleKey: string): Promise<Response> {
  const loginState = await recordFailedLoginAttempt(c.env, throttleKey);
  if (loginState.blocked) {
    c.header('Retry-After', String(loginState.retryAfterSeconds));
    return c.json({ error: 'Too many login attempts. Try again later.' }, 429);
  }

  return c.json({ error: 'Invalid credentials' }, 401);
}

async function resolveUserAddressSet(
  env: Env,
  userId: number
): Promise<{ primaryEmail: string; emails: string[] }> {
  const emails = await listUserEmailAddresses(env, userId);

  const primaryEmail = emails[0] ?? '';
  if (!primaryEmail) {
    throw new Error(`User ${userId} has no email addresses configured`);
  }

  return {
    primaryEmail,
    emails,
  };
}

interface AdminUserRow {
  id: number;
  username: string;
  created_at: string;
  role: string | null;
}

interface UserIdRow {
  id: number;
}

interface UserAddressOwnerRow {
  user_id: number;
}

interface UserAddressByUserRow {
  user_id: number;
  address: string;
}

interface EmailAddressOwnerRow {
  address: string;
  user_id: number;
}

function normalizeRole(role: string | null | undefined): UserRole {
  return role === 'admin' ? 'admin' : 'user';
}

function normalizeManagedEmails(primaryEmail: string, aliasEmails: string[]): string[] {
  const normalizedPrimary = normalizeEmailAddress(primaryEmail);
  if (!isValidEmailAddress(normalizedPrimary)) {
    throw new Error('primaryEmail must be a valid email address');
  }

  const normalizedEmails = [normalizedPrimary];
  const seen = new Set<string>([normalizedPrimary]);

  for (const candidate of aliasEmails) {
    const normalized = normalizeEmailAddress(String(candidate ?? ''));
    if (!normalized) {
      continue;
    }

    if (!isValidEmailAddress(normalized)) {
      throw new Error(`Invalid email address: ${candidate}`);
    }

    if (!seen.has(normalized)) {
      seen.add(normalized);
      normalizedEmails.push(normalized);
    }
  }

  return normalizedEmails;
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function buildSqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

async function resolveUserAddressSets(
  env: Env,
  userIds: number[]
): Promise<Map<number, { primaryEmail: string; emails: string[] }>> {
  const uniqueUserIds = Array.from(new Set(userIds.filter((userId) => Number.isSafeInteger(userId) && userId > 0)));
  const addressSets = new Map<number, { primaryEmail: string; emails: string[] }>();

  if (uniqueUserIds.length === 0) {
    return addressSets;
  }

  const placeholders = buildSqlPlaceholders(uniqueUserIds.length);
  const rows = await env.DB.prepare(
    `
      SELECT user_id, address
      FROM user_addresses
      WHERE user_id IN (${placeholders})
      ORDER BY user_id ASC, is_primary DESC, id ASC
    `
  )
    .bind(...uniqueUserIds)
    .all<UserAddressByUserRow>();

  const emailsByUser = new Map<number, string[]>();
  const seenByUser = new Map<number, Set<string>>();

  for (const row of rows.results ?? []) {
    const normalized = normalizeEmailAddress(String(row.address ?? ''));
    if (!normalized) {
      continue;
    }

    const userId = Number(row.user_id);
    if (!seenByUser.has(userId)) {
      seenByUser.set(userId, new Set());
      emailsByUser.set(userId, []);
    }

    const seen = seenByUser.get(userId) as Set<string>;
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    (emailsByUser.get(userId) as string[]).push(normalized);
  }

  for (const userId of uniqueUserIds) {
    const emails = emailsByUser.get(userId) ?? [];
    const primaryEmail = emails[0] ?? '';
    if (!primaryEmail) {
      throw new Error(`User ${userId} has no email addresses configured`);
    }

    addressSets.set(userId, { primaryEmail, emails });
  }

  return addressSets;
}

async function setUserRole(env: Env, userId: number, role: UserRole): Promise<void> {
  await env.DB.prepare(
    `
      INSERT INTO user_roles (user_id, role, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        role = excluded.role,
        updated_at = excluded.updated_at
    `
  )
    .bind(userId, role)
    .run();
}

async function replaceUserEmailAddresses(env: Env, userId: number, emails: string[]): Promise<void> {
  await env.DB.prepare('DELETE FROM user_addresses WHERE user_id = ?')
    .bind(userId)
    .run();

  if (emails.length > 0) {
    await env.DB.batch(
      emails.map((email, index) =>
        env.DB.prepare(
          `
            INSERT INTO user_addresses (user_id, address, is_primary)
            VALUES (?, ?, ?)
          `
        ).bind(userId, email, index === 0 ? 1 : 0)
      )
    );
  }

  await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?')
    .bind(emails[0], userId)
    .run();
}

async function countAdminUsers(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM user_roles WHERE role = 'admin'")
    .first<{ count: number }>();

  return row?.count ?? 0;
}

async function listAdminUsers(env: Env): Promise<
  Array<{
    id: number;
    username: string;
    role: UserRole;
    primaryEmail: string;
    emails: string[];
    createdAt: string;
  }>
> {
  const rows = await env.DB.prepare(
    `
      SELECT users.id, users.username, users.created_at, user_roles.role
      FROM users
      LEFT JOIN user_roles ON user_roles.user_id = users.id
      ORDER BY users.id ASC
    `
  ).all<AdminUserRow>();

  const users = rows.results ?? [];
  const userIds = users.map((row) => row.id);
  const addressSets = await resolveUserAddressSets(env, userIds);

  return users.map((row) => {
    const addressSet = addressSets.get(row.id);
    if (!addressSet) {
      throw new Error(`User ${row.id} has no email addresses configured`);
    }

    return {
      id: row.id,
      username: row.username,
      role: normalizeRole(row.role),
      primaryEmail: addressSet.primaryEmail,
      emails: addressSet.emails,
      createdAt: row.created_at,
    };
  });
}

async function getAdminUserById(
  env: Env,
  userId: number
): Promise<{
  id: number;
  username: string;
  role: UserRole;
  primaryEmail: string;
  emails: string[];
  createdAt: string;
} | null> {
  const row = await env.DB.prepare(
    `
      SELECT users.id, users.username, users.created_at, user_roles.role
      FROM users
      LEFT JOIN user_roles ON user_roles.user_id = users.id
      WHERE users.id = ?
      LIMIT 1
    `
  )
    .bind(userId)
    .first<AdminUserRow>();

  if (!row) {
    return null;
  }

  const addressSets = await resolveUserAddressSets(env, [row.id]);
  const addressSet = addressSets.get(row.id);
  if (!addressSet) {
    throw new Error(`User ${row.id} has no email addresses configured`);
  }

  return {
    id: row.id,
    username: row.username,
    role: normalizeRole(row.role),
    primaryEmail: addressSet.primaryEmail,
    emails: addressSet.emails,
    createdAt: row.created_at,
  };
}

async function findUserIdByUsername(env: Env, username: string): Promise<number | null> {
  const row = await env.DB.prepare('SELECT id FROM users WHERE username = ? LIMIT 1')
    .bind(username)
    .first<UserIdRow>();

  return row?.id ?? null;
}

async function validateUsernameAvailability(
  env: Env,
  username: string,
  currentUserId?: number
): Promise<string | null> {
  const ownerId = await findUserIdByUsername(env, username);
  if (ownerId !== null && ownerId !== currentUserId) {
    return 'username is already in use';
  }

  return null;
}

async function validateEmailAvailability(
  env: Env,
  emails: string[],
  currentUserId?: number
): Promise<string | null> {
  if (emails.length === 0) {
    return null;
  }

  const placeholders = buildSqlPlaceholders(emails.length);
  const rows = await env.DB.prepare(
    `
      SELECT address, user_id
      FROM user_addresses
      WHERE address IN (${placeholders})
    `
  )
    .bind(...emails)
    .all<EmailAddressOwnerRow>();

  const ownerByEmail = new Map<string, number>();
  for (const row of rows.results ?? []) {
    const normalized = normalizeEmailAddress(String(row.address ?? ''));
    if (!normalized) {
      continue;
    }

    ownerByEmail.set(normalized, row.user_id);
  }

  for (let i = 0; i < emails.length; i += 1) {
    const ownerId = ownerByEmail.get(emails[i]) ?? null;
    if (ownerId !== null && ownerId !== currentUserId) {
      return `${emails[i]} is already assigned to another user`;
    }
  }

  return null;
}

async function listAttachmentsByOwner(
  c: Context<AppBindings>,
  userId: number,
  ownerColumn: AttachmentOwnerColumn,
  ownerId: number
): Promise<AttachmentSummary[]> {
  const rows = await c.env.DB.prepare(
    `
      SELECT id, filename, mime_type, size_bytes, content_id, disposition, created_at
      FROM attachments
      WHERE user_id = ? AND ${ownerColumn} = ?
      ORDER BY id ASC
    `
  )
    .bind(userId, ownerId)
    .all();

  return (rows.results ?? []) as unknown as AttachmentSummary[];
}

async function listAttachmentStorageKeysByOwner(
  c: Context<AppBindings>,
  userId: number,
  ownerColumn: AttachmentOwnerColumn,
  ownerId: number
): Promise<string[]> {
  const rows = await c.env.DB.prepare(
    `
      SELECT storage_key
      FROM attachments
      WHERE user_id = ? AND ${ownerColumn} = ?
    `
  )
    .bind(userId, ownerId)
    .all<AttachmentStorageRow>();

  return (rows.results ?? []).map((row) => String(row.storage_key || '')).filter((key) => key.length > 0);
}

async function deleteAttachmentObjects(c: Context<AppBindings>, storageKeys: string[]): Promise<void> {
  for (const key of storageKeys) {
    try {
      await c.env.ATTACHMENTS.delete(key);
    } catch (err) {
      console.error(`Failed to cleanup attachment object ${key}:`, err);
    }
  }
}

async function deleteAttachmentsByOwner(
  c: Context<AppBindings>,
  userId: number,
  ownerColumn: AttachmentOwnerColumn,
  ownerId: number
): Promise<void> {
  const storageKeys = await listAttachmentStorageKeysByOwner(c, userId, ownerColumn, ownerId);
  await deleteAttachmentObjects(c, storageKeys);

  await c.env.DB.prepare(`DELETE FROM attachments WHERE user_id = ? AND ${ownerColumn} = ?`)
    .bind(userId, ownerId)
    .run();
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
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
    },
  })
);

app.get('/', (c) => c.redirect('/login', 302));
app.get('/index.html', (c) => c.redirect('/login', 302));

app.get('/login', async (c) => {
  const user = await authenticate(c.req.raw, c.env);
  if (user) {
    return c.redirect('/mail', 302);
  }

  return c.html(getLoginHtml());
});

async function handleMailPage(c: Context<AppBindings>): Promise<Response> {
  const user = await authenticate(c.req.raw, c.env);
  if (!user) {
    return c.redirect('/login', 302);
  }

  return c.html(getWebmailHtml());
}

async function handleAdminPage(c: Context<AppBindings>): Promise<Response> {
  const user = await authenticate(c.req.raw, c.env);
  if (!user) {
    return c.redirect('/login', 302);
  }

  if (user.role !== 'admin') {
    return c.redirect('/mail', 302);
  }

  return c.html(getAdminConsoleHtml());
}

app.get('/mail', handleMailPage);
app.get('/mail/index.html', handleMailPage);
app.get('/admin', handleAdminPage);
app.get('/admin/index.html', handleAdminPage);
app.get('/favicon.ico', (c) => c.body(null, 204));

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
  const [throttleState, user] = await Promise.all([
    isLoginBlocked(c.env, throttleKey),
    c.env.DB.prepare(
      `
        SELECT users.id, users.password_hash, COALESCE(user_roles.role, 'user') AS role
        FROM users
        LEFT JOIN user_roles ON user_roles.user_id = users.id
        WHERE users.username = ?
        LIMIT 1
      `
    )
      .bind(username)
      .first<{ id: number; password_hash: string; role: string | null }>(),
  ]);

  if (throttleState.blocked) {
    c.header('Retry-After', String(throttleState.retryAfterSeconds));
    return c.json({ error: 'Too many login attempts. Try again later.' }, 429);
  }

  if (!user) {
    return failedLoginResponse(c, throttleKey);
  }

  const passwordOk = await verifyPassword(body.password, user.password_hash);
  if (!passwordOk) {
    return failedLoginResponse(c, throttleKey);
  }

  const [session, userAddressSet] = await Promise.all([
    createSession(c.env, user.id),
    resolveUserAddressSet(c.env, user.id),
    clearLoginAttempts(c.env, throttleKey),
  ]);

  setCookie(c, getSessionCookieName(), session.token, {
    maxAge: session.maxAgeSeconds,
    httpOnly: true,
    path: '/',
    sameSite: 'Strict',
    secure: true,
  });

  return c.json({
    token: session.token,
    email: userAddressSet.primaryEmail,
    emails: userAddressSet.emails,
    username,
    role: normalizeRole(user.role),
    expiresAt: session.expiresAt,
  });
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

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const user = c.get('user');
  if (user.role !== 'admin') {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await next();
};

api.use('*', requireAuth);
api.use('/admin/*', requireAdmin);

api.get('/me', async (c) => {
  const user = c.get('user');
  const userAddressSet = await resolveUserAddressSet(c.env, user.id);

  return c.json({
    id: user.id,
    email: userAddressSet.primaryEmail,
    emails: userAddressSet.emails,
    username: user.username,
    role: user.role,
  });
});

api.post(
  '/me/password',
  zValidator('json', selfPasswordUpdateSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: 'newPassword is required (minimum 8 characters)' }, 400);
    }
  }),
  async (c) => {
    const user = c.get('user');
    const body = c.req.valid('json');

    const existingUser = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(user.id)
      .first<{ password_hash: string }>();

    if (!existingUser) {
      return c.json({ error: 'User not found' }, 404);
    }

    const matchesExisting = await verifyPassword(body.newPassword, existingUser.password_hash);
    if (matchesExisting) {
      return c.json({ error: 'New password must be different from current password' }, 400);
    }

    const nextPasswordHash = await hashPassword(body.newPassword);
    await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(nextPasswordHash, user.id)
      .run();

    return c.json({ ok: true });
  }
);

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

  const attachments = await listAttachmentsByOwner(c, user.id, 'sent_email_id', sentId);

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

  const attachments = await listAttachmentsByOwner(c, user.id, 'email_id', emailId);

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

  const email = await c.env.DB.prepare('SELECT id, folder FROM emails WHERE id = ? AND user_id = ?')
    .bind(emailId, user.id)
    .first<{ id: number; folder: string }>();

  if (!email) {
    return c.json({ error: 'Not found' }, 404);
  }

  const hardDeleteQuery = (c.req.query('hard') ?? '').trim().toLowerCase();
  const hardDelete = hardDeleteQuery === '1' || hardDeleteQuery === 'true';

  if (hardDelete) {
    if (email.folder !== 'trash') {
      return c.json({ error: 'Only trash emails can be permanently deleted' }, 400);
    }

    await deleteAttachmentsByOwner(c, user.id, 'email_id', emailId);
    await c.env.DB.prepare('DELETE FROM emails WHERE id = ? AND user_id = ?')
      .bind(emailId, user.id)
      .run();

    return c.json({ ok: true, mode: 'permanent' });
  }

  await c.env.DB.prepare("UPDATE emails SET folder = 'trash' WHERE id = ? AND user_id = ?")
    .bind(emailId, user.id)
    .run();

  return c.json({ ok: true, mode: 'trash' });
});

api.post('/emails/:id/restore', async (c) => {
  const user = c.get('user');
  const emailId = parseNumericId(c.req.param('id'));
  if (emailId === null) {
    return c.json({ error: 'Invalid email id' }, 400);
  }

  const email = await c.env.DB.prepare('SELECT id, folder FROM emails WHERE id = ? AND user_id = ?')
    .bind(emailId, user.id)
    .first<{ id: number; folder: string }>();

  if (!email) {
    return c.json({ error: 'Not found' }, 404);
  }

  if (email.folder !== 'trash') {
    return c.json({ error: 'Only trash emails can be restored' }, 400);
  }

  await c.env.DB.prepare("UPDATE emails SET folder = 'inbox' WHERE id = ? AND user_id = ?")
    .bind(emailId, user.id)
    .run();

  return c.json({ ok: true });
});

api.delete('/sent/:id', async (c) => {
  const user = c.get('user');
  const sentId = parseNumericId(c.req.param('id'));
  if (sentId === null) {
    return c.json({ error: 'Invalid sent email id' }, 400);
  }

  const sent = await c.env.DB.prepare('SELECT id FROM sent_emails WHERE id = ? AND user_id = ?')
    .bind(sentId, user.id)
    .first<{ id: number }>();

  if (!sent) {
    return c.json({ error: 'Not found' }, 404);
  }

  await deleteAttachmentsByOwner(c, user.id, 'sent_email_id', sentId);
  await c.env.DB.prepare('DELETE FROM sent_emails WHERE id = ? AND user_id = ?')
    .bind(sentId, user.id)
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

  const userAddressSet = await resolveUserAddressSet(c.env, user.id);
  let fromAddress = userAddressSet.primaryEmail;

  if (typeof body.from === 'string' && body.from.trim().length > 0) {
    const normalizedFrom = normalizeEmailAddress(body.from);

    if (!isValidEmailAddress(normalizedFrom)) {
      return c.json({ error: 'from must be a valid email address' }, 400);
    }

    if (!userAddressSet.emails.includes(normalizedFrom)) {
      return c.json({ error: 'from address is not assigned to this account' }, 403);
    }

    fromAddress = normalizedFrom;
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
      from: fromAddress,
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

    return c.json({ ok: true, sentEmailId, from: fromAddress });
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

api.get('/admin/users', async (c) => {
  const users = await listAdminUsers(c.env);
  return c.json(users);
});

api.post(
  '/admin/users',
  zValidator('json', adminUserCreateSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: 'username, password, role, and primaryEmail are required' }, 400);
    }
  }),
  async (c) => {
    const body = c.req.valid('json');

    let desiredEmails: string[];
    try {
      desiredEmails = normalizeManagedEmails(body.primaryEmail, body.emails ?? []);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid email list' }, 400);
    }

    const username = body.username.trim();
    const [usernameError, emailError] = await Promise.all([
      validateUsernameAvailability(c.env, username),
      validateEmailAvailability(c.env, desiredEmails),
    ]);

    if (usernameError) {
      return c.json({ error: usernameError }, 409);
    }

    if (emailError) {
      return c.json({ error: emailError }, 409);
    }

    const [passwordHashResult, approvedSendersResult] = await Promise.allSettled([
      hashPassword(body.password),
      ensureApprovedSenders(c.env, desiredEmails),
    ]);

    if (approvedSendersResult.status === 'rejected') {
      const rollbackAddresses =
        approvedSendersResult.reason instanceof ApprovedSenderSyncError
          ? approvedSendersResult.reason.createdAddresses
          : [];

      if (rollbackAddresses.length > 0) {
        try {
          await removeApprovedSenders(c.env, rollbackAddresses);
        } catch (rollbackErr) {
          console.error(
            'Failed to rollback OCI approved senders after create sync error:',
            rollbackErr
          );
        }
      }

      console.error('Failed to ensure OCI approved sender set during user create:', approvedSendersResult.reason);
      return c.json(
        {
          error:
            approvedSendersResult.reason instanceof Error
              ? approvedSendersResult.reason.message
              : 'OCI approved sender sync failed',
        },
        502
      );
    }

    if (passwordHashResult.status === 'rejected') {
      console.error('Failed to hash password during user create:', passwordHashResult.reason);
      return c.json({ error: 'Failed to create user' }, 500);
    }

    const passwordHash = passwordHashResult.value;
    const createdApprovedSenders = approvedSendersResult.value;

    try {
      const inserted = await c.env.DB.prepare(
        `
          INSERT INTO users (username, email, password_hash)
          VALUES (?, ?, ?)
          RETURNING id
        `
      )
        .bind(username, desiredEmails[0], passwordHash)
        .first<{ id: number }>();

      if (!inserted) {
        throw new Error('Failed to create user');
      }

      await Promise.all([
        replaceUserEmailAddresses(c.env, inserted.id, desiredEmails),
        setUserRole(c.env, inserted.id, body.role),
      ]);

      const createdUser = await getAdminUserById(c.env, inserted.id);
      if (!createdUser) {
        throw new Error('Failed to load newly created user');
      }

      return c.json(createdUser, 201);
    } catch (err) {
      console.error('User create failed after OCI sender sync:', err);

      if (createdApprovedSenders.length > 0) {
        try {
          await removeApprovedSenders(c.env, createdApprovedSenders);
        } catch (rollbackErr) {
          console.error('Failed to rollback OCI approved senders after user create error:', rollbackErr);
        }
      }

      if (isUniqueConstraintError(err)) {
        return c.json({ error: 'username or email is already in use' }, 409);
      }

      return c.json({ error: 'Failed to create user' }, 500);
    }
  }
);

api.put(
  '/admin/users/:id',
  zValidator('json', adminUserUpdateSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: 'username, role, and primaryEmail are required' }, 400);
    }
  }),
  async (c) => {
    const userId = parseNumericId(c.req.param('id'));
    if (userId === null) {
      return c.json({ error: 'Invalid user id' }, 400);
    }

    const body = c.req.valid('json');
    const existing = await getAdminUserById(c.env, userId);
    if (!existing) {
      return c.json({ error: 'User not found' }, 404);
    }

    if (existing.role === 'admin' && body.role !== 'admin') {
      const adminCount = await countAdminUsers(c.env);
      if (adminCount <= 1) {
        return c.json({ error: 'Cannot remove role from the last admin account' }, 400);
      }
    }

    let desiredEmails: string[];
    try {
      desiredEmails = normalizeManagedEmails(body.primaryEmail, body.emails ?? []);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid email list' }, 400);
    }

    const username = body.username.trim();
    const [usernameError, emailError] = await Promise.all([
      validateUsernameAvailability(c.env, username, userId),
      validateEmailAvailability(c.env, desiredEmails, userId),
    ]);

    if (usernameError) {
      return c.json({ error: usernameError }, 409);
    }

    if (emailError) {
      return c.json({ error: emailError }, 409);
    }

    const oldEmails = existing.emails;
    const emailsToDelete = difference(oldEmails, desiredEmails);

    const shouldUpdatePassword = typeof body.password === 'string' && body.password.length > 0;
    const [passwordHashResult, approvedSendersResult] = await Promise.allSettled([
      shouldUpdatePassword ? hashPassword(body.password as string) : Promise.resolve<string | null>(null),
      ensureApprovedSenders(c.env, desiredEmails),
    ]);

    if (approvedSendersResult.status === 'rejected') {
      const rollbackAddresses =
        approvedSendersResult.reason instanceof ApprovedSenderSyncError
          ? approvedSendersResult.reason.createdAddresses
          : [];

      if (rollbackAddresses.length > 0) {
        try {
          await removeApprovedSenders(c.env, rollbackAddresses);
        } catch (rollbackErr) {
          console.error(
            'Failed to rollback OCI approved senders after update sync error:',
            rollbackErr
          );
        }
      }

      console.error('Failed to ensure OCI approved sender set during user update:', approvedSendersResult.reason);
      return c.json(
        {
          error:
            approvedSendersResult.reason instanceof Error
              ? approvedSendersResult.reason.message
              : 'OCI approved sender sync failed',
        },
        502
      );
    }

    if (passwordHashResult.status === 'rejected') {
      console.error('Failed to hash password during user update:', passwordHashResult.reason);
      return c.json({ error: 'Failed to update user' }, 500);
    }

    const createdApprovedSenders = approvedSendersResult.value;
    const nextPasswordHash = passwordHashResult.value;

    try {
      await c.env.DB.prepare('UPDATE users SET username = ?, email = ? WHERE id = ?')
        .bind(username, desiredEmails[0], userId)
        .run();

      await Promise.all([
        replaceUserEmailAddresses(c.env, userId, desiredEmails),
        setUserRole(c.env, userId, body.role),
      ]);

      if (nextPasswordHash) {
        await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
          .bind(nextPasswordHash, userId)
          .run();
      }
    } catch (err) {
      console.error('Failed to update user in database:', err);

      if (createdApprovedSenders.length > 0) {
        try {
          await removeApprovedSenders(c.env, createdApprovedSenders);
        } catch (rollbackErr) {
          console.error('Failed to rollback OCI approved senders after user update error:', rollbackErr);
        }
      }

      if (isUniqueConstraintError(err)) {
        return c.json({ error: 'username or email is already in use' }, 409);
      }

      return c.json({ error: 'Failed to update user' }, 500);
    }

    const staleSenderWarningPromise: Promise<string | null> = (async () => {
      if (emailsToDelete.length === 0) {
        return null;
      }

      console.info('Removing stale OCI approved senders during user update', {
        userId,
        emails: emailsToDelete,
      });

      try {
        await removeApprovedSenders(c.env, emailsToDelete);
        console.info('Removed stale OCI approved senders during user update', {
          userId,
          removedCount: emailsToDelete.length,
          emails: emailsToDelete,
        });
        return null;
      } catch (err) {
        console.error('Failed to remove stale OCI approved senders during user update:', err);
        return err instanceof Error ? err.message : 'Failed to remove old OCI approved senders';
      }
    })();

    const [updated, warning] = await Promise.all([
      getAdminUserById(c.env, userId),
      staleSenderWarningPromise,
    ]);

    if (!updated) {
      return c.json({ error: 'User disappeared after update' }, 500);
    }

    return c.json({
      ...updated,
      ...(warning ? { warning } : {}),
    });
  }
);

api.delete('/admin/users/:id', async (c) => {
  const actingUser = c.get('user');
  const userId = parseNumericId(c.req.param('id'));
  if (userId === null) {
    return c.json({ error: 'Invalid user id' }, 400);
  }

  if (actingUser.id === userId) {
    return c.json({ error: 'You cannot delete your own admin account' }, 400);
  }

  const existing = await getAdminUserById(c.env, userId);
  if (!existing) {
    return c.json({ error: 'User not found' }, 404);
  }

  if (existing.role === 'admin') {
    const adminCount = await countAdminUsers(c.env);
    if (adminCount <= 1) {
      return c.json({ error: 'Cannot delete the last admin account' }, 400);
    }
  }

  console.info('Removing OCI approved senders before user delete', {
    userId,
    emails: existing.emails,
  });

  try {
    await removeApprovedSenders(c.env, existing.emails);
    console.info('Removed OCI approved senders before user delete', {
      userId,
      removedCount: existing.emails.length,
      emails: existing.emails,
    });
  } catch (err) {
    console.error('Failed to remove OCI approved senders during user delete:', err);
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to remove OCI approved senders' },
      502
    );
  }

  try {
    await c.env.DB.prepare('DELETE FROM users WHERE id = ?')
      .bind(userId)
      .run();
  } catch (err) {
    console.error('Failed to delete user row after OCI sender deletion:', err);

    try {
      await ensureApprovedSenders(c.env, existing.emails);
    } catch (rollbackErr) {
      console.error('Failed to restore OCI approved senders after delete rollback:', rollbackErr);
    }

    return c.json({ error: 'Failed to delete user' }, 500);
  }

  return c.json({ ok: true, id: userId });
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
