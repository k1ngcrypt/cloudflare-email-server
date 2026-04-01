# Engineering Specification: Cloudflare Email Server
## Receive → D1 → Webmail → OCI SMTP Outbound

**Target audience:** AI coding agent  
**Stack:** Cloudflare Email Workers · Cloudflare D1 · Cloudflare Workers (HTTP API + Webmail SPA) · Oracle Cloud Infrastructure Email Delivery (SMTP outbound)  
**Language:** TypeScript throughout  
**Toolchain:** Wrangler v3+

---

## 0. Architecture Overview

```
Internet ──► Cloudflare Email Routing
                   │
                   ▼
         [Email Worker: email() handler]
                   │  postal-mime parses raw MIME
                   ▼
            [D1 Database]
           emails / attachments
           users / sessions
                   │
                   ▼
         [Worker: fetch() HTTP handler]
         REST API + serves static SPA
                   │
                   ▼
           [Webmail SPA]
          (vanilla JS, single HTML file
           bundled and served by the Worker)

Outbound:
 [Webmail compose → POST /api/send]
       │
       ▼
 [Worker fetch() handler]
       │  worker-mailer lib
       │  TCP socket → STARTTLS → port 587
       ▼
 [OCI SMTP endpoint]
       │
       ▼
  Recipient inbox
```

Everything lives in **one Cloudflare Worker** with two exported handlers:
- `email(message, env, ctx)` — triggered by incoming mail
- `fetch(request, env, ctx)` — serves the REST API and the webmail HTML

---

## 1. Project Scaffold

### 1.1 Init

```bash
npm create cloudflare@latest -- cloudflare-webmail
# Choose: "Hello World" TypeScript worker template
cd cloudflare-webmail
npm install postal-mime mimetext worker-mailer
npm install --save-dev wrangler typescript
```

### 1.2 Directory Structure

```
cloudflare-webmail/
├── wrangler.toml
├── src/
│   ├── index.ts          # Main worker entry: exports email + fetch handlers
│   ├── inbound.ts        # email() handler logic
│   ├── api.ts            # REST API router (fetch handler)
│   ├── send.ts           # Outbound SMTP via worker-mailer
│   ├── auth.ts           # Session/token auth helpers
│   ├── db.ts             # D1 query helpers
│   └── webmail.ts        # Returns the static HTML string for the SPA
├── schema.sql            # D1 schema — run once to initialize
└── .dev.vars             # Local secrets (gitignored)
```

---

## 2. wrangler.toml — Exact Syntax

```toml
name = "cloudflare-webmail"
main = "src/index.ts"
compatibility_date = "2025-10-11"
compatibility_flags = ["nodejs_compat"]

[observability]
enabled = true

[[d1_databases]]
binding = "DB"
database_name = "webmail-db"
database_id = "REPLACE_WITH_YOUR_D1_ID"

[vars]
FROM_DOMAIN = "mail.yourdomain.com"
OCI_SMTP_HOST = "smtp.email.us-ashburn-1.oci.oraclecloud.com"
OCI_SMTP_PORT = "587"
```

**Notes:**
- `nodejs_compat` is **required** — `worker-mailer` and `mimetext` depend on Node.js-compat APIs.
- `OCI_SMTP_HOST` varies by region. Find yours in: OCI Console → Developer Services → Email Delivery → Configuration tab → "Public Endpoint".
- `FROM_DOMAIN` is the domain you registered as an Approved Sender in OCI.
- SMTP credentials go into **Wrangler secrets** (never `wrangler.toml`):
  ```bash
  wrangler secret put OCI_SMTP_USER
  wrangler secret put OCI_SMTP_PASS
  wrangler secret put AUTH_SECRET    # random 32-byte hex for signing session tokens
  ```
- For local dev, create `.dev.vars` (gitignored):
  ```
  OCI_SMTP_USER=ocid1.user.oc1..aaaaaaaXXXXX@ocid1.tenancy.oc1..aaaaaaaXXXXX.me.com
  OCI_SMTP_PASS=your-smtp-password
  AUTH_SECRET=a_long_random_hex_string_32_bytes
  ```

### 2.1 Env Interface (TypeScript)

In `src/index.ts`, define the `Env` interface so everything is type-safe:

