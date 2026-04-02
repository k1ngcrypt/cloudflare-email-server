-- Users table: one row per mailbox account
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Emails table: one row per received message
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

-- Attachment metadata: file bytes are stored in R2 using storage_key
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
);

-- Session tokens
CREATE TABLE IF NOT EXISTS sessions (
  token         TEXT PRIMARY KEY, -- stores HMAC-SHA256(session_token, AUTH_SECRET)
  user_id       INTEGER NOT NULL REFERENCES users(id),
  expires_at    TEXT NOT NULL
);

-- Login attempt throttling (per client IP + username key)
CREATE TABLE IF NOT EXISTS login_attempts (
  throttle_key      TEXT PRIMARY KEY,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  blocked_until     TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_emails_user_folder ON emails(user_id, folder);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_login_attempts_blocked ON login_attempts(blocked_until);
CREATE INDEX IF NOT EXISTS idx_sent_user_time ON sent_emails(user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_attachments_sent ON attachments(sent_email_id);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id);
