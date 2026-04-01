import type { Env } from './index';
import { getWebmailHtml } from './webmail.ts';
import { authenticate, createSession, hashPassword } from './auth';
import { sendEmail } from './send';

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

    return json(sent);
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

    return json(email);
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
    }>(request);

    if (!body?.to || !body?.subject || !body?.text) {
      return json({ error: 'to, subject, and text are required' }, { status: 400 });
    }

    try {
      await sendEmail(env, {
        from: user.email,
        to: body.to,
        subject: body.subject,
        text: body.text,
        html: body.html,
      });

      await env.DB.prepare(
        `
          INSERT INTO sent_emails (user_id, to_address, subject, body_text, body_html)
          VALUES (?, ?, ?, ?, ?)
        `
      )
        .bind(user.id, body.to, body.subject, body.text, body.html ?? null)
        .run();

      return json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('Send failed:', err);
      return json({ error: message }, { status: 500 });
    }
  }

  return json({ error: 'Not found' }, { status: 404 });
}
