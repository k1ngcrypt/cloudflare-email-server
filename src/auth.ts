import type { Env } from './index';

const TOKEN_COOKIE_NAME = 'session_token';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;

const textEncoder = new TextEncoder();
let cachedAuthSecret: string | null = null;
let cachedAuthSecretKeyPromise: Promise<CryptoKey> | null = null;

export interface SessionInfo {
  token: string;
  expiresAt: string;
  maxAgeSeconds: number;
}

function getSessionSigningKey(authSecret: string): Promise<CryptoKey> {
  if (cachedAuthSecretKeyPromise && cachedAuthSecret === authSecret) {
    return cachedAuthSecretKeyPromise;
  }

  cachedAuthSecret = authSecret;
  cachedAuthSecretKeyPromise = crypto.subtle.importKey(
    'raw',
    textEncoder.encode(authSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  cachedAuthSecretKeyPromise.catch(() => {
    cachedAuthSecret = null;
    cachedAuthSecretKeyPromise = null;
  });

  return cachedAuthSecretKeyPromise;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function sessionTokenHash(env: Env, token: string): Promise<string> {
  const key = await getSessionSigningKey(env.AUTH_SECRET);
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(token));
  return bytesToHex(new Uint8Array(signature));
}

function extractTokenFromCookie(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';');
  for (const entry of cookies) {
    const [name, ...rest] = entry.trim().split('=');
    if (name === TOKEN_COOKIE_NAME) {
      const value = rest.join('=').trim();
      return value.length > 0 ? value : null;
    }
  }

  return null;
}

function extractSessionToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.length > 0) return token;
  }

  return extractTokenFromCookie(request);
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function getSessionCookieName(): string {
  return TOKEN_COOKIE_NAME;
}

export function getLoginThrottleKey(request: Request, username: string): string {
  const ip = request.headers.get('CF-Connecting-IP')?.trim() || 'unknown';
  return `${ip}:${username.trim().toLowerCase()}`;
}

export async function hashPassword(password: string): Promise<string> {
  const normalized = password.normalize('NFKC');
  return sha256Hex(textEncoder.encode(normalized));
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!SHA256_HEX_PATTERN.test(storedHash)) {
    return false;
  }

  const normalized = password.normalize('NFKC');
  const derived = await sha256Hex(textEncoder.encode(normalized));

  return constantTimeEqual(textEncoder.encode(derived), textEncoder.encode(storedHash.toLowerCase()));
}

export async function createSession(env: Env, userId: number): Promise<SessionInfo> {
  const token = randomToken();
  const tokenHash = await sessionTokenHash(env, token);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();

  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, userId, expiresAt)
    .run();

  return {
    token,
    expiresAt,
    maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
  };
}

export async function revokeSession(request: Request, env: Env): Promise<void> {
  const token = extractSessionToken(request);
  if (!token) return;

  const tokenHash = await sessionTokenHash(env, token);
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?')
    .bind(tokenHash)
    .run();
}

export async function authenticate(
  request: Request,
  env: Env
): Promise<{ id: number; username: string; role: 'admin' | 'user' } | null> {
  const token = extractSessionToken(request);
  if (!token) return null;

  const tokenHash = await sessionTokenHash(env, token);
  const now = new Date().toISOString();

  const session = await env.DB.prepare(
    `
      SELECT users.id, users.username, COALESCE(user_roles.role, 'user') AS role
      FROM sessions
      JOIN users ON sessions.user_id = users.id
      LEFT JOIN user_roles ON user_roles.user_id = users.id
      WHERE sessions.token = ?
        AND sessions.expires_at > ?
    `
  )
    .bind(tokenHash, now)
    .first<{ id: number; username: string; role: string }>();

  if (!session) {
    return null;
  }

  return {
    id: session.id,
    username: session.username,
    role: session.role === 'admin' ? 'admin' : 'user',
  };
}