```typescript
export interface Env {
  DB: D1Database;
  FROM_DOMAIN: string;
  OCI_SMTP_HOST: string;
  OCI_SMTP_PORT: string;
  OCI_SMTP_USER: string;
  OCI_SMTP_PASS: string;
  AUTH_SECRET: string;
}
```

---

## 3. D1 Database Schema

File: `schema.sql`

```sql
-- Users table: one row per mailbox account
CREATE TABLE IF NOT EXISTS users (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  username  TEXT NOT NULL UNIQUE,     -- e.g. "henry"
  email     TEXT NOT NULL UNIQUE,     -- e.g. "henry@yourdomain.com"
  password_hash TEXT NOT NULL,        -- bcrypt or SHA-256 hex (see note)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Emails table: one row per received message
CREATE TABLE IF NOT EXISTS emails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  message_id    TEXT,                 -- from email headers, for threading
  from_address  TEXT NOT NULL,
  from_name     TEXT,
  to_address    TEXT NOT NULL,
  subject       TEXT,
  body_text     TEXT,                 -- plain text part
  body_html     TEXT,                 -- HTML part (may be null)
  raw_size      INTEGER,              -- bytes
  received_at   TEXT NOT NULL DEFAULT (datetime('now')),
  read          INTEGER NOT NULL DEFAULT 0,   -- 0 = unread, 1 = read
  starred       INTEGER NOT NULL DEFAULT 0,
  folder        TEXT NOT NULL DEFAULT 'inbox' -- inbox / sent / trash
);

-- Sent emails table
CREATE TABLE IF NOT EXISTS sent_emails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  to_address    TEXT NOT NULL,
  subject       TEXT,
  body_text     TEXT,
  body_html     TEXT,
  sent_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Session tokens
CREATE TABLE IF NOT EXISTS sessions (
  token         TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  expires_at    TEXT NOT NULL
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_emails_user_folder ON emails(user_id, folder);
CREATE INDEX IF NOT EXISTS idx_emails_received    ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_token     ON sessions(token);
```

**Deploy schema:**
```bash
# Create the D1 database first:
npx wrangler d1 create webmail-db
# Copy the output database_id into wrangler.toml

# Apply schema:
npx wrangler d1 execute webmail-db --file=./schema.sql

# Insert a first user (password "changeme" — SHA-256 hash):
npx wrangler d1 execute webmail-db --command \
  "INSERT INTO users (username, email, password_hash) VALUES ('henry', 'henry@yourdomain.com', '$(echo -n changeme | sha256sum | cut -d\" \" -f1)')"
```

> **Note on passwords:** The Workers runtime does not have `bcrypt`. Use SHA-256 via the Web Crypto API (`crypto.subtle.digest`) or ship a pure-JS bcrypt implementation. For simplicity this spec uses SHA-256; upgrade to argon2 or bcrypt if you add a build step.

---

## 4. Inbound Email Handler

File: `src/inbound.ts`

This is the core of the receive pipeline. It fires whenever an email arrives at your domain that Cloudflare routes to this Worker.

```typescript
import PostalMime from 'postal-mime';
import type { Env } from './index';

export async function handleIncomingEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  // 1. Parse the raw MIME stream
  //    PostalMime.parse() accepts a ReadableStream directly.
  const parsed = await PostalMime.parse(message.raw);

  // 2. Determine which local user this email is for.
  //    message.to is the ENVELOPE TO (reliable), e.g. "henry@yourdomain.com"
  const toAddress = message.to.toLowerCase().trim();

  const user = await env.DB
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(toAddress)
    .first<{ id: number }>();

  if (!user) {
    // No local mailbox — reject cleanly. 
    // This prevents the email from silently disappearing.
    message.setReject(`No mailbox for ${toAddress}`);
    return;
  }

  // 3. Extract body parts
  //    parsed.text — plain text body (may be undefined)
  //    parsed.html — HTML body (may be undefined)
  //    parsed.from — { name, address }
  //    parsed.subject — string
  //    parsed.messageId — string (for threading)
  //    parsed.date — ISO date string

  const bodyText = parsed.text ?? null;
  const bodyHtml = parsed.html ?? null;
  const fromAddr = parsed.from?.address ?? message.from;
  const fromName = parsed.from?.name ?? null;
  const subject  = parsed.subject ?? '(no subject)';
  const msgId    = parsed.messageId ?? null;

  // 4. Insert into D1
  await env.DB
    .prepare(`
      INSERT INTO emails
        (user_id, message_id, from_address, from_name, to_address,
         subject, body_text, body_html, raw_size, folder)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox')
    `)
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

  // 5. Attachments (optional — extend schema to store them if needed)
  //    parsed.attachments is an array of:
  //    { filename, mimeType, content: Uint8Array, contentId, disposition }
  //    For now we log them. To store: upload to R2 and save reference in a
  //    separate "attachments" table linked to the email row.
  if (parsed.attachments.length > 0) {
    console.log(
      `Email ${msgId} has ${parsed.attachments.length} attachment(s) — storage not implemented`
    );
  }
}
```

