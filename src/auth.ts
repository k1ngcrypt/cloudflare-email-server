import { argon2id } from '@noble/hashes/argon2.js';
import type { Env } from './index';

const TOKEN_COOKIE_NAME = 'session_token';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const ARGON2_VERSION = 19;
const ARGON2_MEMORY_KIB = 19_456;
const ARGON2_ITERATIONS = 2;
const ARGON2_PARALLELISM = 1;
const ARGON2_SALT_BYTES = 16;
const ARGON2_HASH_BYTES = 32;

const LEGACY_SHA256_RE = /^[a-f0-9]{64}$/;

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

interface ParsedArgon2Hash {
  memory: number;
  iterations: number;
  parallelism: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

interface LoginAttemptRow {
  attempt_count: number;
  window_started_at: string;
  blocked_until: string | null;
}

export interface SessionInfo {
  token: string;
  expiresAt: string;
  maxAgeSeconds: number;
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

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function parseArgon2Hash(encoded: string): ParsedArgon2Hash | null {
  const match = /^argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(
    encoded
  );

  if (!match) return null;

  const version = Number.parseInt(match[1], 10);
  const memory = Number.parseInt(match[2], 10);
  const iterations = Number.parseInt(match[3], 10);
  const parallelism = Number.parseInt(match[4], 10);

  if (
    version !== ARGON2_VERSION ||
    Number.isNaN(memory) ||
    Number.isNaN(iterations) ||
    Number.isNaN(parallelism)
  ) {
    return null;
  }

  try {
    return {
      memory,
      iterations,
      parallelism,
      salt: base64ToBytes(match[5]),
      hash: base64ToBytes(match[6]),
    };
  } catch {
    return null;
  }
}

async function legacySha256Hex(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(hashBuffer));
}

async function sessionTokenHash(env: Env, token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token));
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

function toMillis(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function getSessionCookieName(): string {
  return TOKEN_COOKIE_NAME;
}

export function getSessionMaxAgeSeconds(): number {
  return SESSION_MAX_AGE_SECONDS;
}

export function getLoginThrottleKey(request: Request, username: string): string {
  const ip = request.headers.get('CF-Connecting-IP')?.trim() || 'unknown';
  return `${ip}:${username.trim().toLowerCase()}`;
}

export async function hashPassword(password: string): Promise<string> {
  const normalized = password.normalize('NFKC');
  const salt = new Uint8Array(ARGON2_SALT_BYTES);
  crypto.getRandomValues(salt);

  const hash = argon2id(new TextEncoder().encode(normalized), salt, {
    m: ARGON2_MEMORY_KIB,
    t: ARGON2_ITERATIONS,
    p: ARGON2_PARALLELISM,
    dkLen: ARGON2_HASH_BYTES,
    version: ARGON2_VERSION,
  });

  return [
    `argon2id$v=${ARGON2_VERSION}`,
    `m=${ARGON2_MEMORY_KIB},t=${ARGON2_ITERATIONS},p=${ARGON2_PARALLELISM}`,
    bytesToBase64(salt),
    bytesToBase64(hash),
  ].join('$');
}

export async function verifyPasswordAndUpgrade(
  env: Env,
  userId: number,
  password: string,
  storedHash: string
): Promise<boolean> {
  const normalized = password.normalize('NFKC');
  const parsedArgon2 = parseArgon2Hash(storedHash);

  if (parsedArgon2) {
    const derived = argon2id(new TextEncoder().encode(normalized), parsedArgon2.salt, {
      m: parsedArgon2.memory,
      t: parsedArgon2.iterations,
      p: parsedArgon2.parallelism,
      dkLen: parsedArgon2.hash.length,
      version: ARGON2_VERSION,
    });

    return constantTimeEqual(derived, parsedArgon2.hash);
  }

  if (!LEGACY_SHA256_RE.test(storedHash)) {
    return false;
  }

  const legacyHash = await legacySha256Hex(normalized);
  if (legacyHash !== storedHash.toLowerCase()) {
    return false;
  }

  // Seamless migration: successful legacy login upgrades to argon2id.
  const upgradedHash = await hashPassword(normalized);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(upgradedHash, userId)
    .run();

  return true;
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
): Promise<{ id: number; email: string; username: string } | null> {
  const token = extractSessionToken(request);
  if (!token) return null;

  const tokenHash = await sessionTokenHash(env, token);
  const now = new Date().toISOString();

  const session = await env.DB.prepare(
    `
      SELECT users.id, users.email, users.username
      FROM sessions
      JOIN users ON sessions.user_id = users.id
      WHERE sessions.token = ?
        AND sessions.expires_at > ?
    `
  )
    .bind(tokenHash, now)
    .first<{ id: number; email: string; username: string }>();

  return session ?? null;
}

export async function isLoginBlocked(
  env: Env,
  throttleKey: string
): Promise<{ blocked: boolean; retryAfterSeconds: number }> {
  try {
    const row = await env.DB.prepare(
      `
        SELECT attempt_count, window_started_at, blocked_until
        FROM login_attempts
        WHERE throttle_key = ?
      `
    )
      .bind(throttleKey)
      .first<LoginAttemptRow>();

    if (!row) {
      return { blocked: false, retryAfterSeconds: 0 };
    }

    const now = Date.now();
    const blockedUntilMs = toMillis(row.blocked_until);

    if (blockedUntilMs > now) {
      return {
        blocked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((blockedUntilMs - now) / 1000)),
      };
    }

    if (now - toMillis(row.window_started_at) > LOGIN_WINDOW_MS) {
      await env.DB.prepare('DELETE FROM login_attempts WHERE throttle_key = ?')
        .bind(throttleKey)
        .run();
    }

    return { blocked: false, retryAfterSeconds: 0 };
  } catch (err) {
    console.error('Login throttle check failed:', err);
    return { blocked: false, retryAfterSeconds: 0 };
  }
}

