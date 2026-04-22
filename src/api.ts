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
  createSession,
  getLoginThrottleKey,
  getSessionCookieName,
  hashPassword,
  revokeSession,
  verifyPassword,
} from './auth';
import {
  decodeBase64ToBytes,
  escapeQuotedHeaderValue,
  normalizeAttachmentContent,
  normalizeMimeType,
  sanitizeFilename,
} from './attachment-utils';
import { sendEmail, type SendAttachment } from './send';
import {
  findUserIdByEmailAddress,
  isValidEmailAddress,
  listUserEmailIdentities,
  normalizeEmailAddress,
  type UserEmailIdentity,
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
const LOGIN_RATE_LIMIT_PERIOD_SECONDS = 60;
const CONTACT_ME_DESTINATION_ADDRESS = 'hpark1@k1ngcrypt.com';
const CONTACT_ME_MAX_NAME_LENGTH = 160;
const CONTACT_ME_MAX_EMAIL_LENGTH = 320;
const CONTACT_ME_MAX_BODY_LENGTH = 10_000;
const HOSTILE_CONTROL_CHAR_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

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
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

const sendAttachmentSchema = z.object({
  filename: z.string(),
  content: z.string(),
  mimeType: z.string().optional(),
});

const sendBodySchema = z.object({
  from: z.string().trim().optional(),
  to: z.string().trim().min(1),
  subject: z.string().trim().min(1),
  text: z.string().trim().min(1),
  html: z.string().optional(),
  attachments: z.array(sendAttachmentSchema).max(MAX_ATTACHMENT_COUNT).optional(),
});

const contactMeBodySchema = z.object({
  name: z.string().min(1).max(CONTACT_ME_MAX_NAME_LENGTH * 2),
  email: z.string().min(3).max(CONTACT_ME_MAX_EMAIL_LENGTH * 2),
  body: z.string().min(1).max(CONTACT_ME_MAX_BODY_LENGTH * 2),
});

const adminAliasIdentitySchema = z.object({
  address: z.string().trim().min(3),
  name: z.string().trim().min(1).max(160),
});

const adminRoleSchema = z.enum(['admin', 'user']);
const adminUserCreateSchema = z.object({
  username: z.string().trim().min(1).max(120),
  password: z.string().min(8),
  role: adminRoleSchema,
  primaryEmail: z.string().trim().min(3),
  primaryName: z.string().trim().min(1).max(160),
  aliases: z.array(adminAliasIdentitySchema).optional().default([]),
});

const adminUserUpdateSchema = z.object({
  username: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(8).optional(),
  role: adminRoleSchema.optional(),
  primaryEmail: z.string().trim().min(3).optional(),
  primaryName: z.string().trim().min(1).max(160).optional(),
  aliases: z.array(adminAliasIdentitySchema).optional(),
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

  if (path === '/api/contactme') {
    return 'name, email, and body are required';
  }

  if (path === '/api/send') {
    return 'to, subject, and text are required';
  }

  return 'Invalid JSON payload';
}

function normalizeNextPath(nextPath: string | null | undefined): string | null {
  if (typeof nextPath !== 'string') {
    return null;
  }

  const trimmed = nextPath.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return null;
  }

  return trimmed;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

function sanitizeSingleLineHostileInput(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\r\n?|\n/g, ' ')
    .replace(HOSTILE_CONTROL_CHAR_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeMultilineHostileInput(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(HOSTILE_CONTROL_CHAR_PATTERN, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type SanitizedContactMePayload = {
  name: string;
  email: string;
  body: string;
};

function sanitizeContactMePayload(payload: z.infer<typeof contactMeBodySchema>): SanitizedContactMePayload {
  const sanitizedName = escapeHtml(sanitizeSingleLineHostileInput(payload.name));
  const normalizedEmail = normalizeEmailAddress(sanitizeSingleLineHostileInput(payload.email));
  const sanitizedBody = escapeHtml(sanitizeMultilineHostileInput(payload.body));

  if (!sanitizedName) {
    throw new Error('name is required');
  }

  if (sanitizedName.length > CONTACT_ME_MAX_NAME_LENGTH) {
    throw new Error(`name must be ${CONTACT_ME_MAX_NAME_LENGTH} characters or fewer`);
  }

  if (!normalizedEmail || normalizedEmail.length > CONTACT_ME_MAX_EMAIL_LENGTH) {
    throw new Error('email must be a valid email address');
  }

  if (!isValidEmailAddress(normalizedEmail)) {
    throw new Error('email must be a valid email address');
  }

  if (!sanitizedBody) {
    throw new Error('body is required');
  }

  if (sanitizedBody.length > CONTACT_ME_MAX_BODY_LENGTH) {
    throw new Error(`body must be ${CONTACT_ME_MAX_BODY_LENGTH} characters or fewer`);
  }

  return {
    name: sanitizedName,
    email: normalizedEmail,
    body: sanitizedBody,
  };
}

function isAdminPath(path: string): boolean {
  return path === '/admin' || path === '/admin/index.html';
}

function resolveAuthenticatedLoginDestination(nextPath: string | null, role: UserRole): string {
  if (!nextPath) {
    return '/mail';
  }

  if (isAdminPath(nextPath) && role !== 'admin') {
    return '/mail';
  }

  return nextPath;
}

function redirectToLoginWithNext(c: Context<AppBindings>, nextPath: string): Response {
  const normalizedNext = normalizeNextPath(nextPath);
  if (!normalizedNext) {
    return c.redirect('/login', 302);
  }

  return c.redirect(`/login?next=${encodeURIComponent(normalizedNext)}`, 302);
}

async function resolveUserAddressSet(
  env: Env,
  userId: number
): Promise<{
  primaryEmail: string;
  primaryName: string;
  emails: string[];
  emailIdentities: UserEmailIdentity[];
  nameByEmail: Map<string, string>;
}> {
  const emailIdentities = await listUserEmailIdentities(env, userId);
  const primaryIdentity = emailIdentities[0];
  if (!primaryIdentity) {
    throw new Error(`User ${userId} has no email addresses configured`);
  }

  const emails = emailIdentities.map((identity) => identity.address);
  const nameByEmail = new Map<string, string>();
  for (const identity of emailIdentities) {
    nameByEmail.set(identity.address, identity.name);
  }

  return {
    primaryEmail: primaryIdentity.address,
    primaryName: primaryIdentity.name,
    emails,
    emailIdentities,
    nameByEmail,
  };
}

interface AdminUserRow {
  id: number;
  username: string;
  created_at: string;
  role: string | null;
}

type D1Statement = ReturnType<Env['DB']['prepare']>;

interface UserAddressOwnerRow {
  user_id: number;
}

interface UserAddressByUserRow {
  user_id: number;
  address: string;
  display_name: string;
  is_primary: number;
  oci_sender_id: string | null;
}

type ManagedEmailIdentity = {
  address: string;
  name: string;
};

interface IdentityAvailabilityRow {
  entry_type: 'username' | 'email';
  owner_id: number;
  value: string;
}

function normalizeRole(role: string | null | undefined): UserRole {
  return role === 'admin' ? 'admin' : 'user';
}

function normalizeManagedIdentities(
  primaryEmail: string,
  primaryName: string,
  aliasIdentities: Array<{ address: string; name: string }>
): ManagedEmailIdentity[] {
  const normalizedPrimary = normalizeEmailAddress(primaryEmail);
  if (!isValidEmailAddress(normalizedPrimary)) {
    throw new Error('primaryEmail must be a valid email address');
  }

  const normalizedPrimaryName = primaryName.trim();
  if (!normalizedPrimaryName) {
    throw new Error('primaryName is required');
  }

  const normalizedIdentities: ManagedEmailIdentity[] = [
    {
      address: normalizedPrimary,
      name: normalizedPrimaryName,
    },
  ];
  const seen = new Set<string>([normalizedPrimary]);

  for (const candidate of aliasIdentities) {
    const normalized = normalizeEmailAddress(String(candidate?.address ?? ''));
    if (!normalized) {
      continue;
    }

    if (!isValidEmailAddress(normalized)) {
      throw new Error(`Invalid email address: ${String(candidate?.address ?? '')}`);
    }

    const normalizedAliasName = String(candidate?.name ?? '').trim();
    if (!normalizedAliasName) {
      throw new Error(`Display name is required for ${normalized}`);
    }

    if (!seen.has(normalized)) {
      seen.add(normalized);
      normalizedIdentities.push({
        address: normalized,
        name: normalizedAliasName,
      });
    }
  }

  return normalizedIdentities;
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

type UserAddressSet = {
  primaryEmail: string;
  primaryName: string;
  emails: string[];
  emailIdentities: UserEmailIdentity[];
  nameByEmail: Map<string, string>;
  senderIdByEmail: Map<string, string>;
};

async function resolveUserAddressSets(
  env: Env,
  userIds: number[]
): Promise<Map<number, UserAddressSet>> {
  const uniqueUserIds = Array.from(new Set(userIds.filter((userId) => Number.isSafeInteger(userId) && userId > 0)));
  const addressSets = new Map<number, UserAddressSet>();

  if (uniqueUserIds.length === 0) {
    return addressSets;
  }

  const placeholders = buildSqlPlaceholders(uniqueUserIds.length);
  const rows = await env.DB.prepare(
    `
      SELECT user_id, address, display_name, is_primary, oci_sender_id
      FROM user_addresses
      WHERE user_id IN (${placeholders})
      ORDER BY user_id ASC, is_primary DESC, id ASC
    `
  )
    .bind(...uniqueUserIds)
    .all<UserAddressByUserRow>();

  const identitiesByUser = new Map<number, UserEmailIdentity[]>();
  const seenByUser = new Map<number, Set<string>>();
  const senderIdByUser = new Map<number, Map<string, string>>();

  for (const row of rows.results ?? []) {
    const normalized = normalizeEmailAddress(String(row.address ?? ''));
    if (!normalized) {
      continue;
    }

    const userId = Number(row.user_id);
    if (!seenByUser.has(userId)) {
      seenByUser.set(userId, new Set());
      identitiesByUser.set(userId, []);
      senderIdByUser.set(userId, new Map());
    }

    const seen = seenByUser.get(userId) as Set<string>;
    if (seen.has(normalized)) {
      continue;
    }

    const displayName = String(row.display_name ?? '').trim();
    if (!displayName) {
      throw new Error(`User ${userId} has address ${normalized} without a display name`);
    }

    seen.add(normalized);
    (identitiesByUser.get(userId) as UserEmailIdentity[]).push({
      address: normalized,
      name: displayName,
      isPrimary: Number(row.is_primary ?? 0) === 1,
    });

    const senderId = String(row.oci_sender_id ?? '').trim();
    if (senderId) {
      (senderIdByUser.get(userId) as Map<string, string>).set(normalized, senderId);
    }
  }

  for (const userId of uniqueUserIds) {
    const emailIdentities = identitiesByUser.get(userId) ?? [];
    const primaryIdentity = emailIdentities[0];
    if (!primaryIdentity) {
      throw new Error(`User ${userId} has no email addresses configured`);
    }

    const emails = emailIdentities.map((identity) => identity.address);
    const nameByEmail = new Map<string, string>();
    for (const identity of emailIdentities) {
      nameByEmail.set(identity.address, identity.name);
    }
    const senderIdByEmail = senderIdByUser.get(userId) ?? new Map<string, string>();

    addressSets.set(userId, {
      primaryEmail: primaryIdentity.address,
      primaryName: primaryIdentity.name,
      emails,
      emailIdentities,
      nameByEmail,
      senderIdByEmail,
    });
  }

  return addressSets;
}

function buildUserRoleUpsertStatement(env: Env, userId: number, role: UserRole): D1Statement {
  return env.DB.prepare(
    `
      INSERT INTO user_roles (user_id, role, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        role = excluded.role,
        updated_at = excluded.updated_at
    `
  )
    .bind(userId, role);
}

function buildUserAddressInsertStatements(
  env: Env,
  userId: number,
  identities: ManagedEmailIdentity[],
  senderIdByEmail: ReadonlyMap<string, string>
): D1Statement[] {
  if (identities.length === 0) {
    throw new Error('At least one email identity is required');
  }

  const statements: D1Statement[] = [];

  for (const identity of identities) {
    const emailAddress = identity.address;
    const senderId = String(senderIdByEmail.get(emailAddress) ?? '').trim();
    if (!senderId) {
      throw new Error(`Missing OCI sender OCID for ${emailAddress}`);
    }

    statements.push(
      env.DB.prepare(
        `
          INSERT INTO user_addresses (user_id, address, display_name, is_primary, oci_sender_id)
          VALUES (?, ?, ?, ?, ?)
        `
      ).bind(
        userId,
        identity.address,
        identity.name,
        statements.length === 0 ? 1 : 0,
        senderId
      )
    );
  }

  return statements;
}

function buildReplaceUserAddressStatements(
  env: Env,
  userId: number,
  identities: ManagedEmailIdentity[],
  senderIdByEmail: ReadonlyMap<string, string>
): D1Statement[] {
  return [
    env.DB.prepare('DELETE FROM user_addresses WHERE user_id = ?').bind(userId),
    ...buildUserAddressInsertStatements(env, userId, identities, senderIdByEmail),
  ];
}

async function initializeManagedUserState(
  env: Env,
  options: {
    userId: number;
    role: UserRole;
    identities: ManagedEmailIdentity[];
    senderIdByEmail: ReadonlyMap<string, string>;
  }
): Promise<void> {
  const statements: D1Statement[] = [
    buildUserRoleUpsertStatement(env, options.userId, options.role),
    ...buildUserAddressInsertStatements(
      env,
      options.userId,
      options.identities,
      options.senderIdByEmail
    ),
  ];

  await env.DB.batch(statements);
}

async function persistManagedUserState(
  env: Env,
  options: {
    userId: number;
    username: string;
    role: UserRole;
    identities: ManagedEmailIdentity[];
    senderIdByEmail: ReadonlyMap<string, string>;
    passwordHash?: string | null;
  }
): Promise<void> {
  const primaryEmail = options.identities[0]?.address;
  if (!primaryEmail) {
    throw new Error('At least one email identity is required');
  }

  const statements: D1Statement[] = [
    buildUserRoleUpsertStatement(env, options.userId, options.role),
    ...buildReplaceUserAddressStatements(
      env,
      options.userId,
      options.identities,
      options.senderIdByEmail
    ),
    env.DB.prepare(
      `
        UPDATE users
        SET username = ?, email = ?, password_hash = COALESCE(?, password_hash)
        WHERE id = ?
      `
    ).bind(options.username, primaryEmail, options.passwordHash ?? null, options.userId),
  ];

  await env.DB.batch(statements);
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
    name: string;
    primaryName: string;
    primaryEmail: string;
    emails: string[];
    emailIdentities: UserEmailIdentity[];
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
      name: addressSet.primaryName,
      primaryName: addressSet.primaryName,
      primaryEmail: addressSet.primaryEmail,
      emails: addressSet.emails,
      emailIdentities: addressSet.emailIdentities,
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
  name: string;
  primaryName: string;
  primaryEmail: string;
  emails: string[];
  emailIdentities: UserEmailIdentity[];
  senderIdByEmail: Map<string, string>;
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
    name: addressSet.primaryName,
    primaryName: addressSet.primaryName,
    primaryEmail: addressSet.primaryEmail,
    emails: addressSet.emails,
    emailIdentities: addressSet.emailIdentities,
    senderIdByEmail: addressSet.senderIdByEmail,
    createdAt: row.created_at,
  };
}

async function validateAdminUserAvailability(
  env: Env,
  username: string,
  emails: string[],
  currentUserId?: number
): Promise<string | null> {
  const uniqueEmails = Array.from(new Set(emails));
  const emailFilterClause =
    uniqueEmails.length > 0
      ? `
      UNION ALL
      SELECT 'email' AS entry_type, user_id AS owner_id, address AS value
      FROM user_addresses
      WHERE address IN (${buildSqlPlaceholders(uniqueEmails.length)})
      `
      : '';

  const rows = await env.DB.prepare(
    `
      SELECT 'username' AS entry_type, id AS owner_id, username AS value
      FROM users
      WHERE username = ?
      ${emailFilterClause}
    `
  )
    .bind(username, ...uniqueEmails)
    .all<IdentityAvailabilityRow>();

  let usernameOwnerId: number | null = null;
  const ownerByEmail = new Map<string, number>();

  for (const row of rows.results ?? []) {
    const ownerId = Number(row.owner_id);
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
      continue;
    }

    if (row.entry_type === 'username') {
      usernameOwnerId = ownerId;
      continue;
    }

    const normalized = normalizeEmailAddress(String(row.value ?? ''));
    if (!normalized) {
      continue;
    }

    ownerByEmail.set(normalized, ownerId);
  }

  if (usernameOwnerId !== null && usernameOwnerId !== currentUserId) {
    return 'username is already in use';
  }

  for (let i = 0; i < uniqueEmails.length; i += 1) {
    const emailAddress = uniqueEmails[i];
    const ownerId = ownerByEmail.get(emailAddress) ?? null;
    if (ownerId !== null && ownerId !== currentUserId) {
      return `${emailAddress} is already assigned to another user`;
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
    const destination = resolveAuthenticatedLoginDestination(
      normalizeNextPath(c.req.query('next')),
      user.role
    );
    return c.redirect(destination, 302);
  }

  return c.html(getLoginHtml());
});

async function handleMailPage(c: Context<AppBindings>): Promise<Response> {
  const user = await authenticate(c.req.raw, c.env);
  if (!user) {
    return redirectToLoginWithNext(c, '/mail');
  }

  return c.html(getWebmailHtml());
}

async function handleAdminPage(c: Context<AppBindings>): Promise<Response> {
  const user = await authenticate(c.req.raw, c.env);
  if (!user) {
    return redirectToLoginWithNext(c, '/admin');
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
  async (c, next) => {
    const body = c.req.valid('json');
    const username = body.username;

    try {
      const throttleKey = getLoginThrottleKey(c.req.raw, username);
      const { success } = await c.env.LOGIN_RATE_LIMITER.limit({ key: throttleKey });

      if (!success) {
        c.header('Retry-After', String(LOGIN_RATE_LIMIT_PERIOD_SECONDS));
        return c.json({ error: 'Too many login attempts. Try again later.' }, 429);
      }
    } catch (err) {
      // Keep auth available if the limiter binding is temporarily unavailable.
      console.error('Login rate limit check failed:', err);
    }

    await next();
  },
  async (c) => {
    const body = c.req.valid('json');
    const username = body.username;

    const user = await c.env.DB.prepare(
      `
        SELECT users.id, users.username, users.password_hash, COALESCE(user_roles.role, 'user') AS role
        FROM users
        LEFT JOIN user_roles ON user_roles.user_id = users.id
        WHERE users.username = ?
        LIMIT 1
      `
    )
      .bind(username)
      .first<{ id: number; username: string; password_hash: string; role: string | null }>();

    if (!user) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const passwordOk = await verifyPassword(body.password, user.password_hash);
    if (!passwordOk) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const [session, userAddressSet] = await Promise.all([
      createSession(c.env, user.id),
      resolveUserAddressSet(c.env, user.id),
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
      primaryName: userAddressSet.primaryName,
      emailIdentities: userAddressSet.emailIdentities,
      emails: userAddressSet.emails,
      username: user.username,
      name: userAddressSet.primaryName,
      role: normalizeRole(user.role),
      expiresAt: session.expiresAt,
    });
  }
);

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

api.post(
  '/contactme',
  zValidator('json', contactMeBodySchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: 'name, email, and body are required' }, 400);
    }
  }),
  async (c) => {
    let sanitized: SanitizedContactMePayload;

    try {
      sanitized = sanitizeContactMePayload(c.req.valid('json'));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid contact payload' }, 400);
    }

    const destinationUserId = await findUserIdByEmailAddress(c.env, CONTACT_ME_DESTINATION_ADDRESS);
    if (!destinationUserId) {
      console.error(
        `Contact endpoint destination mailbox is not configured for ${CONTACT_ME_DESTINATION_ADDRESS}`
      );
      return c.json({ error: 'Contact inbox unavailable' }, 503);
    }

    const messageBody = [
      'Contact form submission',
      `Name: ${sanitized.name}`,
      `Email: ${sanitized.email}`,
      '',
      sanitized.body,
    ].join('\n');

    const messageId = `<contactme-${crypto.randomUUID()}@webmail.local>`;
    const subject = `Contact request from ${sanitized.name}`;
    const rawSize = new TextEncoder().encode(messageBody).byteLength;

    await c.env.DB.prepare(
      `
        INSERT INTO emails
          (user_id, message_id, from_address, from_name, to_address,
           subject, body_text, body_html, raw_size, folder)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'inbox')
      `
    )
      .bind(
        destinationUserId,
        messageId,
        sanitized.email,
        sanitized.name,
        CONTACT_ME_DESTINATION_ADDRESS,
        subject,
        messageBody,
        rawSize
      )
      .run();

    return c.json({ ok: true });
  }
);

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
    primaryName: userAddressSet.primaryName,
    emailIdentities: userAddressSet.emailIdentities,
    emails: userAddressSet.emails,
    username: user.username,
    name: userAddressSet.primaryName,
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
      const firstIssue = result.error.issues[0];
      if (firstIssue) {
        if (
          firstIssue.path[0] === 'attachments' &&
          firstIssue.code === 'invalid_type' &&
          firstIssue.path.length === 1
        ) {
          return c.json({ error: 'attachments must be an array' }, 400);
        }

        if (firstIssue.path[0] === 'attachments' && firstIssue.code === 'too_big') {
          return c.json({ error: `Too many attachments (max ${MAX_ATTACHMENT_COUNT})` }, 400);
        }

        if (firstIssue.path[0] === 'attachments' && typeof firstIssue.path[1] === 'number') {
          return c.json({ error: `Invalid attachment at index ${firstIssue.path[1]}` }, 400);
        }
      }

      return c.json({ error: 'to, subject, and text are required' }, 400);
    }
  }),
  async (c) => {
    const user = c.get('user');
    const body = c.req.valid('json');

    const userAddressSet = await resolveUserAddressSet(c.env, user.id);
    let fromAddress = userAddressSet.primaryEmail;
    let fromName = userAddressSet.primaryName;

    if (body.from) {
      const normalizedFrom = normalizeEmailAddress(body.from);

      if (!isValidEmailAddress(normalizedFrom)) {
        return c.json({ error: 'from must be a valid email address' }, 400);
      }

      if (!userAddressSet.nameByEmail.has(normalizedFrom)) {
        return c.json({ error: 'from address is not assigned to this account' }, 403);
      }

      fromAddress = normalizedFrom;
      fromName = userAddressSet.nameByEmail.get(normalizedFrom) ?? userAddressSet.primaryName;
    }

    const incomingAttachments = body.attachments ?? [];
    const preparedAttachments: PreparedSendAttachment[] = [];
    let totalAttachmentBytes = 0;

    for (let i = 0; i < incomingAttachments.length; i += 1) {
      const attachment = incomingAttachments[i];
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
        mimeType: normalizeMimeType(attachment.mimeType),
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
        httpMetadata: { contentType: normalizeMimeType(attachment.mimeType) },
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
          normalizeMimeType(attachment.mimeType),
          attachment.bytes.byteLength
        )
        .run();
    }

    await sendEmail(c.env, {
      from: fromAddress,
      fromName,
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

    return c.json({ ok: true, sentEmailId, from: fromAddress, fromName });
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
      return c.json(
        { error: 'username, password, role, primaryEmail, and primaryName are required' },
        400
      );
    }
  }),
  async (c) => {
    const body = c.req.valid('json');

    let desiredIdentities: ManagedEmailIdentity[];
    try {
      desiredIdentities = normalizeManagedIdentities(
        body.primaryEmail,
        body.primaryName,
        body.aliases ?? []
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid email list' }, 400);
    }

    const desiredEmails = desiredIdentities.map((identity) => identity.address);

    const username = body.username.trim();
    const availabilityError = await validateAdminUserAvailability(c.env, username, desiredEmails);
    if (availabilityError) {
      return c.json({ error: availabilityError }, 409);
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
      const rollbackSenderIdByEmail =
        approvedSendersResult.reason instanceof ApprovedSenderSyncError
          ? approvedSendersResult.reason.createdSenderIdByEmail
          : new Map<string, string>();

      if (rollbackAddresses.length > 0) {
        try {
          await removeApprovedSenders(c.env, rollbackAddresses, {
            senderIdByEmail: rollbackSenderIdByEmail,
          });
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
    const {
      createdAddresses: createdApprovedSenders,
      senderIdByEmail: ensuredSenderIdByEmail,
    } = approvedSendersResult.value;

    try {
      const inserted = await c.env.DB.prepare(
        `
          INSERT INTO users (username, email, password_hash)
          VALUES (?, ?, ?)
          RETURNING id, created_at
        `
      )
        .bind(username, desiredEmails[0], passwordHash)
        .first<{ id: number; created_at: string }>();

      if (!inserted) {
        throw new Error('Failed to create user');
      }

      await initializeManagedUserState(c.env, {
        userId: inserted.id,
        role: body.role,
        identities: desiredIdentities,
        senderIdByEmail: ensuredSenderIdByEmail,
      });

      const primaryIdentity = desiredIdentities[0];

      return c.json(
        {
          id: inserted.id,
          username,
          name: primaryIdentity.name,
          primaryName: primaryIdentity.name,
          role: body.role,
          primaryEmail: desiredEmails[0],
          emails: desiredEmails,
          emailIdentities: desiredIdentities.map((identity, index) => ({
            address: identity.address,
            name: identity.name,
            isPrimary: index === 0,
          })),
          createdAt: inserted.created_at,
        },
        201
      );
    } catch (err) {
      console.error('User create failed after OCI sender sync:', err);

      if (createdApprovedSenders.length > 0) {
        try {
          const createdSenderIdByEmail = new Map<string, string>();
          for (const emailAddress of createdApprovedSenders) {
            const senderId = ensuredSenderIdByEmail.get(emailAddress);
            if (senderId) {
              createdSenderIdByEmail.set(emailAddress, senderId);
            }
          }

          await removeApprovedSenders(c.env, createdApprovedSenders, {
            senderIdByEmail: createdSenderIdByEmail,
          });
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
      return c.json({ error: 'Invalid user update payload' }, 400);
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

    const existingSenderIdByEmail = existing.senderIdByEmail;

    const username = (body.username ?? existing.username).trim();
    const role: UserRole = body.role ?? existing.role;
    const existingAliases = existing.emailIdentities
      .filter((identity) => identity.address !== existing.primaryEmail)
      .map((identity) => ({
        address: identity.address,
        name: identity.name,
      }));
    const requestedPrimaryEmail = body.primaryEmail ?? existing.primaryEmail;
    const requestedPrimaryName = body.primaryName ?? existing.primaryName;
    const requestedAliases = body.aliases ?? existingAliases;

    if (existing.role === 'admin' && role !== 'admin') {
      const adminCount = await countAdminUsers(c.env);
      if (adminCount <= 1) {
        return c.json({ error: 'Cannot remove role from the last admin account' }, 400);
      }
    }

    let desiredIdentities: ManagedEmailIdentity[];
    try {
      desiredIdentities = normalizeManagedIdentities(
        requestedPrimaryEmail,
        requestedPrimaryName,
        requestedAliases
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid email list' }, 400);
    }

    const desiredEmails = desiredIdentities.map((identity) => identity.address);

    const availabilityError = await validateAdminUserAvailability(
      c.env,
      username,
      desiredEmails,
      userId
    );
    if (availabilityError) {
      return c.json({ error: availabilityError }, 409);
    }

    const oldEmails = existing.emails;
    const emailsToEnsure = difference(desiredEmails, oldEmails);
    const emailsToDelete = difference(oldEmails, desiredEmails);

    const shouldUpdatePassword = typeof body.password === 'string' && body.password.length > 0;
    const [passwordHashResult, approvedSendersResult] = await Promise.allSettled([
      shouldUpdatePassword ? hashPassword(body.password as string) : Promise.resolve<string | null>(null),
      emailsToEnsure.length > 0
        ? ensureApprovedSenders(c.env, emailsToEnsure)
        : Promise.resolve({ createdAddresses: [], senderIdByEmail: new Map<string, string>() }),
    ]);

    if (approvedSendersResult.status === 'rejected') {
      const rollbackAddresses =
        approvedSendersResult.reason instanceof ApprovedSenderSyncError
          ? approvedSendersResult.reason.createdAddresses
          : [];
      const rollbackSenderIdByEmail =
        approvedSendersResult.reason instanceof ApprovedSenderSyncError
          ? approvedSendersResult.reason.createdSenderIdByEmail
          : new Map<string, string>();

      if (rollbackAddresses.length > 0) {
        try {
          await removeApprovedSenders(c.env, rollbackAddresses, {
            senderIdByEmail: rollbackSenderIdByEmail,
          });
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

    const {
      createdAddresses: createdApprovedSenders,
      senderIdByEmail: ensuredSenderIdByEmail,
    } = approvedSendersResult.value;
    const nextPasswordHash = passwordHashResult.value;

    const desiredSenderIdByEmail = new Map<string, string>();
    for (const emailAddress of desiredEmails) {
      const senderId =
        ensuredSenderIdByEmail.get(emailAddress) ?? existingSenderIdByEmail.get(emailAddress);
      if (senderId) {
        desiredSenderIdByEmail.set(emailAddress, senderId);
      }
    }

    try {
      await persistManagedUserState(c.env, {
        userId,
        username,
        role,
        identities: desiredIdentities,
        senderIdByEmail: desiredSenderIdByEmail,
        passwordHash: nextPasswordHash,
      });
    } catch (err) {
      console.error('Failed to update user in database:', err);

      if (createdApprovedSenders.length > 0) {
        try {
          const createdSenderIdByEmail = new Map<string, string>();
          for (const emailAddress of createdApprovedSenders) {
            const senderId = ensuredSenderIdByEmail.get(emailAddress);
            if (senderId) {
              createdSenderIdByEmail.set(emailAddress, senderId);
            }
          }

          await removeApprovedSenders(c.env, createdApprovedSenders, {
            senderIdByEmail: createdSenderIdByEmail,
          });
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

      try {
        const staleSenderIdByEmail = new Map<string, string>();
        for (const emailAddress of emailsToDelete) {
          const senderId = existingSenderIdByEmail.get(emailAddress);
          if (senderId) {
            staleSenderIdByEmail.set(emailAddress, senderId);
          }
        }

        await removeApprovedSenders(c.env, emailsToDelete, {
          senderIdByEmail: staleSenderIdByEmail,
        });
        return null;
      } catch (err) {
        console.error('Failed to remove stale OCI approved senders during user update:', err);
        return err instanceof Error ? err.message : 'Failed to remove old OCI approved senders';
      }
    })();

    const warning = await staleSenderWarningPromise;

    const primaryIdentity = desiredIdentities[0];

    return c.json({
      id: userId,
      username,
      name: primaryIdentity.name,
      primaryName: primaryIdentity.name,
      role,
      primaryEmail: desiredEmails[0],
      emails: desiredEmails,
      emailIdentities: desiredIdentities.map((identity, index) => ({
        address: identity.address,
        name: identity.name,
        isPrimary: index === 0,
      })),
      createdAt: existing.createdAt,
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

  const existingSenderIdByEmail = existing.senderIdByEmail;

  try {
    await removeApprovedSenders(c.env, existing.emails, {
      senderIdByEmail: existingSenderIdByEmail,
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