**Key API facts:**
- `message.raw` — `ReadableStream` of the raw RFC 5322 email. Pass directly to `PostalMime.parse()`.
- `message.from` — envelope FROM (string). Use `parsed.from.address` for the header FROM.
- `message.to` — envelope TO (string). This is the most reliable indicator of which mailbox to deliver to.
- `message.rawSize` — size in bytes.
- `message.setReject(reason)` — rejects the message back to the sender with a bounce. Call this instead of silently ignoring unknown recipients.
- `message.forward(address)` — forwards the raw message to another address. Not used here.

---

## 5. Main Worker Entry Point

File: `src/index.ts`

```typescript
import { handleIncomingEmail } from './inbound';
import { handleRequest }       from './api';

export interface Env {
  DB: D1Database;
  FROM_DOMAIN: string;
  OCI_SMTP_HOST: string;
  OCI_SMTP_PORT: string;
  OCI_SMTP_USER: string;
  OCI_SMTP_PASS: string;
  AUTH_SECRET: string;
}

export default {
  // Triggered by incoming email (Email Routing)
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    await handleIncomingEmail(message, env, ctx);
  },

  // Triggered by HTTP requests (REST API + webmail SPA)
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};
```

---

## 6. REST API Router

File: `src/api.ts`

The fetch handler serves two things: the webmail SPA (a single HTML file) at `GET /` and a JSON REST API under `/api/*`.

```typescript
import type { Env } from './index';
import { getWebmailHtml } from './webmail';
import { authenticate, createSession, hashPassword } from './auth';
import { sendEmail } from './send';

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS headers for SPA fetches
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // Serve webmail SPA
  if (path === '/' || path === '/index.html') {
    return new Response(getWebmailHtml(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // ── API routes ──────────────────────────────────────────────────────────

  // POST /api/login  { username, password } → { token }
  if (path === '/api/login' && method === 'POST') {
    const body = await request.json<{ username: string; password: string }>();
    const hash = await hashPassword(body.password);

    const user = await env.DB
      .prepare('SELECT id, email FROM users WHERE username = ? AND password_hash = ?')
      .bind(body.username, hash)
      .first<{ id: number; email: string }>();

    if (!user) {
      return Response.json({ error: 'Invalid credentials' }, { status: 401, headers: cors });
    }

    const token = await createSession(env, user.id);
    return Response.json({ token, email: user.email }, { headers: cors });
  }

  // All routes below require auth
  const user = await authenticate(request, env);
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  // GET /api/emails?folder=inbox&limit=50&offset=0
  if (path === '/api/emails' && method === 'GET') {
    const folder = url.searchParams.get('folder') ?? 'inbox';
    const limit  = parseInt(url.searchParams.get('limit')  ?? '50');
    const offset = parseInt(url.searchParams.get('offset') ?? '0');

    const rows = await env.DB
      .prepare(`
        SELECT id, from_address, from_name, subject, received_at, read, starred, raw_size
        FROM emails
        WHERE user_id = ? AND folder = ?
        ORDER BY received_at DESC
        LIMIT ? OFFSET ?
      `)
      .bind(user.id, folder, limit, offset)
      .all();

    return Response.json(rows.results, { headers: cors });
  }

  // GET /api/emails/:id
  if (path.startsWith('/api/emails/') && method === 'GET') {
    const emailId = parseInt(path.split('/').pop()!);

    const email = await env.DB
      .prepare('SELECT * FROM emails WHERE id = ? AND user_id = ?')
      .bind(emailId, user.id)
      .first();

    if (!email) {
      return Response.json({ error: 'Not found' }, { status: 404, headers: cors });
    }

    // Mark as read
    await env.DB
      .prepare('UPDATE emails SET read = 1 WHERE id = ?')
      .bind(emailId)
      .run();

    return Response.json(email, { headers: cors });
  }

  // DELETE /api/emails/:id  (move to trash)
  if (path.startsWith('/api/emails/') && method === 'DELETE') {
    const emailId = parseInt(path.split('/').pop()!);
    await env.DB
      .prepare("UPDATE emails SET folder = 'trash' WHERE id = ? AND user_id = ?")
      .bind(emailId, user.id)
      .run();
    return Response.json({ ok: true }, { headers: cors });
  }

  // POST /api/send  { to, subject, text, html? }
  if (path === '/api/send' && method === 'POST') {
    const body = await request.json<{
      to: string;
      subject: string;
      text: string;
      html?: string;
    }>();

    try {
      await sendEmail(env, {
        from: user.email,
        to: body.to,
        subject: body.subject,
        text: body.text,
        html: body.html,
      });

      // Save to sent folder
      await env.DB
        .prepare(`
          INSERT INTO sent_emails (user_id, to_address, subject, body_text, body_html)
          VALUES (?, ?, ?, ?, ?)
        `)
        .bind(user.id, body.to, body.subject, body.text, body.html ?? null)
        .run();

      return Response.json({ ok: true }, { headers: cors });
    } catch (err: any) {
      console.error('Send failed:', err);
      return Response.json({ error: err.message }, { status: 500, headers: cors });
    }
  }

  // GET /api/me  — returns current user info
  if (path === '/api/me' && method === 'GET') {
    return Response.json({ id: user.id, email: user.email, username: user.username }, { headers: cors });
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: cors });
}
```