export async function recordFailedLoginAttempt(
  env: Env,
  throttleKey: string
): Promise<{ blocked: boolean; retryAfterSeconds: number }> {
  try {
    const row = await env.DB.prepare(
      `
        SELECT attempt_count, window_started_at
        FROM login_attempts
        WHERE throttle_key = ?
      `
    )
      .bind(throttleKey)
      .first<{ attempt_count: number; window_started_at: string }>();

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    if (!row || nowMs - toMillis(row.window_started_at) > LOGIN_WINDOW_MS) {
      await env.DB.prepare(
        `
          INSERT INTO login_attempts (throttle_key, attempt_count, window_started_at, blocked_until, updated_at)
          VALUES (?, 1, ?, NULL, ?)
          ON CONFLICT(throttle_key) DO UPDATE SET
            attempt_count = 1,
            window_started_at = excluded.window_started_at,
            blocked_until = NULL,
            updated_at = excluded.updated_at
        `
      )
        .bind(throttleKey, nowIso, nowIso)
        .run();

      return { blocked: false, retryAfterSeconds: 0 };
    }

    const nextCount = row.attempt_count + 1;
    if (nextCount >= LOGIN_MAX_FAILURES) {
      const blockedUntilIso = new Date(nowMs + LOGIN_BLOCK_MS).toISOString();

      await env.DB.prepare(
        `
          UPDATE login_attempts
          SET attempt_count = ?, blocked_until = ?, updated_at = ?
          WHERE throttle_key = ?
        `
      )
        .bind(nextCount, blockedUntilIso, nowIso, throttleKey)
        .run();

      return {
        blocked: true,
        retryAfterSeconds: Math.max(1, Math.ceil(LOGIN_BLOCK_MS / 1000)),
      };
    }

    await env.DB.prepare(
      `
        UPDATE login_attempts
        SET attempt_count = ?, blocked_until = NULL, updated_at = ?
        WHERE throttle_key = ?
      `
    )
      .bind(nextCount, nowIso, throttleKey)
      .run();

    return { blocked: false, retryAfterSeconds: 0 };
  } catch (err) {
    console.error('Failed to record login attempt:', err);
    return { blocked: false, retryAfterSeconds: 0 };
  }
}

export async function clearLoginAttempts(env: Env, throttleKey: string): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM login_attempts WHERE throttle_key = ?')
      .bind(throttleKey)
      .run();
  } catch (err) {
    console.error('Failed to clear login attempts:', err);
  }
}
