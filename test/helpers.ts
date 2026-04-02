import { SELF, env } from 'cloudflare:test';
import type { Env } from '../src/index';

const BASE_URL = 'https://webmail.test';
const SCHEMA_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS emails (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      message_id    TEXT,
      from_address  TEXT NOT NULL,
      from_name     TEXT,
      to_address    TEXT NOT NULL,
      subject       TEXT,
      body_text     TEXT,
      body_html     TEXT,
      raw_size      INTEGER,
      received_at   TEXT NOT NULL DEFAULT (datetime('now')),
      read          INTEGER NOT NULL DEFAULT 0,
      starred       INTEGER NOT NULL DEFAULT 0,
      folder        TEXT NOT NULL DEFAULT 'inbox'
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS sent_emails (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      to_address    TEXT NOT NULL,
      subject       TEXT,
      body_text     TEXT,
      body_html     TEXT,
      sent_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS attachments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      email_id      INTEGER REFERENCES emails(id) ON DELETE CASCADE,
      sent_email_id INTEGER REFERENCES sent_emails(id) ON DELETE CASCADE,
      storage_key   TEXT NOT NULL UNIQUE,
      filename      TEXT NOT NULL,
      mime_type     TEXT,
      size_bytes    INTEGER NOT NULL,
      content_id    TEXT,
      disposition   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      expires_at  TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS login_attempts (
      throttle_key      TEXT PRIMARY KEY,
      attempt_count     INTEGER NOT NULL DEFAULT 0,
      window_started_at TEXT NOT NULL,
      blocked_until     TEXT,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_emails_user_folder ON emails(user_id, folder)',
  'CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)',
  'CREATE INDEX IF NOT EXISTS idx_login_attempts_blocked ON login_attempts(blocked_until)',
  'CREATE INDEX IF NOT EXISTS idx_sent_user_time ON sent_emails(user_id, sent_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(email_id)',
  'CREATE INDEX IF NOT EXISTS idx_attachments_sent ON attachments(sent_email_id)',
  'CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id)',
];

const RESET_STATEMENTS = [
  'DELETE FROM attachments',
  'DELETE FROM sent_emails',
  'DELETE FROM emails',
  'DELETE FROM sessions',
  'DELETE FROM login_attempts',
  'DELETE FROM users',
  "DELETE FROM sqlite_sequence WHERE name IN ('attachments', 'sent_emails', 'emails', 'users')",
];

export interface SeededUser {
  id: number;
  username: string;
  email: string;
  password: string;
}

export interface AuthSession extends SeededUser {
  token: string;
  cookie: string;
}

export function getBindings(): Env {
  return env as unknown as Env;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function resetState(): Promise<void> {
  const bindings = getBindings();

  for (const statement of SCHEMA_STATEMENTS) {
    await bindings.DB.prepare(statement).run();
  }

  for (const statement of RESET_STATEMENTS) {
    await bindings.DB.prepare(statement).run();
  }
}

export async function seedLegacyUser(
  input: Partial<Pick<SeededUser, 'username' | 'email' | 'password'>> = {}
): Promise<SeededUser> {
  const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const username = input.username ?? `user_${nonce}`;
  const email = input.email ?? `${username}@mail.example.test`;
  const password = input.password ?? 'correct horse battery staple';
  const passwordHash = await sha256Hex(password);

  const row = await getBindings()
    .DB.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?) RETURNING id')
    .bind(username, email, passwordHash)
    .first<{ id: number }>();

  if (!row) {
    throw new Error('Failed to seed test user');
  }

  return {
    id: row.id,
    username,
    email,
    password,
  };
}

export async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(new Request(`${BASE_URL}${path}`, init));
}

export function extractSessionCookie(response: Response): string | null {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) {
    return null;
  }

  return setCookie.split(';', 1)[0] ?? null;
}

export async function login(
  username: string,
  password: string,
  headers: HeadersInit = {}
): Promise<{
  response: Response;
  body: Record<string, unknown>;
  cookie: string | null;
}> {
  const response = await apiRequest('/api/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ username, password }),
  });

  const body = (await response.json()) as Record<string, unknown>;

  return {
    response,
    body,
    cookie: extractSessionCookie(response),
  };
}

export async function createAuthenticatedSession(
  input: Partial<Pick<SeededUser, 'username' | 'email' | 'password'>> = {}
): Promise<AuthSession> {
  const user = await seedLegacyUser(input);
  const loginResult = await login(user.username, user.password);

  if (!loginResult.response.ok) {
    throw new Error(`Failed to create authenticated session: HTTP ${loginResult.response.status}`);
  }

  const token = loginResult.body.token;
  if (typeof token !== 'string') {
    throw new Error('Login response missing token');
  }

  if (!loginResult.cookie) {
    throw new Error('Login response missing session cookie');
  }

  return {
    ...user,
    token,
    cookie: loginResult.cookie,
  };
}