---

## 7. Auth Helpers

File: `src/auth.ts`

```typescript
import type { Env } from './index';

// SHA-256 password hash using Web Crypto (available in all Workers)
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Generate a secure random token
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Create a session token in D1, valid for 7 days
export async function createSession(env: Env, userId: number): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB
    .prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, expiresAt)
    .run();

  return token;
}

// Validate session token from Authorization header
export async function authenticate(
  request: Request,
  env: Env
): Promise<{ id: number; email: string; username: string } | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);

  const session = await env.DB
    .prepare(`
      SELECT users.id, users.email, users.username
      FROM sessions
      JOIN users ON sessions.user_id = users.id
      WHERE sessions.token = ?
        AND sessions.expires_at > datetime('now')
    `)
    .bind(token)
    .first<{ id: number; email: string; username: string }>();

  return session ?? null;
}
```

---

## 8. Outbound Email via OCI SMTP

File: `src/send.ts`

<br>

**Critical facts about Cloudflare Workers + SMTP:**
- Workers **cannot** connect on port 25 — this is hard-blocked.
- Workers **can** connect on ports 587 (STARTTLS) and 465 (implicit TLS).
- The `worker-mailer` npm package implements a full SMTP client using `cloudflare:sockets` (Cloudflare's TCP socket API). It handles EHLO, AUTH PLAIN, STARTTLS negotiation, and DATA encoding correctly.
- OCI Email Delivery requires STARTTLS on port 587. The SMTP username is your full OCI user OCID string (looks like `ocid1.user.oc1..aaaaaaaXXX@ocid1.tenancy.oc1..aaaaaaaXXX.me.com`).

```typescript
import { WorkerMailer } from 'worker-mailer';
import type { Env } from './index';

interface SendOptions {
  from: string;      // Must be an Approved Sender in your OCI tenancy
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(env: Env, opts: SendOptions): Promise<void> {
  // Connect to OCI SMTP endpoint with STARTTLS on port 587
  const mailer = await WorkerMailer.connect({
    host: env.OCI_SMTP_HOST,           // e.g. "smtp.email.us-ashburn-1.oci.oraclecloud.com"
    port: parseInt(env.OCI_SMTP_PORT), // 587
    secure: false,                     // Do NOT use implicit TLS on connect
    startTls: true,                    // Upgrade to TLS after EHLO (STARTTLS)
    credentials: {
      username: env.OCI_SMTP_USER,     // Full OCI OCID username string
      password: env.OCI_SMTP_PASS,     // SMTP credential password from OCI console
    },
    authType: 'plain',                 // OCI uses AUTH PLAIN
  });

  await mailer.send({
    from: { name: 'Webmail', email: opts.from },
    to:   { email: opts.to },
    subject: opts.subject,
    text: opts.text,
    ...(opts.html ? { html: opts.html } : {}),
  });
}
```

**OCI SMTP endpoint reference by region:**

| Region | SMTP Endpoint |
|--------|--------------|
| us-ashburn-1 | `smtp.email.us-ashburn-1.oci.oraclecloud.com` |
| us-phoenix-1 | `smtp.email.us-phoenix-1.oci.oraclecloud.com` |
| eu-frankfurt-1 | `smtp.email.eu-frankfurt-1.oci.oraclecloud.com` |
| ap-sydney-1 | `smtp.email.ap-sydney-1.oci.oraclecloud.com` |
| ca-toronto-1 | `smtp.email.ca-toronto-1.oci.oraclecloud.com` |

Use the endpoint for whichever region you created your Email Domain and Approved Sender in.

---

## 9. OCI Setup Steps (One-time)

These steps must be done in the OCI Console before any email can be sent:

1. **Create an Email Domain:**  
   OCI Console → Developer Services → Email Delivery → Email Domains → Create  
   Enter your domain (e.g. `yourdomain.com`). This must be a real domain you control.

2. **Configure DKIM:**  
   Inside the Email Domain, go to DKIM tab → Add DKIM.  
   Format the selector as `<prefix>-<regioncode>-<yyyymm>` (e.g. `mail-iad-202503`).  
   OCI will give you a CNAME record to add in Cloudflare DNS.  
   **In Cloudflare DNS: turn the proxy (orange cloud) OFF for this CNAME.** DKIM verification will fail if proxied.

3. **Configure SPF:**  
   Add a TXT record in Cloudflare DNS for your domain:  
   `v=spf1 include:rp.oracleemaildelivery.com ~all`  
   Check the OCI docs for the current region-specific SPF include string.

4. **Create an Approved Sender:**  
   OCI Console → Email Delivery → Approved Senders → Create  
   Enter the exact `From` address your Worker will use (e.g. `henry@yourdomain.com`).  
   The SMTP FROM and the email body From header **must match** and **both must be an Approved Sender**.

5. **Generate SMTP Credentials:**  
   OCI Console → Identity → Users → (your user) → SMTP Credentials → Generate  
   **Copy both the username and password immediately** — you cannot retrieve the password again.  
   The username looks like: `ocid1.user.oc1..aaaaaaaXXXXX@ocid1.tenancy.oc1..aaaaaaaXXXXX.me.com`

6. **Free tier limits:**  
   Always Free: 3,000 emails/month, max 10 emails/minute. More than sufficient for personal use.

---

## 10. Cloudflare Email Routing Setup

These steps configure Cloudflare to route incoming email to your Worker:

1. In Cloudflare Dashboard → your domain → Email → Email Routing → Get Started.
2. Enable Email Routing. Cloudflare will add MX records automatically.
3. Go to the **Email Workers** tab.
4. Set a **Catch-All** rule:  
   Action: "Send to a Worker" → select `cloudflare-webmail`  
   This routes all mail for your domain to your Worker.
5. Alternatively, create per-address rules to only route specific addresses.

---

## 11. Webmail SPA

File: `src/webmail.ts`

The webmail is a single self-contained HTML file returned by the Worker. It uses vanilla JS and no external dependencies. Below is the structure — implement the full version as a template literal.

```typescript
export function getWebmailHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Webmail</title>
  <style>
    /* ── Reset + base ── */
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; display: flex; height: 100vh; overflow: hidden; background: #f3f4f6; }

    /* ── Layout ── */
    #sidebar  { width: 200px; background: #1e293b; color: #e2e8f0; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
    #list     { width: 320px; background: #fff; border-right: 1px solid #e5e7eb; overflow-y: auto; }
    #viewer   { flex: 1; padding: 24px; overflow-y: auto; background: #fff; }
    #compose  { display: none; position: fixed; bottom: 0; right: 24px; width: 480px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px 8px 0 0; box-shadow: 0 -4px 16px rgba(0,0,0,0.1); z-index: 100; }

    /* ── Login screen ── */
    #login    { display: flex; align-items: center; justify-content: center; height: 100vh; width: 100vw; position: fixed; top: 0; left: 0; background: #f3f4f6; z-index: 200; }
    .login-box { background: #fff; padding: 32px; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); width: 320px; display: flex; flex-direction: column; gap: 12px; }

    /* ── Folder nav ── */
    .folder-btn { background: none; border: none; color: #94a3b8; padding: 8px 12px; border-radius: 6px; cursor: pointer; text-align: left; font-size: 14px; }
    .folder-btn.active, .folder-btn:hover { background: #334155; color: #f1f5f9; }

    /* ── Email list item ── */
    .email-row { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; cursor: pointer; }
    .email-row:hover { background: #f8fafc; }
    .email-row.unread .email-from { font-weight: 700; }
    .email-from { font-size: 13px; color: #1e293b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .email-subject { font-size: 12px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .email-date { font-size: 11px; color: #94a3b8; }

    /* ── Viewer ── */
    .viewer-header { border-bottom: 1px solid #e5e7eb; padding-bottom: 16px; margin-bottom: 16px; }
    .viewer-subject { font-size: 20px; font-weight: 600; color: #1e293b; }
    .viewer-meta { font-size: 13px; color: #64748b; margin-top: 4px; }
    .viewer-body { font-size: 14px; color: #374151; line-height: 1.6; white-space: pre-wrap; }

    /* ── Compose ── */
    .compose-header { background: #1e293b; color: #f1f5f9; padding: 10px 14px; border-radius: 8px 8px 0 0; display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
    .compose-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .compose-body input, .compose-body textarea { width: 100%; padding: 8px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; font-family: inherit; }
    .compose-body textarea { min-height: 120px; resize: vertical; }

    /* ── Buttons ── */
    .btn { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-primary:hover { background: #2563eb; }
    .btn-danger  { background: #ef4444; color: #fff; }
    input[type=text], input[type=password] { width: 100%; padding: 10px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; }
  </style>
</head>
<body>

<!-- Login Screen -->
<div id="login">
  <div class="login-box">
    <h2 style="font-size:20px;font-weight:700;color:#1e293b;">Webmail Login</h2>
    <input id="loginUser" type="text" placeholder="Username" />
    <input id="loginPass" type="password" placeholder="Password" />
    <button class="btn btn-primary" onclick="doLogin()">Sign In</button>
    <div id="loginError" style="color:#ef4444;font-size:13px;"></div>
  </div>
</div>

<!-- Main App (hidden until logged in) -->
<div id="app" style="display:none;width:100%;display:none;flex-direction:row;">
  <div id="sidebar">
    <div style="font-weight:700;font-size:16px;margin-bottom:12px;color:#f1f5f9;">✉ Webmail</div>
    <button class="folder-btn active" onclick="loadFolder('inbox', this)">📥 Inbox</button>
    <button class="folder-btn" onclick="loadFolder('sent', this)">📤 Sent</button>
    <button class="folder-btn" onclick="loadFolder('trash', this)">🗑 Trash</button>
    <div style="flex:1;"></div>
    <button class="btn btn-primary" onclick="openCompose()" style="width:100%;">✏ Compose</button>
    <button class="folder-btn" onclick="logout()" style="margin-top:8px;">← Sign Out</button>
  </div>

  <div id="list"><div style="padding:16px;color:#94a3b8;font-size:13px;">Loading...</div></div>

  <div id="viewer"><div style="color:#94a3b8;padding:24px;">Select an email to read it.</div></div>
</div>

<!-- Compose Window -->
<div id="compose">
  <div class="compose-header" onclick="toggleCompose()">
    <span>New Message</span>
    <span id="closeCompose" style="cursor:pointer;">✕</span>
  </div>
  <div class="compose-body">
    <input id="composeTo"      type="text" placeholder="To" />
    <input id="composeSubject" type="text" placeholder="Subject" />
    <textarea id="composeBody" placeholder="Write your message..."></textarea>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-primary" onclick="doSend()">Send</button>
      <div id="sendStatus" style="font-size:12px;color:#64748b;align-self:center;"></div>
    </div>
  </div>
</div>

<script>
  let TOKEN = localStorage.getItem('webmail_token') || '';
  let currentFolder = 'inbox';

  // ── Auth ─────────────────────────────────────────────────────────────────

  async function doLogin() {
    const user = document.getElementById('loginUser').value;
    const pass = document.getElementById('loginPass').value;
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById('loginError').textContent = data.error;
      return;
    }
    TOKEN = data.token;
    localStorage.setItem('webmail_token', TOKEN);
    showApp();
  }

  function logout() {
    TOKEN = '';
    localStorage.removeItem('webmail_token');
    document.getElementById('login').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  }

  function showApp() {
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    loadFolder('inbox');
  }

  if (TOKEN) showApp();

  // ── Email List ────────────────────────────────────────────────────────────

  async function loadFolder(folder, btn) {
    currentFolder = folder;
    document.querySelectorAll('.folder-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    const endpoint = folder === 'sent' ? '/api/sent' : \`/api/emails?folder=\${folder}\`;
    const res = await apiFetch(endpoint);
    const emails = await res.json();
    renderList(emails);
  }

  function renderList(emails) {
    const list = document.getElementById('list');
    if (!emails.length) {
      list.innerHTML = '<div style="padding:16px;color:#94a3b8;font-size:13px;">No emails here.</div>';
      return;
    }
    list.innerHTML = emails.map(e => \`
      <div class="email-row \${e.read ? '' : 'unread'}" onclick="loadEmail(\${e.id})">
        <div class="email-from">\${esc(e.from_name || e.from_address)}</div>
        <div class="email-subject">\${esc(e.subject || '(no subject)')}</div>
        <div class="email-date">\${new Date(e.received_at || e.sent_at).toLocaleString()}</div>
      </div>
    \`).join('');
  }

  // ── Email Viewer ──────────────────────────────────────────────────────────

  async function loadEmail(id) {
    const res = await apiFetch(\`/api/emails/\${id}\`);
    const email = await res.json();

    document.getElementById('viewer').innerHTML = \`
      <div class="viewer-header">
        <div class="viewer-subject">\${esc(email.subject || '(no subject)')}</div>
        <div class="viewer-meta">
          From: \${esc(email.from_name ? email.from_name + ' <' + email.from_address + '>' : email.from_address)}<br>
          To: \${esc(email.to_address)}<br>
          Date: \${new Date(email.received_at).toLocaleString()}
        </div>
        <div style="margin-top:8px;display:flex;gap:8px;">
          <button class="btn btn-primary" onclick="replyTo('\${esc(email.from_address)}', '\${esc(email.subject)}')">↩ Reply</button>
          <button class="btn btn-danger"  onclick="deleteEmail(\${email.id})">🗑 Delete</button>
        </div>
      </div>
      <div class="viewer-body">\${email.body_html
        ? '<iframe srcdoc="' + email.body_html.replace(/"/g, '&quot;') + '" style="width:100%;min-height:400px;border:none;"></iframe>'
        : esc(email.body_text || '(empty)')
      }</div>
    \`;

    // Mark as read in the list
    document.querySelectorAll('.email-row').forEach(r => {
      if (r.getAttribute('onclick')?.includes(\`loadEmail(\${email.id})\`)) {
        r.classList.remove('unread');
      }
    });
  }

  async function deleteEmail(id) {
    await apiFetch(\`/api/emails/\${id}\`, 'DELETE');
    loadFolder(currentFolder);
    document.getElementById('viewer').innerHTML = '<div style="color:#94a3b8;padding:24px;">Email deleted.</div>';
  }

  // ── Compose ───────────────────────────────────────────────────────────────

  function openCompose() {
    document.getElementById('compose').style.display = 'block';
  }

  function toggleCompose() {
    const c = document.getElementById('compose');
    c.style.display = c.style.display === 'none' ? 'block' : 'none';
  }

  function replyTo(addr, subject) {
    document.getElementById('composeTo').value = addr;
    document.getElementById('composeSubject').value = 'Re: ' + subject.replace(/^Re: /i, '');
    openCompose();
  }

  async function doSend() {
    const to      = document.getElementById('composeTo').value;
    const subject = document.getElementById('composeSubject').value;
    const text    = document.getElementById('composeBody').value;
    const status  = document.getElementById('sendStatus');

    status.textContent = 'Sending...';

    const res = await apiFetch('/api/send', 'POST', { to, subject, text });
    if (res.ok) {
      status.textContent = 'Sent!';
      document.getElementById('composeTo').value      = '';
      document.getElementById('composeSubject').value = '';
      document.getElementById('composeBody').value    = '';
      setTimeout(() => { document.getElementById('compose').style.display = 'none'; }, 1500);
    } else {
      const data = await res.json();
      status.textContent = 'Error: ' + data.error;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function apiFetch(path, method = 'GET', body = null) {
    return fetch(path, {
      method,
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
</script>
</body>
</html>`;
}
```

---

## 12. Local Development

```bash
# Start the dev server
npx wrangler dev

