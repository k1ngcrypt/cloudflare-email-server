import type { Env } from './index';

export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function createSession(env: Env, userId: number): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, expiresAt)
    .run();

  return token;
}

export async function authenticate(
  request: Request,
  env: Env
): Promise<{ id: number; email: string; username: string } | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
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
    .bind(token, now)
    .first<{ id: number; email: string; username: string }>();

  return session ?? null;
}