# Test the email handler by POSTing a raw email to the local endpoint:
curl --request POST 'http://localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=sender@example.com' \
  --url-query 'to=henry@yourdomain.com' \
  --header 'Content-Type: message/rfc822' \
  --data-raw $'From: Test Sender <sender@example.com>\r\nTo: henry@yourdomain.com\r\nSubject: Hello from curl\r\n\r\nThis is the email body.\r\n'

# Test the REST API:
curl -X POST http://localhost:8787/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"henry","password":"changeme"}'
# → { "token": "abc123...", "email": "henry@yourdomain.com" }

TOKEN="abc123..."
curl http://localhost:8787/api/emails?folder=inbox \
  -H "Authorization: Bearer $TOKEN"
```

Wrangler will also expose `http://localhost:8787/` where you can open the webmail SPA in your browser.

---

## 13. Deploy

```bash
# Set secrets (one-time)
npx wrangler secret put OCI_SMTP_USER
npx wrangler secret put OCI_SMTP_PASS
npx wrangler secret put AUTH_SECRET

# Deploy
npx wrangler deploy

# Tail live logs
npx wrangler tail
```

After deploy, go to Cloudflare Dashboard → Email → Email Routing → Email Workers tab and attach the Worker to your domain's catch-all rule if not already done via the dashboard.

---

## 14. Known Constraints & Gotchas

| Constraint | Detail |
|---|---|
| Port 25 blocked | Cloudflare Workers cannot connect outbound on port 25. Always use port 587 (STARTTLS) or 465 (implicit TLS) for OCI. |
| OCI free tier limits | 3,000 emails/month, 10 emails/minute. Trial accounts get only 200/day. |
| SMTP FROM must match header From | OCI rejects mail where the SMTP envelope FROM ≠ body From header, unless both are Approved Senders. |
| DKIM CNAME in Cloudflare | Must have Proxy Status = DNS Only (grey cloud). Orange cloud breaks DKIM verification. |
| D1 free tier | 5 GB storage, 25 million reads/day, 50,000 writes/day. More than sufficient. |
| Worker CPU time (free) | 10ms CPU per request. Reading email and writing to D1 is fast; sending SMTP is the heavy operation — use `ctx.waitUntil()` if needed to avoid blocking the response. |
| HTML email in viewer | Render HTML emails in a sandboxed `<iframe srcdoc="...">` to prevent XSS. Never `innerHTML` raw HTML email bodies. |
| `nodejs_compat` required | `worker-mailer` uses `cloudflare:sockets`. `mimetext` uses some Node.js APIs. Both require `compatibility_flags = ["nodejs_compat"]` in wrangler.toml. |
| Attachments not stored | This spec omits attachment storage. To add it: store binaries in Cloudflare R2, save references in a `attachments` D1 table linked to `emails.id`. |

---

## 15. Extension Points

Once the base is working, these are natural next steps:

- **Multi-user management API:** `POST /api/users` to create mailboxes without editing SQL directly.
- **Attachment storage:** Add R2 bucket binding, upload `parsed.attachments` to R2, save URL in D1.
- **Pagination:** The email list API already supports `limit` and `offset` — wire these up in the SPA.
- **Unread count badge:** `SELECT COUNT(*) FROM emails WHERE user_id=? AND read=0 AND folder='inbox'` — add to `/api/me`.
- **Search:** D1 supports `LIKE` queries. Add `GET /api/emails/search?q=term`.
- **DMARC enforcement:** Cloudflare started requiring SPF or DKIM on inbound mail as of July 2025. Senders without authentication will be rejected upstream before your Worker sees them.
